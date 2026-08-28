import { defineConfig } from '@playwright/test';

// Registers the BUILT dist/ output rather than src/, deliberately: this
// exercises the real package `exports` map and compiled ESM that a consumer
// loads. Requires `npm run build` first — see run-playwright-project.test.ts.
export default defineConfig({
  testDir: './tests',
  // Fixtures fail by design; the suite asserts on the written report, never
  // on the exit code.
  retries: 1,
  reporter: [
    [
      '../../../../dist/reporter/index.js',
      {
        outputDir: process.env.QUALFLARE_TEST_OUTPUT_DIR ?? './qualflare-results',
        environment: 'development',
        // Skip git/CI auto-detection noise — it forks a `git` subprocess this
        // harness does not need and would make assertions env-dependent.
        branch: null,
        commit: null,
      },
    ],
  ],
  use: {
    screenshot: 'only-on-failure',
    video: 'on',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
