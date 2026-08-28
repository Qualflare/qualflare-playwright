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

/**
 * Copies one video file into `outputDir` under a unique filename (Allure's
 * `FileSystemWriter.writeAttachmentFromPath` pattern: `fs.copyFileSync`,
 * never read into memory) and returns enough to build that `Attachment`
 * entry's `localVideoPath`. `qualflare-cli` is what actually uploads this
 * file later, once it has a real auth token — see the design spec.
 *
 * Best-effort, like the rest of this reporter's attachment handling
 * (`attachment-reader.ts`'s oversized/unreadable-file skip): any failure —
 * oversized file, unsupported extension, an unreadable source file — is
 * logged as a warning and resolves to `undefined` rather than throwing, so a
 * video problem never fails the whole run.
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

  let fileSize: number;
  try {
    // Stat BEFORE copying — an oversized file must never be copied just to
    // discover it should be skipped.
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (fileSize > maxVideoBytes) {
    logger.warn(
      `skipping video attachment "${filePath}": ${fileSize} bytes exceeds the configured ` +
        `maxVideoBytes cap of ${maxVideoBytes} bytes.`,
    );
    return undefined;
  }

  const localVideoPath = `${randomUUID()}${ext}`;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(outputDir, localVideoPath));
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not copy file: ${(err as Error).message}`);
    return undefined;
  }

  return { localVideoPath, fileSize, mimeType };
}
