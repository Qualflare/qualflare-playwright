import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Fails its first attempt and passes on retry, so the reporter must report
// ONE case with retryCount 1 and isFlaky true — not two cases, and not a
// failure. Uses a marker file rather than a module-level counter because
// Playwright retries in a fresh worker with fresh module state.
const marker = path.join(os.tmpdir(), 'qualflare-pw-flaky-marker');

test('is flaky and eventually passes', async () => {
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'seen');
    throw new Error('first attempt fails on purpose');
  }
  fs.rmSync(marker, { force: true });
  expect(true).toBe(true);
});
