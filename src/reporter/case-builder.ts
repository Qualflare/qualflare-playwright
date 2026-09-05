import * as fs from 'node:fs';

import type { TestCase, TestResult } from '@playwright/test/reporter';

import type { ResolvedReporterConfig } from '../config/resolve-config.js';
import {
  MAX_ATTEMPTS_PER_CASE,
  MAX_ATTEMPT_MESSAGE_RUNES,
  MAX_ATTEMPT_OUTPUT_LINES,
  MAX_ATTEMPT_OUTPUT_RUNES,
  MAX_ATTEMPT_SNIPPET_RUNES,
  MAX_ATTEMPT_TRACE_RUNES,
  MAX_LABELS_PER_CASE,
  MAX_LINKS_PER_CASE,
  MAX_TAGS_PER_CASE,
  MAX_TAG_LENGTH,
  RESERVED_MESSAGE_MEDIA_TYPE,
} from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import { clampOutputLines, truncateRunes } from '../shared/text.js';
import { logger } from '../shared/logger.js';
import type { Attachment, Attempt, Case, CaseStatus, Label, Link, Parameter, Step } from '../shared/types.js';
import type { RuntimeMessage } from '../runtime/message-types.js';
import { AttachmentBudget, inlineFromBuffer, inlineFromFile } from './attachment-reader.js';
import { copyImageAttachment, isOffloadableImage, writeImageAttachment } from './video-writer.js';
import { mapSteps } from './step-mapper.js';
import { buildParameter, propertyValue } from '../shared/parameters.js';

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
// eslint-disable-next-line no-control-regex -- matching ANSI escapes requires the escape byte itself
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

/**
 * Captured process output as the wire wants it: one array entry per line.
 *
 * Playwright hands back `(string | Buffer)[]` where each entry is whatever
 * chunk the stream happened to flush, so a single entry may hold many lines or
 * a partial one. Splitting on newlines here means the server's 200-LINE cap
 * counts real lines rather than arbitrary flush boundaries.
 */
function outputLines(chunks: ReadonlyArray<string | Buffer> | undefined): string[] | undefined {
  if (!chunks || chunks.length === 0) {
    return undefined;
  }
  const text = chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
  const lines = stripAnsi(text).split('\n');
  // A trailing newline yields a final empty element that is not a real line.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  // Bounded to what the server actually stores. Playwright captures everything
  // a test prints, so this is the field that makes an attempt unboundedly large.
  return clampOutputLines(lines, MAX_ATTEMPT_OUTPUT_LINES, MAX_ATTEMPT_OUTPUT_RUNES);
}

/**
 * Builds the per-attempt history for one test, or `undefined` when there is
 * nothing worth sending.
 *
 * # Why every attempt is sent, including the last
 *
 * The server treats the highest-numbered attempt as the final execution and
 * overwrites its `status`/`duration` from the Case itself, so a client cannot
 * make the case row and its final attempt row disagree. It keeps that
 * attempt's own `message`/`trace` though — which is exactly why the final
 * attempt has to be sent rather than left to be inferred.
 *
 * # Why a single attempt sends nothing
 *
 * A test that ran once has no history: the Case already carries that status,
 * duration and error. The server discards a one-element array, so sending it
 * would be payload spent against the 10MB body limit on a row that is dropped.
 *
 * # Why the error is split rather than reused
 *
 * `formatError` flattens message + snippet + stack into the Case's single
 * `error` string, because that is all the Case has room for. An Attempt has
 * separate `message`/`trace`/`snippet`/`line` fields, so they are mapped
 * individually — the attempt history is strictly richer than a per-attempt
 * copy of `error` would be.
 */
export function buildAttempts(results: readonly TestResult[]): Attempt[] | undefined {
  if (results.length < 2) {
    return undefined;
  }

  // Beyond the server's cap it keeps the first 49 and the final one, dropping
  // the middle. Doing the same here means the bytes are never sent at all,
  // and — crucially — that the FINAL attempt survives the trim, which a plain
  // `slice(0, 50)` would discard.
  let kept: readonly TestResult[] = results;
  if (results.length > MAX_ATTEMPTS_PER_CASE) {
    kept = [...results.slice(0, MAX_ATTEMPTS_PER_CASE - 1), results[results.length - 1]!];
  }

  return kept.map((r, i) => {
    const err = r.error;
    const attempt: Attempt = {
      // 1-based and contiguous. Deliberately the index rather than
      // `r.retry`: results are already ordered by attempt, and a filtered-out
      // never-ran result would leave a hole in the retry numbering that the
      // server reads as a truncated history.
      attempt: i + 1,
      status: mapStatus(r.status),
      duration: msToNs(r.duration),
      startedAt: r.startTime.toISOString(),
    };

    if (err) {
      const message = err.message ?? err.value;
      if (message) {
        attempt.message = truncateRunes(stripAnsi(message), MAX_ATTEMPT_MESSAGE_RUNES);
      }
      if (err.stack) {
        attempt.trace = truncateRunes(stripAnsi(err.stack), MAX_ATTEMPT_TRACE_RUNES);
      }
      if (err.snippet) {
        attempt.snippet = truncateRunes(stripAnsi(err.snippet), MAX_ATTEMPT_SNIPPET_RUNES);
      }
      if (typeof err.location?.line === 'number') {
        attempt.line = err.location.line;
      }
    }

    const stdout = outputLines(r.stdout);
    if (stdout) {
      attempt.stdout = stdout;
    }
    const stderr = outputLines(r.stderr);
    if (stderr) {
      attempt.stderr = stderr;
    }

    return attempt;
  });
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
function replayMetadata(
  result: TestResult,
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): ReplayedMetadata {
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
        const param: Parameter = buildParameter(message.name, message.value, message.masked);
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
      case 'attachment': {
        // Decoded back to bytes rather than trusting the base64 length, so the
        // cap is applied to the real payload size the server will receive.
        const bytes = Buffer.from(message.contentBase64, 'base64');
        // An image written by qualflare.attachment() goes out of band like any
        // other screenshot. Leaving it inline would make the metadata API the
        // one remaining source of base64 image bytes in the report, which is
        // exactly what this removes.
        if (isOffloadableImage(message.mimeType)) {
          const written = writeImageAttachment(
            bytes,
            message.mimeType,
            config.outputDir,
            config.maxAttachmentBytes,
          );
          if (written) {
            meta.attachments.push({
              name: message.name,
              mimeType: written.mimeType,
              localImagePath: written.localImagePath,
              fileSize: written.fileSize,
            });
            break;
          }
          // Fall through to inline rather than dropping it: an unwritable
          // outputDir should cost the offload, not the user's attachment.
        }
        const inlined = inlineFromBuffer(message.name, bytes, message.mimeType, config, budget);
        if (inlined) {
          meta.attachments.push(inlined);
        }
        break;
      }
      case 'attachment_from_file': {
        const copied = copyImageAttachment(message.path, config.outputDir, config.maxAttachmentBytes);
        if (copied) {
          meta.attachments.push({
            name: message.name,
            mimeType: copied.mimeType,
            localImagePath: copied.localImagePath,
            fileSize: copied.fileSize,
          });
          break;
        }
        const fromFile = inlineFromFile(message.name, message.path, message.mimeType, config, budget);
        if (fromFile) {
          meta.attachments.push(fromFile);
        }
        break;
      }
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
  attachmentsByResult: ReadonlyMap<string, Attachment[]>,
  /** The run-wide inline budget. Needed here because the metadata API's own
   * attachments (`qualflare.attachment()` / `attachmentFromFile()`) are
   * resolved at case-build time, and they must draw on the SAME budget as
   * Playwright's attachments — an uncapped path can push the request past
   * `/collect`'s 10MB body limit and lose the entire launch. */
  budget: AttachmentBudget,
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

  const meta = replayMetadata(final, config, budget);
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
    properties[p.name] = propertyValue(p.value, p.masked);
  }

  const attachments = [...(attachmentsByResult.get(`${test.id}:${final.retry}`) ?? []), ...meta.attachments];

  // Playwright's own tags (@-tokens in titles, plus describe/test `tag`
  // options) merged with anything qualflare.tag() added.
  //
  // Read defensively because `TestCase.tags` only exists from Playwright
  // 1.42; on 1.40/1.41 it is undefined and spreading it would throw. Rather
  // than raise the peer floor and hard-block those users, they simply get no
  // native tags — a concept their Playwright does not have anyway — while
  // qualflare.tag() keeps working. Verified against 1.40.0's shipped types.
  const nativeTags = (test as { tags?: string[] }).tags ?? [];
  const tags = capTags([...nativeTags, ...meta.tags]);
  const error = formatError(final);
  const attempts = buildAttempts(results);

  return {
    id: test.id,
    name: test.title,
    className: test.location.file,
    status,
    duration: msToNs(final.duration),
    retryCount: results.length - 1,
    isFlaky: outcome === 'flaky',
    ...(attempts ? { attempts } : {}),
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
