import * as fs from 'node:fs';

import type { TestCase, TestResult } from '@playwright/test/reporter';

import type { ResolvedReporterConfig } from '../config/resolve-config.js';
import {
  MAX_LABELS_PER_CASE,
  MAX_LINKS_PER_CASE,
  MAX_TAGS_PER_CASE,
  MAX_TAG_LENGTH,
  RESERVED_MESSAGE_MEDIA_TYPE,
} from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import { logger } from '../shared/logger.js';
import type { Attachment, Case, CaseStatus, Label, Link, Parameter, Step } from '../shared/types.js';
import type { RuntimeMessage } from '../runtime/message-types.js';
import type { Attachment as WireAttachment } from '../shared/types.js';
import { mapSteps } from './step-mapper.js';

/**
 * Maps Playwright's 5 result statuses onto the wire contract's vocabulary.
 *
 * `qualflare-cli` accepts exactly 7 values and turns anything it does not
 * recognize into `error` — NOT into a pass — so every Playwright status is
 * mapped explicitly here rather than passed through and hoped for.
 */
function mapStatus(status: TestResult['status']): CaseStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timeout';
    case 'interrupted':
      return 'aborted';
    case 'skipped':
      return 'skipped';
    default:
      return 'error';
  }
}

// Matches ANSI SGR escapes. Written as a unicode escape rather than a literal
// control character, so this source stays copy-pasteable and greppable.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Playwright's TestError carries `message` for thrown Errors and `value` for
 * non-Error throws (`throw 'boom'`). `snippet` is the rendered code frame
 * with the failing line highlighted — genuinely the most useful part of a
 * Playwright failure, and something the built-in JSON reporter flattens — but
 * it arrives ANSI-colored, which would render as escape soup in a web UI.
 */
function formatError(result: TestResult): string | undefined {
  const err = result.error;
  if (!err) {
    return undefined;
  }
  const head = err.message ?? err.value ?? 'test failed';
  const parts = [stripAnsi(head)];
  if (err.snippet) {
    parts.push('', stripAnsi(err.snippet));
  }
  if (err.stack && !head.includes(err.stack)) {
    parts.push('', stripAnsi(err.stack));
  }
  return parts.join('\n');
}

interface ReplayedMetadata {
  labels: Label[];
  links: Link[];
  tags: string[];
  description?: string;
  priority?: Case['priority'];
  caseParameters: Parameter[];
  stepParameters: Map<string, Parameter[]>;
  attachments: Attachment[];
}

/**
 * Replays the `qualflare.*()` calls a test made, which reach the reporter as
 * attachments under a reserved content type (see runtime/qualflare-api.ts).
 *
 * `parameter()` placement follows the rule shared with the sibling packages:
 * inside an open `step()` it belongs to that step, outside any step it
 * belongs to the case's properties. The step_start/step_stop pair exists only
 * to establish that bracket — the step ITSELF is already captured natively,
 * because `qualflare.step()` delegates to `test.step()`, so synthesizing a
 * second step from these messages would double-report every manual step.
 */
function replayMetadata(result: TestResult): ReplayedMetadata {
  const meta: ReplayedMetadata = {
    labels: [],
    links: [],
    tags: [],
    caseParameters: [],
    stepParameters: new Map(),
    attachments: [],
  };
  const openSteps: string[] = [];

  for (const a of result.attachments) {
    if (a.contentType !== RESERVED_MESSAGE_MEDIA_TYPE || !a.body) {
      continue;
    }
    let message: RuntimeMessage;
    try {
      message = JSON.parse(a.body.toString('utf8')) as RuntimeMessage;
    } catch {
      logger.warn('ignoring an unparseable qualflare runtime message.');
      continue;
    }

    switch (message.type) {
      case 'label':
        meta.labels.push({ name: message.name, value: message.value });
        break;
      case 'link':
        meta.links.push({
          type: message.linkType ?? 'custom',
          ...(message.name ? { name: message.name } : {}),
          url: message.url,
        });
        break;
      case 'tag':
        meta.tags.push(...message.tags);
        break;
      case 'description':
        meta.description = message.text;
        break;
      case 'priority':
        meta.priority = message.value;
        break;
      case 'parameter': {
        const param: Parameter = {
          name: message.name,
          ...(message.value !== undefined ? { value: message.value } : {}),
          ...(message.masked ? { masked: true } : {}),
        };
        const openStep = openSteps[openSteps.length - 1];
        if (openStep === undefined) {
          meta.caseParameters.push(param);
        } else {
          const existing = meta.stepParameters.get(openStep) ?? [];
          existing.push(param);
          meta.stepParameters.set(openStep, existing);
        }
        break;
      }
      case 'attachment':
        meta.attachments.push({
          name: message.name,
          ...(message.mimeType ? { mimeType: message.mimeType } : {}),
          content: message.contentBase64,
        });
        break;
      case 'attachment_from_file':
        meta.attachments.push(...readFileAttachment(message.name, message.path, message.mimeType));
        break;
      case 'step_start':
        openSteps.push(message.name);
        break;
      case 'step_stop':
        openSteps.pop();
        break;
    }
  }

  return meta;
}

function readFileAttachment(name: string, path: string, mimeType?: string): Attachment[] {
  try {
    const bytes = fs.readFileSync(path);
    return [
      {
        name,
        ...(mimeType ? { mimeType } : {}),
        content: bytes.toString('base64'),
        fileSize: bytes.byteLength,
      },
    ];
  } catch (err) {
    logger.warn(`skipping attachment "${name}": could not read ${path}: ${(err as Error).message}`);
    return [];
  }
}

/** Truncates and caps tags to the server's limits, so a runaway loop in a
 * test can't get a whole launch rejected at validation. */
function capTags(tags: string[]): string[] {
  const unique = [...new Set(tags.map((t) => t.slice(0, MAX_TAG_LENGTH)))];
  return unique.slice(0, MAX_TAGS_PER_CASE);
}

/**
 * Builds one wire `Case` from a Playwright test and all of its attempts.
 *
 * Called from `onEnd`, never `onTestEnd`: `test.outcome()` is only meaningful
 * once every retry has finished, so asking mid-flight would report a
 * to-be-retried failure as a plain failure and never mark anything flaky.
 */
export function buildCase(
  test: TestCase,
  config: ResolvedReporterConfig,
  /** Attachments already resolved in onTestEnd, keyed `${test.id}:${retry}`.
   * Resolution cannot be deferred to onEnd: `use.preserveOutput` and a
   * passing retry both delete a previous attempt's output directory, so by
   * onEnd the screenshot/video files may no longer exist. */
  attachmentsByResult: ReadonlyMap<string, WireAttachment[]>,
): Case | undefined {
  // workerIndex === -1 means the test never actually ran (the run was
  // interrupted before it started); there is no result worth reporting.
  const results = test.results.filter((r) => r.workerIndex !== -1);
  if (results.length === 0) {
    return undefined;
  }

  const final = results[results.length - 1]!;
  const outcome = test.outcome();

  // A `test.fail()` test that failed is a PASS: the author declared the
  // failure expected, and Playwright reports that as outcome 'expected'. The
  // error text is kept so the report still shows what actually happened.
  const expectedFailure = outcome === 'expected' && final.status === 'failed';
  const status: CaseStatus = expectedFailure ? 'passed' : mapStatus(final.status);

  const meta = replayMetadata(final);
  const steps: Step[] = mapSteps(final.steps, config.includeApiSteps);

  // Attach parameters recorded between a step_start/step_stop bracket to the
  // matching native step. Matched by title, last occurrence wins — a repeated
  // step title is rare, and mis-attributing a parameter is a much smaller
  // problem than dropping it.
  for (const [stepName, params] of meta.stepParameters) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]!.name === stepName) {
        steps[i]!.parameters = [...(steps[i]!.parameters ?? []), ...params];
        break;
      }
    }
  }

  const projectName = test.parent.project()?.name;
  const properties: Record<string, string> = {
    file: test.location.file,
    ...(projectName ? { project: projectName } : {}),
  };
  for (const p of meta.caseParameters) {
    properties[p.name] = p.value ?? '';
  }

  const attachments = [...(attachmentsByResult.get(`${test.id}:${final.retry}`) ?? []), ...meta.attachments];

  // Playwright's own tags (@-tokens in titles, plus describe/test `tag`
  // options) merged with anything qualflare.tag() added.
  const tags = capTags([...test.tags, ...meta.tags]);
  const error = formatError(final);

  return {
    id: test.id,
    name: test.title,
    className: test.location.file,
    status,
    duration: msToNs(final.duration),
    retryCount: results.length - 1,
    isFlaky: outcome === 'flaky',
    ...(error ? { error } : {}),
    ...(meta.priority ? { priority: meta.priority } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    properties,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(meta.labels.length > 0 ? { labels: meta.labels.slice(0, MAX_LABELS_PER_CASE) } : {}),
    ...(meta.links.length > 0 ? { links: meta.links.slice(0, MAX_LINKS_PER_CASE) } : {}),
    startedAt: final.startTime.toISOString(),
  };
}
