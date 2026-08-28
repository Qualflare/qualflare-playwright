import { test, expect } from '@playwright/test';

// Fails its first attempt and passes on retry, so the reporter must produce
// ONE case with retryCount 1 and isFlaky true — not two cases, and not a
// failure.
//
// Keyed on testInfo.retry rather than a marker file on disk: a marker would
// survive an interrupted run and silently make the next run's first attempt
// pass, quietly turning this into a no-op test.
test('is flaky and eventually passes', async ({}, testInfo) => {
  expect(testInfo.retry, 'first attempt fails on purpose').toBeGreaterThan(0);
});
