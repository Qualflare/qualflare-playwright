import { expect, test } from '@playwright/test';

// A real page, from a data: URL. Hermetic on purpose: the example project is
// the one thing in this repo that visits the public internet, and CI wraps it
// in `npm test || true` precisely because that site's availability says nothing
// about this package. A dogfood suite must never inherit that.
const PAGE = 'data:text/html,<h1 style="font:48px sans-serif">qualflare</h1>';

test('attaches a screenshot, which travels out of band', async ({ page }, testInfo) => {
  await page.goto(PAGE);
  await expect(page.locator('h1')).toHaveText('qualflare');

  const shot = await page.screenshot();
  // testInfo.attach() with a Buffer is the in-memory path -- the reporter
  // writes it into outputDir and references it by localImagePath rather than
  // base64-inlining it. That contract needs @qualflare/cli v0.1.24+, and this
  // is the test that proves the reporter still holds up its end of it.
  await testInfo.attach('screenshot', { body: shot, contentType: 'image/png' });

  expect(shot.byteLength).toBeGreaterThan(0);
});
