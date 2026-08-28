import { test, expect } from '@playwright/test';
import { qualflare } from '@qualflare/playwright';

test('a user can sign in @smoke', async ({ page }) => {
  qualflare.label('epic', 'Authentication');
  qualflare.label('owner', 'platform-team');
  qualflare.link('https://example.com/issue/42', { type: 'issue', name: 'AUTH-42' });
  qualflare.description('Signs a user in and asserts the greeting renders.');
  qualflare.priority('high');

  await qualflare.step('open the app', async () => {
    qualflare.parameter('entrypoint', '/login');
    await page.goto('data:text/html,<h1>Welcome back</h1>');
  });

  await qualflare.step('assert the greeting', async () => {
    await expect(page.locator('h1')).toHaveText('Welcome back');
  });
});
