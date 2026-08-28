import { test, expect } from '@playwright/test';

test('fails with a recognizable error message', async () => {
  expect('qualflare-playwright-integration-test-marker').toBe('nope');
});
