import { expect, test } from '@playwright/test';

// Fails its first attempt and passes on retry, producing `attempts[]` with two
// entries -- the per-attempt history that shipped recently and that the CLI
// silently discarded until v0.1.23. A green suite still has to exercise it, so
// this test is deliberately, deterministically flaky.
//
// Keyed on testInfo.retry, NOT a marker file on disk. A marker survives an
// interrupted run and silently makes the next run's first attempt pass, turning
// this into a no-op that still looks green -- the exact trap the integration
// fixture's own flaky test documents.
// Retries are scoped HERE, not set globally. A global `retries` would re-run a
// genuine regression and quietly turn it green -- in a suite whose whole job is
// that red means something.
test.describe('intentional retry', () => {
  test.describe.configure({ retries: 1 });

  test('fails once, then passes, producing per-attempt history', async ({}, testInfo) => {
    expect(testInfo.retry, 'dogfood-intentional-retry-marker').toBeGreaterThan(0);
  });
});
