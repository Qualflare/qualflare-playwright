import * as fs from 'node:fs';

import type { TestResult } from '@playwright/test/reporter';

import { MAX_ATTACHMENTS_PER_CASE, RESERVED_MESSAGE_MEDIA_TYPE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';
import type { ResolvedReporterConfig } from '../config/resolve-config.js';
import { copyVideoAttachment } from './video-writer.js';

/** Running total of inline attachment bytes for one reporter process, so a
 * single pathological run can't push a launch past the server's body limit.
 * Identical to the class both sibling packages use. */
export class AttachmentBudget {
  private used = 0;

  constructor(private readonly maxTotalBytes: number) {}

  tryReserve(bytes: number): boolean {
    if (this.used + bytes > this.maxTotalBytes) {
      return false;
    }
    this.used += bytes;
    return true;
  }

  /** Returns bytes to the budget when the attachment they were reserved for
   * turns out to be discarded — a retried test's superseded attempt. Without
   * this, a flaky test consumes budget twice and a LATER test silently loses
   * its screenshot to an attachment nobody will ever see. */
  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }

  get usedBytes(): number {
    return this.used;
  }
}

/** Playwright's own auto-attachment names (`use.video`/`use.screenshot`/
 * `use.trace` produce exactly these). */
const NAME_VIDEO = 'video';
const NAME_TRACE = 'trace';

function isVideo(a: TestResult['attachments'][number]): boolean {
  return a.name === NAME_VIDEO || (a.contentType?.startsWith('video/') ?? false);
}

/**
 * Resolves one test attempt's Playwright attachments into wire `Attachment`s.
 *
 * Three routes, and which one an attachment takes is decided entirely by what
 * the CLI and server can actually do with it:
 *
 *  - **video** -> copied into `outputDir`, referenced by `localVideoPath`.
 *    This is the ONLY path `qualflare-cli` uploads to blob storage.
 *  - **everything else with bytes** -> inlined as base64 `content`, subject to
 *    the per-attachment and per-run budgets.
 *  - **trace** -> dropped, deliberately. Traces are `application/zip`, which
 *    the upload endpoint's MIME allowlist rejects, and they are far too large
 *    to inline. Attaching one would produce a row pointing at nothing. See
 *    docs/LIMITATIONS.md.
 *
 * A bare `path` is never emitted on its own: the server treats `path` as
 * informational and never fetches it, so a path-only attachment is a row the
 * user can see but never open. Dropping is more honest than that.
 */
export function resolveAttachments(
  result: TestResult,
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): Attachment[] {
  if (!config.attachScreenshots) {
    return [];
  }

  const out: Attachment[] = [];
  let capWarned = false;

  for (const a of result.attachments) {
    // Runtime messages from the metadata API travel as attachments; they are
    // consumed by the reporter, never reported as one.
    if (a.contentType === RESERVED_MESSAGE_MEDIA_TYPE) {
      continue;
    }

    if (out.length >= MAX_ATTACHMENTS_PER_CASE) {
      if (!capWarned) {
        capWarned = true;
        logger.warn(`a test produced more than ${MAX_ATTACHMENTS_PER_CASE} attachments; the rest were dropped.`);
      }
      break;
    }

    if (a.name === NAME_TRACE || a.contentType === 'application/zip') {
      continue;
    }

    if (isVideo(a)) {
      if (!a.path) {
        // An in-memory video is not something Playwright produces on its own
        // and cannot be routed through localVideoPath without writing it out;
        // inlining a video would blow the budget instantly.
        logger.warn(`skipping in-memory video attachment "${a.name}": only file-backed videos are supported.`);
        continue;
      }
      const copied = copyVideoAttachment(a.path, config.outputDir, config.maxVideoBytes);
      if (copied) {
        out.push({
          name: a.name,
          mimeType: copied.mimeType,
          localVideoPath: copied.localVideoPath,
          fileSize: copied.fileSize,
        });
      }
      continue;
    }

    const inlined = inlineAttachment(a, config, budget);
    if (inlined) {
      out.push(inlined);
    }
  }

  return out;
}

/**
 * Turns raw bytes into a wire `Attachment`, enforcing BOTH caps.
 *
 * Every path that inlines content must go through here. `/collect` rejects a
 * body over 10MB outright (api-service `launch_controller.go`'s
 * `BodyLimit(10<<20)`), and a rejected request loses the ENTIRE launch — not
 * just the oversized attachment. `maxTotalAttachmentBytes` defaults to 750KB
 * precisely to stay clear of that, so any path that skips the budget can
 * silently destroy a whole run's results.
 */
export function inlineFromBuffer(
  name: string,
  bytes: Buffer,
  mimeType: string | undefined,
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): Attachment | undefined {
  if (bytes.byteLength > config.maxAttachmentBytes) {
    logger.warn(
      `skipping attachment "${name}": ${bytes.byteLength} bytes exceeds the configured maxAttachmentBytes cap of ${config.maxAttachmentBytes} bytes.`,
    );
    return undefined;
  }
  if (!budget.tryReserve(bytes.byteLength)) {
    logger.warn(
      `skipping attachment "${name}": this run's total inline-attachment budget of ${config.maxTotalAttachmentBytes} bytes is exhausted.`,
    );
    return undefined;
  }

  return {
    name,
    ...(mimeType ? { mimeType } : {}),
    content: bytes.toString('base64'),
    fileSize: bytes.byteLength,
  };
}

/**
 * Reads a file from disk and inlines it, subject to the same caps.
 *
 * `stat`s before reading so an oversized file is rejected without ever being
 * pulled into memory. Every failure warns and returns `undefined`; an
 * attachment must never fail a run.
 */
export function inlineFromFile(
  name: string,
  filePath: string,
  mimeType: string | undefined,
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): Attachment | undefined {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping attachment "${name}": could not stat ${filePath}: ${(err as Error).message}`);
    return undefined;
  }
  if (size > config.maxAttachmentBytes) {
    logger.warn(
      `skipping attachment "${name}": ${size} bytes exceeds the configured maxAttachmentBytes cap of ${config.maxAttachmentBytes} bytes.`,
    );
    return undefined;
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    logger.warn(`skipping attachment "${name}": could not read ${filePath}: ${(err as Error).message}`);
    return undefined;
  }
  return inlineFromBuffer(name, bytes, mimeType, config, budget);
}

function inlineAttachment(
  a: TestResult['attachments'][number],
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): Attachment | undefined {
  if (a.body) {
    return inlineFromBuffer(a.name, a.body, a.contentType, config, budget);
  }
  if (a.path) {
    return inlineFromFile(a.name, a.path, a.contentType, config, budget);
  }
  return undefined;
}
