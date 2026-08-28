import { MAX_VIDEO_UPLOAD_BYTES } from '../shared/constants.js';
import type { Platform } from '../shared/types.js';
import { detectCi, type CiMetadata } from './ci-detect.js';
import { detectGit, type GitInfo } from './git-detect.js';

/** Options passed via the `--format-options`/`formatOptions` value the user
 * passes to `@qualflare/playwright/reporter` in `playwright.config.ts`'s
 * `reporter` array. Every field here also has an environment-variable
 * override — see the precedence table in the README / plan. */
export interface QualflarePlaywrightOptions {
  environment?: string;
  language?: string;
  milestone?: number | null;
  branch?: string | null;
  commit?: string | null;
  platform?: Platform;
  framework?: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  /** Max 64 chars. Free text, no enum — an unrecognized CI provider must
   * never be rejected. Auto-detected via `ci-detect.ts` when omitted. */
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  attachScreenshots?: boolean;
  /** Include `BeforeStep`/`AfterStep` hook executions as synthetic steps.
   * Off by default — these run once per Gherkin step and can multiply the
   * step count several-fold for suites with global per-step instrumentation
   * hooks (e.g. a screenshot-after-every-step hook), which is noisy as a
   * default but valuable as an explicit opt-in. */
  /** Include Playwright's own `pw:api` steps (every `page.click()`,
   * `locator.fill()`, ...) as reported Steps. Off by default: a single
   * browser test routinely produces hundreds of them, which buries the
   * user-authored `test.step()`/`expect` boundaries that are actually
   * legible in a report and blows through MAX_STEPS_PER_TEST_ATTEMPT on
   * noise. A step that FAILED is always kept regardless of this setting. */
  includeApiSteps?: boolean;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  /** Per-video byte cap, checked before the file is written. Default 50MB,
   * matching the server's own hard cap. */
  maxVideoBytes?: number;
  debug?: boolean;
  /** `false` fully disables accumulation/upload (a complete no-op) but the
   * formatter still no-ops cleanly rather than throwing. */
  enabled?: boolean;
  /** Directory `finished()` writes this process's report file (and any
   * video attachments) into. Default `./qualflare-results`. Always active —
   * this formatter never uploads anything itself; `qualflare-cli` reads
   * whatever ends up in this directory. Every JSON file this process writes
   * is uniquely named, so multiple shards can safely share one `outputDir`
   * without colliding — see docs/LIMITATIONS.md. */
  outputDir?: string;
  /** This process's 0-based position among parallel shards of the same CI
   * run, stamped onto every case it reports. Purely a label: `qualflare-cli`
   * merges by "every file in the directory", not by this value, so an
   * unset shardIndex costs attribution, never correctness.
   *
   * Auto-detected, in order: `QUALFLARE_SHARD_INDEX`, then Playwright's own
   * `--shard i/N`, which it exposes to reporters as `FullConfig.shard`
   * ({ current, total }). Playwright's `current` is 1-BASED, so the reporter
   * converts it before passing it here as `deps.detectedShardIndex`.
   *
   * This is the one place Playwright is markedly better than its siblings:
   * Cypress has no shard concept at all, and cucumber-js hides its `--shard`
   * from formatters entirely (forcing an argv scrape). Here the runner just
   * tells us. */
  shardIndex?: number;
}

export interface ResolvedReporterConfig {
  environment: string;
  language: string;
  milestone: number | null;
  branch: string | null;
  commit: string | null;
  platform: Platform;
  framework: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  attachScreenshots: boolean;
  includeApiSteps: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  debug: boolean;
  enabled: boolean;
  outputDir: string;
  shardIndex?: number;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function envBool(...names: string[]): boolean | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  return raw === 'true' || raw === '1';
}

function envInt(...names: string[]): number | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}


/** Resolves the full formatter configuration from, in order: the explicit
 * `options` (the formatter's own `formatOptions`), then `QUALFLARE_*`
 * environment variables, then `QF_*` (compat alias with the existing Go
 * CLI, where an equivalent exists), then a hardcoded default.
 *
 * Branch/commit precedence: `options.branch`/`.commit` (including an
 * explicit `null`, which is respected as "no auto-detection wanted" rather
 * than triggering the fallback tiers below it) > `QUALFLARE_BRANCH`/
 * `QF_BRANCH` env (and the commit equivalent) > CI-provider env vars > a
 * local `git` subprocess (`git-detect.ts`) > `null`. The subprocess tier is
 * skipped entirely — no `git` process is forked — once both branch and
 * commit are already resolved from options/env, mirroring
 * `qualflare-cli/internal/config/config.go`'s `DetectGit`'s early return.
 *
 * CI-metadata precedence (`ciProvider`/`ciBuildNumber`/`ciRunUrl`/
 * `ciPrNumber`): the corresponding `options.ci*` field, else `ci-detect.ts`'s
 * auto-detection (per-provider extraction table, falling back to the
 * `ci-info` package's ~70-provider free-text name).
 *
 * `deps` lets tests inject fake `detectGit`/`detectCi` implementations
 * instead of the real ones (which shell out to `git` and read the real
 * `process.env`/`ci-info` module state) — defaults to the real detectors,
 * so every production call site (the formatter's constructor calls
 * `resolveConfig(options)` with no second argument) is unaffected.
 */
export function resolveConfig(
  options: QualflarePlaywrightOptions,
  deps: { detectGit?: () => GitInfo; detectCi?: () => CiMetadata;
    /** Playwright's `FullConfig.shard`, already converted from its 1-based
     * `current` to our 0-based index by the reporter. */
    detectedShardIndex?: number;
  } = {},
): ResolvedReporterConfig {
  const doDetectGit = deps.detectGit ?? detectGit;
  const doDetectCi = deps.detectCi ?? detectCi;

  const enabled = options.enabled ?? envBool('QUALFLARE_ENABLED') ?? true;
  // `||`, not `??` — matching `environment`/`language` below: an explicit
  const outputDir = options.outputDir || firstEnv('QUALFLARE_OUTPUT_DIR') || './qualflare-results';
  const shardIndex = options.shardIndex ?? envInt('QUALFLARE_SHARD_INDEX') ?? deps.detectedShardIndex;

  const milestoneRaw = options.milestone !== undefined ? options.milestone : envInt('QUALFLARE_MILESTONE', 'QF_MILESTONE');
  const milestone = milestoneRaw !== undefined && milestoneRaw !== null && milestoneRaw >= 1 ? milestoneRaw : null;

  const envBranch = firstEnv('QUALFLARE_BRANCH', 'QF_BRANCH');
  const envCommit = firstEnv('QUALFLARE_COMMIT', 'QF_COMMIT');
  const needsGitDetection =
    (options.branch === undefined && envBranch === undefined) ||
    (options.commit === undefined && envCommit === undefined);
  const detectedGit = needsGitDetection ? doDetectGit() : {};

  const branch = options.branch !== undefined ? options.branch : (envBranch ?? detectedGit.branch ?? null);
  const commit = options.commit !== undefined ? options.commit : (envCommit ?? detectedGit.commit ?? null);

  const detectedCi = doDetectCi();
  const ciProvider = options.ciProvider ?? detectedCi.ciProvider;
  const ciBuildNumber = options.ciBuildNumber ?? detectedCi.ciBuildNumber;
  const ciRunUrl = options.ciRunUrl ?? detectedCi.ciRunUrl;
  const ciPrNumber = options.ciPrNumber ?? detectedCi.ciPrNumber;

  return {
    // `||` (truthy check), not `??`, for these three REQUIRED-non-empty wire
    // fields — an explicit `''` option must not silently win over the
    // default (the server rejects an empty `environment`). Ported verbatim from
    // qualflare-cypress, where this was found via deep adversarial review.
    environment: (options.environment || undefined) ?? firstEnv('QUALFLARE_ENVIRONMENT', 'QF_ENVIRONMENT') ?? 'development',
    language: (options.language || undefined) ?? firstEnv('QUALFLARE_LANGUAGE', 'QF_LANGUAGE') ?? 'en-US',
    milestone,
    branch,
    commit,
    platform: options.platform ?? 'web',
    framework: options.framework || 'playwright',
    os: options.os,
    browser: options.browser,
    properties: options.properties,
    ciProvider,
    ciBuildNumber,
    ciRunUrl,
    ciPrNumber,
    attachScreenshots: options.attachScreenshots ?? envBool('QUALFLARE_ATTACH_SCREENSHOTS') ?? true,
    includeApiSteps: options.includeApiSteps ?? envBool('QUALFLARE_INCLUDE_API_STEPS') ?? false,
    maxAttachmentBytes: options.maxAttachmentBytes ?? envInt('QUALFLARE_MAX_ATTACHMENT_BYTES') ?? 1_500_000,
    maxTotalAttachmentBytes:
      options.maxTotalAttachmentBytes ?? envInt('QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES') ?? 750_000,
    maxVideoBytes: options.maxVideoBytes ?? envInt('QUALFLARE_MAX_VIDEO_BYTES') ?? MAX_VIDEO_UPLOAD_BYTES,
    debug: options.debug ?? envBool('QUALFLARE_DEBUG', 'QF_DEBUG') ?? false,
    enabled,
    outputDir,
    shardIndex,
  };
}
