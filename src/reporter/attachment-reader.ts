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

function inlineAttachment(
  a: TestResult['attachments'][number],
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): Attachment | undefined {
  let bytes: Buffer;

  if (a.body) {
    bytes = a.body;
  } else if (a.path) {
    // stat before read: an oversized file must be rejected without pulling it
    // into memory first.
    let size: number;
    try {
      size = fs.statSync(a.path).size;
    } catch (err) {
      logger.warn(`skipping attachment "${a.name}": could not stat ${a.path}: ${(err as Error).message}`);
      return undefined;
    }
    if (size > config.maxAttachmentBytes) {
      logger.warn(
        `skipping attachment "${a.name}": ${size} bytes exceeds the configured maxAttachmentBytes cap of ${config.maxAttachmentBytes} bytes.`,
      );
      return undefined;
    }
    try {
      bytes = fs.readFileSync(a.path);
    } catch (err) {
      logger.warn(`skipping attachment "${a.name}": could not read ${a.path}: ${(err as Error).message}`);
      return undefined;
    }
  } else {
    return undefined;
  }

  if (bytes.byteLength > config.maxAttachmentBytes) {
    logger.warn(
      `skipping attachment "${a.name}": ${bytes.byteLength} bytes exceeds the configured maxAttachmentBytes cap of ${config.maxAttachmentBytes} bytes.`,
    );
    return undefined;
  }
  if (!budget.tryReserve(bytes.byteLength)) {
    logger.warn(
      `skipping attachment "${a.name}": this run's total inline-attachment budget of ${config.maxTotalAttachmentBytes} bytes is exhausted.`,
    );
    return undefined;
  }

  return {
    name: a.name,
    ...(a.contentType ? { mimeType: a.contentType } : {}),
    content: bytes.toString('base64'),
    fileSize: bytes.byteLength,
  };
}
