import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { logger } from '../shared/logger.js';

/** Extension -> MIME type for the video formats the server accepts (see
 * the upload endpoint's own allowlist server-side). Playwright records `.webm`
 * by default; `.mp4`/`.mov` are listed for parity with the server's allowlist
 * and because a user can attach either via `testInfo.attach()`. An extension not
 * in this map (a user could point `qualflare.attachmentFromFile()` at an
 * arbitrary file) is skipped — see `copyVideoAttachment`'s doc comment. */
const VIDEO_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export interface VideoCopyResult {
  /** Filename relative to the `outputDir` this was copied into — never an
   * absolute path, since the whole directory travels together as one CI
   * artifact bundle (see the design spec's "Why no backend changes"
   * section). */
  localVideoPath: string;
  fileSize: number;
  mimeType: string;
}

export interface TraceCopyResult {
  /** Filename relative to `outputDir`, same rule as `localVideoPath`. */
  localTracePath: string;
  fileSize: number;
  mimeType: string;
}

/** A Playwright trace is always a zip — `use.trace` produces exactly one shape,
 * so unlike video there is no extension table to consult. */
const TRACE_MIME_TYPE = 'application/zip';
const TRACE_EXTENSION = '.zip';

/**
 * Copies one artifact into `outputDir` under a unique filename (Allure's
 * `FileSystemWriter.writeAttachmentFromPath` pattern: `fs.copyFileSync`, never
 * read into memory) and returns its relative name plus size. `qualflare-cli` is
 * what actually uploads it later, once it has a real auth token.
 *
 * Best-effort, like the rest of this reporter's attachment handling: any
 * failure — oversized file, an unreadable source — is logged as a warning and
 * resolves to `undefined` rather than throwing, so an artifact problem never
 * fails the whole run.
 */
function copyArtifact(
  filePath: string,
  outputDir: string,
  maxBytes: number,
  ext: string,
  capName: string,
  label: string,
): { localPath: string; fileSize: number } | undefined {
  let fileSize: number;
  try {
    // Stat BEFORE copying — an oversized file must never be copied just to
    // discover it should be skipped.
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping ${label} attachment "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (fileSize > maxBytes) {
    logger.warn(
      `skipping ${label} attachment "${filePath}": ${fileSize} bytes exceeds the configured ` +
        `${capName} cap of ${maxBytes} bytes.`,
    );
    return undefined;
  }

  const localPath = `${randomUUID()}${ext}`;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(outputDir, localPath));
  } catch (err) {
    logger.warn(`skipping ${label} attachment "${filePath}": could not copy file: ${(err as Error).message}`);
    return undefined;
  }

  return { localPath, fileSize };
}

/**
 * Copies one video file into `outputDir` and returns enough to build that
 * `Attachment` entry's `localVideoPath`. An extension not in the MIME table (a
 * user could point `qualflare.attachmentFromFile()` at an arbitrary file) is
 * skipped rather than guessed at.
 */
export function copyVideoAttachment(
  filePath: string,
  outputDir: string,
  maxVideoBytes: number,
): VideoCopyResult | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = VIDEO_MIME_TYPES_BY_EXTENSION[ext];
  if (!mimeType) {
    logger.warn(`skipping video attachment "${filePath}": unsupported video format.`);
    return undefined;
  }

  const copied = copyArtifact(filePath, outputDir, maxVideoBytes, ext, 'maxVideoBytes', 'video');
  if (!copied) {
    return undefined;
  }
  return { localVideoPath: copied.localPath, fileSize: copied.fileSize, mimeType };
}

/**
 * Copies one Playwright trace zip into `outputDir` and returns enough to build
 * that `Attachment` entry's `localTracePath`.
 *
 * Traces were dropped entirely until `@qualflare/cli` v0.1.20 and the server
 * change that widened the attachment MIME allowlist to `application/zip` — the
 * allowlist was the only thing stopping them, not Playwright and not this
 * reporter. The upload is still opt-in on the CLI side
 * (`--upload-artifacts=trace`), so a trace written here is not automatically a
 * trace uploaded.
 */
export function copyTraceAttachment(
  filePath: string,
  outputDir: string,
  maxTraceBytes: number,
): TraceCopyResult | undefined {
  const copied = copyArtifact(filePath, outputDir, maxTraceBytes, TRACE_EXTENSION, 'maxTraceBytes', 'trace');
  if (!copied) {
    return undefined;
  }
  return { localTracePath: copied.localPath, fileSize: copied.fileSize, mimeType: TRACE_MIME_TYPE };
}
