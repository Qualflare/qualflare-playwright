import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  copyImageAttachment,
  isOffloadableImage,
  writeImageAttachment,
} from '../../src/reporter/video-writer.js';

let dir: string;
let out: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-image-'));
  out = path.join(dir, 'results');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeFile(name: string, bytes = PNG_MAGIC): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('copyImageAttachment', () => {
  it('copies a screenshot into outputDir under a unique name', () => {
    const result = copyImageAttachment(makeFile('shot.png'), out, 1_000_000)!;
    expect(result.mimeType).toBe('image/png');
    expect(result.localImagePath).toMatch(/\.png$/);
    // Relative to outputDir, never absolute: the whole directory travels
    // together as one CI artifact bundle.
    expect(path.isAbsolute(result.localImagePath)).toBe(false);
    expect(fs.existsSync(path.join(out, result.localImagePath))).toBe(true);
    expect(result.fileSize).toBe(PNG_MAGIC.length);
  });

  it('derives the MIME type from the extension, not a declared type', () => {
    // Playwright names its auto-screenshot "screenshot" with no extension, and
    // the upload endpoint cross-checks extension against MIME — so a declared
    // type that disagrees with the file would earn a 400 per screenshot.
    expect(copyImageAttachment(makeFile('a.jpg'), out, 1_000_000)!.mimeType).toBe('image/jpeg');
    expect(copyImageAttachment(makeFile('b.jpeg'), out, 1_000_000)!.mimeType).toBe('image/jpeg');
    expect(copyImageAttachment(makeFile('c.gif'), out, 1_000_000)!.mimeType).toBe('image/gif');
  });

  it('declines a format the upload endpoint does not accept, leaving it to the inline path', () => {
    // Not a failure: .bmp and .txt take the inline route exactly as before.
    expect(copyImageAttachment(makeFile('d.bmp'), out, 1_000_000)).toBeUndefined();
    expect(copyImageAttachment(makeFile('e.txt'), out, 1_000_000)).toBeUndefined();
    expect(copyImageAttachment(makeFile('f.svg'), out, 1_000_000)).toBeUndefined();
  });

  it('skips an oversized image rather than copying it', () => {
    const big = makeFile('big.png', Buffer.alloc(4096));
    expect(copyImageAttachment(big, out, 1024)).toBeUndefined();
    // Stat happens BEFORE the copy, so nothing is written just to be rejected.
    expect(fs.existsSync(out) && fs.readdirSync(out).length > 0).toBe(false);
  });

  it('skips a file that cannot be read instead of throwing', () => {
    expect(copyImageAttachment(path.join(dir, 'missing.png'), out, 1_000_000)).toBeUndefined();
  });
});

describe('writeImageAttachment', () => {
  it('writes an in-memory screenshot out, which is what the metadata API produces', () => {
    const result = writeImageAttachment(PNG_MAGIC, 'image/png', out, 1_000_000)!;
    expect(result.localImagePath).toMatch(/\.png$/);
    expect(fs.readFileSync(path.join(out, result.localImagePath))).toEqual(PNG_MAGIC);
    expect(result.fileSize).toBe(PNG_MAGIC.length);
  });

  it('picks the extension from the MIME type, since a buffer has no filename', () => {
    expect(writeImageAttachment(PNG_MAGIC, 'image/jpeg', out, 1_000_000)!.localImagePath).toMatch(/\.jpg$/);
    expect(writeImageAttachment(PNG_MAGIC, 'image/gif', out, 1_000_000)!.localImagePath).toMatch(/\.gif$/);
  });

  it('declines a MIME type with no accepted extension', () => {
    expect(writeImageAttachment(PNG_MAGIC, 'image/bmp', out, 1_000_000)).toBeUndefined();
    expect(writeImageAttachment(PNG_MAGIC, 'text/plain', out, 1_000_000)).toBeUndefined();
  });

  it('respects the cap', () => {
    expect(writeImageAttachment(Buffer.alloc(4096), 'image/png', out, 1024)).toBeUndefined();
  });

  it('gives every attachment its own filename, so two screenshots never collide', () => {
    const a = writeImageAttachment(PNG_MAGIC, 'image/png', out, 1_000_000)!;
    const b = writeImageAttachment(PNG_MAGIC, 'image/png', out, 1_000_000)!;
    expect(a.localImagePath).not.toBe(b.localImagePath);
    expect(fs.readdirSync(out)).toHaveLength(2);
  });
});

describe('isOffloadableImage', () => {
  it('accepts exactly the three types the upload endpoint allows', () => {
    expect(isOffloadableImage('image/png')).toBe(true);
    expect(isOffloadableImage('image/jpeg')).toBe(true);
    expect(isOffloadableImage('image/gif')).toBe(true);
    expect(isOffloadableImage('image/bmp')).toBe(false);
    expect(isOffloadableImage('image/svg+xml')).toBe(false);
    expect(isOffloadableImage('text/plain')).toBe(false);
    expect(isOffloadableImage(undefined)).toBe(false);
  });
});
