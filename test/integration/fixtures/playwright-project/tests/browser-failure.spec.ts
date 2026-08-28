import { test, expect } from '@playwright/test';

// Uses a real page so Playwright actually records a video and captures a
// screenshot on failure — the attachment paths the reporter has to route
// differently (video -> copied file + localVideoPath; screenshot -> inline
// base64). data: URL keeps it offline and fast.
test('fails while a page is open, producing a screenshot and video', async ({ page }) => {
  await page.goto('data:text/html,<h1>qualflare</h1>');
  await expect(page.locator('h1')).toHaveText('this text is not present');
});
