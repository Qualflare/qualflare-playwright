import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyTraceAttachment } from '../../src/reporter/video-writer.js';

let dir: string;
let out: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-trace-'));
  out = path.join(dir, 'results');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTrace(bytes: number, name = 'trace.zip'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

describe('copyTraceAttachment', () => {
  // The whole point of the change: a Playwright trace is the reporter's best
  // debugging artifact and was dropped entirely because the server's MIME
  // allowlist was video-only.
  it('copies the zip into outputDir and reports it as application/zip', () => {
    const src = writeTrace(64);

    const result = copyTraceAttachment(src, out, 1024);

    expect(result).toBeDefined();
    expect(result!.mimeType).toBe('application/zip');
    expect(result!.fileSize).toBe(64);
    expect(result!.localTracePath).toMatch(/\.zip$/);
    expect(fs.existsSync(path.join(out, result!.localTracePath))).toBe(true);
  });

  it('names the copy uniquely, so two traces in one run never collide', () => {
    const a = copyTraceAttachment(writeTrace(8, 'a.zip'), out, 1024);
    const b = copyTraceAttachment(writeTrace(8, 'b.zip'), out, 1024);

    expect(a!.localTracePath).not.toBe(b!.localTracePath);
    expect(fs.readdirSync(out)).toHaveLength(2);
  });

  // Stat before copy: an oversized trace must never be written into outputDir
  // just to be rejected later at collect time, after the bytes are already
  // spent.
  it('skips an oversized trace WITHOUT copying it', () => {
    const src = writeTrace(500);

    const result = copyTraceAttachment(src, out, 100);

    expect(result).toBeUndefined();
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toHaveLength(0);
  });

  // Fail-open: an artifact problem must never fail the run itself.
  it('returns undefined for an unreadable source rather than throwing', () => {
    expect(() => copyTraceAttachment(path.join(dir, 'missing.zip'), out, 1024)).not.toThrow();
    expect(copyTraceAttachment(path.join(dir, 'missing.zip'), out, 1024)).toBeUndefined();
  });
});
