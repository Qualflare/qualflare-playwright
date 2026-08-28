import { defineConfig } from '@playwright/test';
import { qualflareReporter } from '@qualflare/playwright';

export default defineConfig({
  testDir: './tests',
  // `list` keeps the usual console output; the Qualflare reporter prints
  // almost nothing and declares printsToStdio() === false, so Playwright
  // would otherwise inject a terminal reporter for you anyway.
  reporter: [
    ['list'],
    // qualflareReporter() is a typed helper — Playwright types reporter
    // options as `any`, so writing the tuple by hand silently accepts typos.
    qualflareReporter({
      environment: 'development',
      // Everything else has a sensible default: results land in
      // ./qualflare-results, which `qf collect` then uploads. There is no
      // token option — this reporter makes no network calls.
    }),
  ],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
