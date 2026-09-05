import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite as PwSuite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { resolveConfig, type QualflarePlaywrightOptions, type ResolvedReporterConfig } from '../config/resolve-config.js';
import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';
import { AttachmentBudget, resolveAttachments } from './attachment-reader.js';
import { buildCase } from './case-builder.js';
import { buildCollectPayload } from './collect-builder.js';
import { groupIntoSuites, relativizeFile, type CaseWithFile } from './suite-builder.js';

/** Options Playwright injects on top of the user's own, for every reporter.
 * It also injects internal `_mode`/`_commandHash` fields; this package
 * deliberately reads neither, since both are undocumented internals. */
interface InjectedOptions {
  configDir?: string;
}

/**
 * The Qualflare Playwright reporter.
 *
 * Writes ONE uniquely-named JSON report per process into `outputDir`, plus
 * any videos copied alongside it, and makes zero network calls.
 * `qualflare-cli collect <outputDir>` uploads the result — which is what lets
 * any number of sharded jobs write into one directory and merge into a single
 * Launch.
 *
 * Registered in `playwright.config.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   reporter: [['list'], ['@qualflare/playwright/reporter', { environment: 'staging' }]],
 * });
 * ```
 */
export default class QualflareReporter implements Reporter {
  private readonly options: QualflarePlaywrightOptions & InjectedOptions;
  private config?: ResolvedReporterConfig;
  private rootDir = process.cwd();
  private readonly cases: CaseWithFile[] = [];
  private readonly browsers = new Set<string>();
  private budget = new AttachmentBudget(0);
  private rootSuite?: PwSuite;
  private readonly attachmentsByResult = new Map<string, Attachment[]>();
  private readonly latestAttemptByTest = new Map<string, number>();

  constructor(options: QualflarePlaywrightOptions & InjectedOptions = {}) {
    this.options = options;
  }

  /** Returning false tells Playwright to auto-inject a terminal reporter
   * (`line` locally, `dot` on CI) so a user who registers only this one is
   * not left staring at a blank console. This reporter prints nothing but
   * warnings and a single completion line. */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: PwSuite): void {
    this.guard('onBegin', () => {
      this.rootSuite = suite;
      this.rootDir = config.rootDir || process.cwd();

      // Playwright's shard index is 1-BASED ("--shard=1/3" is the first
      // shard); ours is 0-based, matching every other Qualflare reporter.
      const detectedShardIndex = config.shard ? config.shard.current - 1 : undefined;

      this.config = resolveConfig(this.options, { detectedShardIndex });
      // Resolve outputDir ONCE, here, so every consumer sees the same absolute
      // path. It used to be resolved only where the JSON is written, while the
      // video, trace and screenshot writers each took the raw config string --
      // which resolves against the CWD, not the config file. Run
      // `playwright test --config e2e/playwright.config.ts` from a repo root
      // with a relative outputDir and the report lands next to the config while
      // every artifact lands somewhere else entirely, leaving localVideoPath /
      // localImagePath pointing at files the CLI cannot find.
      this.config.outputDir = this.resolveOutputDir(this.config.outputDir);
      this.budget = new AttachmentBudget(this.config.maxTotalAttachmentBytes);

      for (const project of config.projects) {
        const browserName = project.use?.browserName;
        if (browserName) {
          this.browsers.add(browserName);
        }
      }
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.guard('onTestEnd', () => {
      const config = this.config;
      if (!config || !config.enabled) {
        return;
      }
      // Attachment FILES are read here, not in onEnd, and this ordering is
      // load-bearing: `use.preserveOutput` deletes artifacts once a test
      // finishes, and a passing retry cleans up the previous attempt's output
      // directory. By onEnd the screenshots and videos may simply be gone.
      //
      // The Case itself is NOT assembled here — test.outcome() is not final
      // until every retry has run, so a to-be-retried failure would be
      // reported as a plain failure and nothing would ever be flaky.
      // A retried test reaches onTestEnd once per ATTEMPT, but only the FINAL
      // attempt's attachments are ever reported (see buildCase). Discard the
      // superseded attempt's work as soon as a later one arrives, or its
      // copied video is orphaned in outputDir forever and its bytes stay
      // reserved against a budget that a later test still needs.
      this.discardSupersededAttempt(test.id, result.retry, config.outputDir);
      this.attachmentsByResult.set(`${test.id}:${result.retry}`, resolveAttachments(result, config, this.budget));
      this.latestAttemptByTest.set(test.id, result.retry);
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    await Promise.resolve();
    this.guard('onEnd', () => {
      const config = this.config;
      if (!config || !config.enabled) {
        return;
      }
      this.writeReport(config);
    });
  }

  /** Collects every test from the (possibly nested) suite tree. */
  private collectCases(root: PwSuite, config: ResolvedReporterConfig): void {
    for (const test of root.allTests()) {
      const built = buildCase(test, config, this.attachmentsByResult, this.budget);
      if (!built) {
        continue;
      }
      const file = relativizeFile(test.location.file, this.rootDir);
      built.className = file;
      if (built.properties) {
        built.properties['file'] = file;
      }
      const browserName = test.parent.project()?.use?.browserName;
      this.cases.push({
        file,
        ...(browserName ? { browser: browserName } : {}),
        testCase: built,
      });
    }
  }

  private writeReport(config: ResolvedReporterConfig): void {
    if (this.rootSuite) {
      this.collectCases(this.rootSuite, config);
    }

    const suites = groupIntoSuites(this.cases);
    if (suites.length === 0) {
      logger.info('no test results were captured this run — skipping file write.');
      return;
    }

    const collect = buildCollectPayload(suites, config, [...this.browsers]);

    if (config.shardIndex !== undefined) {
      for (const suite of collect.suites) {
        for (const testCase of suite.cases) {
          testCase.shardIndex = config.shardIndex;
        }
      }
    }

    // Already absolute -- resolved once in onBegin.
    const outputDir = config.outputDir;

    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${randomUUID()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(collect));
    logger.info(`wrote Collect payload to ${outputPath} — run \`qualflare-cli collect ${outputDir}\` to upload it.`);
  }

  /** Relative `outputDir` resolves against the Playwright config's own
   * directory, not the shell's cwd — a user running `npx playwright test`
   * from a monorepo root should still write next to their config.
   *
   * Called exactly once, from `onBegin`, so `config.outputDir` is absolute
   * everywhere downstream. Do not resolve again at a use site: a second
   * resolution is what let the report and its artifacts land in different
   * directories. */
  private resolveOutputDir(outputDir: string): string {
    return path.isAbsolute(outputDir) ? outputDir : path.resolve(this.options.configDir ?? this.rootDir, outputDir);
  }

  /** Drops everything an earlier, now-superseded attempt produced: deletes the
   * video or trace copied into outputDir and refunds its bytes to the run
   * budget. */
  private discardSupersededAttempt(testId: string, retry: number, outputDir: string): void {
    const previous = this.latestAttemptByTest.get(testId);
    if (previous === undefined || previous >= retry) {
      return;
    }
    const key = `${testId}:${previous}`;
    for (const attachment of this.attachmentsByResult.get(key) ?? []) {
      // Both heavy artifacts are copied into outputDir, so both leak if a
      // superseded attempt's copy is left behind.
      const orphan = attachment.localVideoPath ?? attachment.localTracePath;
      if (orphan) {
        try {
          fs.rmSync(path.join(this.resolveOutputDir(outputDir), orphan), { force: true });
        } catch {
          // Best effort: an orphan left on disk is untidy, never incorrect.
        }
      }
      if (attachment.fileSize && attachment.content) {
        this.budget.release(attachment.fileSize);
      }
    }
    this.attachmentsByResult.delete(key);
  }

  /**
   * Playwright SWALLOWS anything a reporter throws (Multiplexer._wrap catches
   * it and re-dispatches as onError), so an unguarded bug here vanishes
   * silently and the user just gets no report. Every hook body runs through
   * this instead, which at least says what broke and where.
   */
  private guard(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.error(`${hook} failed: ${(err as Error).message}`);
    }
  }
}
