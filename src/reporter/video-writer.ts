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

/** Extension -> MIME for the image formats the upload endpoint accepts. An
 * image outside this set (`.bmp`, `.svg`, a screenshot some plugin renamed) has
 * nowhere to go out of band and is left to the inline path, which is bounded by
 * `maxAttachmentBytes` and still works. */
const IMAGE_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/** MIME -> extension, for buffers that carry a type but no filename. */
const IMAGE_EXTENSIONS_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
};

export interface ImageWriteResult {
  /** Filename relative to `outputDir`, same rule as `localVideoPath`. */
  localImagePath: string;
  fileSize: number;
  mimeType: string;
}

/** Whether this MIME type can travel out of band as an image at all.
 *
 * A type predicate rather than a plain boolean so a caller holding
 * `string | undefined` is narrowed by the check, instead of having to assert
 * the type back afterwards. */
export function isOffloadableImage(mimeType: string | undefined): mimeType is string {
  return mimeType !== undefined && mimeType in IMAGE_EXTENSIONS_BY_MIME;
}

/**
 * Copies one screenshot into `outputDir` and returns enough to build that
 * `Attachment` entry's `localImagePath`.
 *
 * The MIME type is derived from the EXTENSION, not from the attachment's
 * declared `contentType`. Playwright names its auto-screenshot attachment
 * "screenshot" with no extension, and the server's upload endpoint cross-checks
 * the filename's extension against the MIME type it was given — so trusting a
 * declared type that disagrees with the file on disk earns a 400 per
 * screenshot.
 *
 * Requires `@qualflare/cli` v0.1.24+, which is what reads `localImagePath`. An
 * older CLI ignores the field, leaving an attachment with neither content nor
 * storageKey — a row the server persists from its name alone, showing as an
 * undownloadable placeholder. That is why this reporter's README states the
 * version floor.
 */
export function copyImageAttachment(
  filePath: string,
  outputDir: string,
  maxImageBytes: number,
): ImageWriteResult | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES_BY_EXTENSION[ext];
  if (!mimeType) {
    // Not a warning: this is the ordinary path for a .bmp or a .txt, which the
    // caller then inlines. Warning here would fire on every non-image
    // attachment in the run.
    return undefined;
  }

  const copied = copyArtifact(filePath, outputDir, maxImageBytes, ext, 'maxAttachmentBytes', 'image');
  if (!copied) {
    return undefined;
  }
  return { localImagePath: copied.localPath, fileSize: copied.fileSize, mimeType };
}

/**
 * Writes an in-memory screenshot into `outputDir`, for `testInfo.attach()` and
 * `qualflare.attachment()` which hand over a Buffer rather than a path.
 *
 * Unlike video and trace, an in-memory image is worth writing out rather than
 * refusing: it is small, it is the shape the metadata API produces, and
 * refusing would push every programmatic screenshot back onto the inline path
 * this change exists to empty.
 */
export function writeImageAttachment(
  bytes: Buffer,
  mimeType: string,
  outputDir: string,
  maxImageBytes: number,
): ImageWriteResult | undefined {
  const ext = IMAGE_EXTENSIONS_BY_MIME[mimeType];
  if (!ext) {
    return undefined;
  }
  if (bytes.length > maxImageBytes) {
    logger.warn(
      `skipping image attachment: ${bytes.length} bytes exceeds the configured ` +
        `maxAttachmentBytes cap of ${maxImageBytes} bytes.`,
    );
    return undefined;
  }

  const localImagePath = `${randomUUID()}${ext}`;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, localImagePath), bytes);
  } catch (err) {
    logger.warn(`skipping image attachment: could not write file: ${(err as Error).message}`);
    return undefined;
  }
  return { localImagePath, fileSize: bytes.length, mimeType };
}
