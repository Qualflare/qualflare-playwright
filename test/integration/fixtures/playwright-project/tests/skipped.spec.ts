import { test, expect } from '@playwright/test';

test.skip('is skipped statically', async () => {
  expect(true).toBe(false);
});

test('runs after a skipped test', async () => {
  expect(true).toBe(true);
});
