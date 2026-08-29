import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { qualflare } from '../../../../../dist/index.js';

// Regression guard for the defect that could lose an ENTIRE launch:
// qualflare.attachmentFromFile() used to inline any file with no size cap, so
// one large attachment produced a >10MB request body, /collect returned 413,
// and every result in the run was rejected — not just the attachment.
//
// The run must still complete and still produce a valid report; the oversized
// attachment is simply skipped with a warning.
test('an oversized attachment is skipped, not fatal', async () => {
  const file = path.join(os.tmpdir(), 'qualflare-oversized-attachment.bin');
  // Comfortably over the 1.5MB maxAttachmentBytes default.
  fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024));
  try {
    qualflare.attachmentFromFile('too-big', file, { mimeType: 'application/octet-stream' });
    qualflare.attachment('small-enough', 'this one fits', { mimeType: 'text/plain' });
    expect(true).toBe(true);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
