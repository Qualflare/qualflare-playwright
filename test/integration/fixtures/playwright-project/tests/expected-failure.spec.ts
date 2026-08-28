import { test, expect } from '@playwright/test';

// test.fail() declares the failure expected, so Playwright reports
// outcome 'expected' — the reporter must record this as PASSED.
test('fails on purpose and is therefore expected', async () => {
  test.fail();
  expect(1).toBe(2);
});
