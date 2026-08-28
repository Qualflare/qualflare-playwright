import { test, expect } from '@playwright/test';
import { qualflare } from '@qualflare/playwright';

for (const [item, total] of [
  ['book', '10'],
  ['pen', '2'],
] as const) {
  test(`checks out a ${item}`, async ({ page }) => {
    qualflare.label('feature', 'Checkout');
    qualflare.parameter('item', item);
    await page.goto(`data:text/html,<span id=total>${total}</span>`);
    await expect(page.locator('#total')).toHaveText(total);
  });
}
