import { defineConfig } from '@playwright/test';

/**
 * The dogfood suite: qualflare-playwright reporting on tests of itself.
 *
 * Unlike test/integration/fixtures/playwright-project, every test here is meant
 * to PASS. That suite deliberately fails, to exercise status mapping; this one
 * is uploaded to Qualflare, so red has to mean a real regression rather than
 * expected fixture noise.
 *
 * The reporter is loaded from BUILT dist/, so `npm run build` is a prerequisite
 * and the suite exercises what actually ships.
 */
export default defineConfig({
  testDir: './tests',
  // Playwright's OWN artifact directory (its traces/screenshots on failure),
  // distinct from the reporter's outputDir. Kept inside e2e/ so it cannot
  // litter the repo root; screenshot/video/trace are all off below, so this
  // stays essentially empty.
  outputDir: './.artifacts',
  // ZERO global retries, deliberately. Retries are scoped to the one test that
  // is intentionally flaky (see tests/retries.spec.ts). A global retry would
  // silently re-run and green a GENUINE regression, which defeats the entire
  // premise of a suite whose red is meant to mean something.
  retries: 0,
  // Deterministic order and a single worker: the report is asserted case by
  // case afterwards, and parallelism buys nothing for six tests.
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    [
      '../dist/reporter/index.js',
      {
        // Relative to THIS CONFIG FILE, not the cwd -- './e2e-results' here would
        // land in e2e/e2e-results and quietly diverge from what the workflow
        // collects. '../' puts it at the repo root.
        outputDir: process.env['QUALFLARE_OUTPUT_DIR'] ?? '../e2e-results',
        // Recorded in the report itself rather than passed at collect time, so
        // the report is self-describing and there is one source of truth for
        // the environment instead of two that can disagree.
        environment: 'production',
        // Git detection is
        // skipped for the same reason the integration fixture skips it: it
        // forks a subprocess and makes the report environment-dependent.
        branch: null,
        commit: null,
      },
    ],
  ],
  use: {
    // No baseURL and no network: every page is a data: URL, so this suite
    // cannot be broken by a site being slow or down.
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
