import * as os from 'node:os';

import { PACKAGE_VERSION } from '../config/version.js';
import type { ResolvedReporterConfig } from '../config/resolve-config.js';
import type { Collect, Suite } from '../shared/types.js';

function resolveOs(config: ResolvedReporterConfig): string {
  if (config.os) {
    return config.os;
  }
  return `${os.type()} ${os.release()}`;
}

/**
 * Launch-level browser. Playwright is the only one of the three reporters
 * that genuinely knows this: `FullProject.use.browserName` is real, whereas
 * `qualflare-cli`'s existing Playwright parser reports the PROJECT NAME here
 * (so a project called `smoke` or `mobile-safari` becomes the "browser").
 *
 * A multi-project run has no single browser, so the distinct set is joined
 * rather than picking one arbitrarily; per-suite attribution is finer-grained
 * and lives on `Suite.browser`.
 */
function resolveBrowser(config: ResolvedReporterConfig, browsers: readonly string[]): string {
  if (config.browser) {
    return config.browser;
  }
  return [...new Set(browsers)].sort().join(', ');
}

/**
 * Assembles the final `Collect` payload at `onEnd`.
 *
 * CI metadata and branch/commit detection are already fully resolved by
 * `resolve-config.ts` — this reads the resolved config through and does NOT
 * call `ci-detect`/`git-detect` itself, matching both sibling packages.
 *
 * `metadata` is not optional decoration: `qualflare-cli` identifies this
 * format by the presence of `framework` + `metadata` + `suites` together.
 * Omitting it makes the CLI fall back to filename matching, where a file
 * whose name contains "playwright" is routed to the built-in-JSON parser and
 * fails to parse. For the same reason this payload must never grow a
 * top-level `config` key — that is the Playwright-JSON detector's signature.
 */
export function buildCollectPayload(
  suites: Suite[],
  config: ResolvedReporterConfig,
  browsers: readonly string[] = [],
): Collect {
  return {
    framework: config.framework,
    platform: config.platform,
    os: resolveOs(config),
    browser: resolveBrowser(config, browsers),
    branch: config.branch,
    commit: config.commit,
    environment: config.environment,
    language: config.language,
    milestone: config.milestone,
    metadata: {
      version: PACKAGE_VERSION,
      timestamp: new Date().toISOString(),
      cliName: 'qualflare-playwright',
      runId: config.runId,
    },
    properties: config.properties,
    suites,
    ciProvider: config.ciProvider,
    ciBuildNumber: config.ciBuildNumber,
    ciRunUrl: config.ciRunUrl,
    ciPrNumber: config.ciPrNumber,
  };
}
