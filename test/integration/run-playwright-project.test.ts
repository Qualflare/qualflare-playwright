import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixtureConfig = path.join(here, 'fixtures/playwright-project/playwright.config.ts');

/** Runs the fixture project through a REAL `playwright test` process, with the
 * reporter loaded from the BUILT dist/ (see the fixture's config), and returns
 * the report it wrote. `reject: false` because several fixture specs fail by
 * design — the assertions are about the written report, never the exit code. */
async function runFixture(outputDir: string, extraArgs: string[] = []) {
  const result = await execa('npx', ['playwright', 'test', '--config', fixtureConfig, ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env, QUALFLARE_TEST_OUTPUT_DIR: outputDir },
    reject: false,
  });

  if (!fs.existsSync(outputDir)) {
    throw new Error(
      `playwright run produced no ${outputDir} — it likely failed to start. exit code: ${result.exitCode}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  const reports = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
  if (reports.length === 0) {
    throw new Error(
      `playwright run wrote no report into ${outputDir}. exit code: ${result.exitCode}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return { result, reports };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON read back from disk, asserted field-by-field
function readReport(outputDir: string, file: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8')) as any;
}

describe('qualflare-playwright against a real playwright run', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-playwright-integration-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it(
    'writes one Collect report matching the wire contract, with attachments routed correctly',
    async () => {
      const { reports } = await runFixture(outputDir);

      // Exactly one report per process, however many specs ran.
      expect(reports).toHaveLength(1);
      const collect = readReport(outputDir, reports[0]!);

      expect(collect.framework).toBe('playwright');
      expect(collect.platform).toBe('web');
      expect(collect.branch).toBeNull();
      expect(collect.commit).toBeNull();
      // `metadata` is required for qualflare-cli's format detection, not
      // decoration — without it the CLI falls back to filename matching and a
      // file named *playwright* routes to the wrong parser entirely.
      expect(collect.metadata).toMatchObject({ cliName: 'qualflare-playwright' });
      expect(typeof collect.metadata.version).toBe('string');
      // A top-level `config` key is Playwright-JSON's detector signature and
      // would make the CLI mis-identify this format.
      expect(collect.config).toBeUndefined();
      // Real browserName, not the project name.
      expect(collect.browser).toBe('chromium');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allCases: any[] = collect.suites.flatMap((s: any) => s.cases);
      expect(allCases.length).toBeGreaterThan(0);
      // One Suite per spec file, named relative to Playwright's rootDir (the
      // common base of its testDirs) with POSIX separators — so the same spec
      // reported from a Windows and a Linux runner is ONE suite, and no CI
      // agent's absolute directory layout leaks into the report.
      for (const suite of collect.suites) {
        expect(suite.category).toBe('playwright');
        expect(suite.name).toMatch(/^[a-z-]+\.spec\.ts$/);
        expect(path.isAbsolute(suite.name)).toBe(false);
      }

      const passing = allCases.find((c) => c.name === 'passes normally');
      expect(passing).toBeDefined();
      expect(passing.status).toBe('passed');
      expect(passing.retryCount).toBe(0);

      const failing = allCases.find((c) => c.name === 'fails with a recognizable error message');
      expect(failing.status).toBe('failed');
      expect(failing.error).toContain('qualflare-playwright-integration-test-marker');
      // error.snippet is included but must be ANSI-stripped, or it renders as
      // escape soup in a web UI.
      // eslint-disable-next-line no-control-regex
      expect(failing.error).not.toMatch(/\[/);

      // A flaky test collapses into ONE case, not one per attempt.
      const flaky = allCases.filter((c) => c.name === 'is flaky and eventually passes');
      expect(flaky).toHaveLength(1);
      expect(flaky[0].status).toBe('passed');
      expect(flaky[0].retryCount).toBe(1);
      expect(flaky[0].isFlaky).toBe(true);

      // test.fail() declares a failure expected, so Playwright reports
      // outcome 'expected' — that is a PASS, with the error text kept.
      const expectedFailure = allCases.find((c) => c.name === 'fails on purpose and is therefore expected');
      expect(expectedFailure.status).toBe('passed');

      const skipped = allCases.find((c) => c.name === 'is skipped statically');
      expect(skipped.status).toBe('skipped');
      // The test after a skipped one still runs and is reported.
      expect(allCases.find((c) => c.name === 'runs after a skipped test').status).toBe('passed');

      // Attachment routing: the three paths behave differently on purpose.
      const browserCase = allCases.find((c) => c.name.startsWith('fails while a page is open'));
      expect(browserCase).toBeDefined();
      const byName = (n: string) => browserCase.attachments.find((a: { name: string }) => a.name === n);

      const screenshot = byName('screenshot');
      expect(screenshot.mimeType).toBe('image/png');
      expect(typeof screenshot.content).toBe('string'); // inline base64
      expect(screenshot.localVideoPath).toBeUndefined();

      const video = byName('video');
      expect(video.mimeType).toBe('video/webm');
      expect(video.content).toBeUndefined(); // never inlined
      expect(typeof video.localVideoPath).toBe('string');
      // localVideoPath is relative to the report file's own directory, and the
      // CLI is the only thing that uploads it — so the file must really exist.
      const videoPath = path.join(outputDir, video.localVideoPath);
      expect(fs.existsSync(videoPath)).toBe(true);
      expect(video.fileSize).toBe(fs.statSync(videoPath).size);
      // storageKey is the server's to assign; a reporter setting it would be
      // claiming an upload it never performed.
      expect(video.storageKey).toBeUndefined();

      // Traces are application/zip, which the upload endpoint's MIME
      // allowlist rejects — attaching one would produce a row pointing at
      // nothing. See docs/LIMITATIONS.md.
      const everyAttachmentName = allCases.flatMap((c) => (c.attachments ?? []).map((a: { name: string }) => a.name));
      expect(everyAttachmentName).not.toContain('trace');

      // The author-facing metadata API.
      const meta = allCases.find((c) => c.name.startsWith('exercises the author-facing metadata calls'));
      expect(meta.labels).toEqual([{ name: 'epic', value: 'Integration Testing' }]);
      expect(meta.links).toEqual([
        { type: 'issue', name: 'example issue', url: 'https://example.com/issue/1' },
      ]);
      expect(meta.priority).toBe('high');
      expect(meta.description).toContain('Exercises the qualflare.* metadata API');
      // Playwright's own @-tag from the title, plus qualflare.tag().
      expect(meta.tags).toEqual(expect.arrayContaining(['@smoke', 'qualflare-playwright-self-test']));
      // parameter() outside any step lands in Case.properties...
      expect(meta.properties['outside-step-param']).toBe('outside-value');
      // ...and inside qualflare.step() lands on that step.
      const manualStep = meta.steps.find((s: { name: string }) => s.name === 'a manual step');
      expect(manualStep.parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'inside-step-param', value: 'inside-value' })]),
      );
      // qualflare.step() delegates to test.step(), so it must appear exactly
      // once — not doubled by also synthesizing one from the runtime message.
      expect(meta.steps.filter((s: { name: string }) => s.name === 'a manual step')).toHaveLength(1);
      expect(meta.attachments).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'note', mimeType: 'text/plain' })]),
      );

      // Step nesting survives as parentIndex, which is what lets the server
      // rebuild the tree (case_run_steps.parent_id).
      const nested = allCases.flatMap((c) => c.steps ?? []).filter((s: { parentIndex?: number }) => s.parentIndex !== undefined);
      expect(nested.length).toBeGreaterThan(0);

      // pw:api steps are filtered out by default — one browser test emits
      // hundreds and they would bury everything legible.
      const apiSteps = allCases.flatMap((c) => c.steps ?? []).filter((s: { keyword?: string }) => s.keyword === 'pw:api');
      expect(apiSteps).toHaveLength(0);
    },
    180_000,
  );

  it(
    'converts Playwright’s 1-based --shard into a 0-based shardIndex, one report per shard',
    async () => {
      await runFixture(outputDir, ['--shard=1/2']);
      await runFixture(outputDir, ['--shard=2/2']);

      const reports = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
      // Both shards share one outputDir and must not overwrite each other —
      // that co-location is exactly what `qf collect <dir>` merges.
      expect(reports).toHaveLength(2);

      const shardIndices = reports
        .map((f) => readReport(outputDir, f))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((c: any) => c.suites.flatMap((s: any) => s.cases.map((tc: any) => tc.shardIndex)));

      // Playwright's --shard=1/2 is the FIRST shard; ours is 0-based, so this
      // must be {0,1} and never {1,2}.
      expect(new Set(shardIndices)).toEqual(new Set([0, 1]));
    },
    240_000,
  );

  it(
    'makes no network calls at all',
    async () => {
      // Asserted against the built bundle rather than a mock HTTP server.
      // Both sibling packages use a mock server for this, but theirs
      // implements POST /api/v1/attachments/upload-url — an endpoint the real
      // API did not serve, so the mock quietly asserted against a fiction.
      // Grepping the shipped bundle for call sites cannot drift that way.
      const bundles = ['dist/index.js', 'dist/reporter/index.js'].map((f) =>
        fs.readFileSync(path.join(repoRoot, f), 'utf8'),
      );
      for (const bundle of bundles) {
        expect(bundle).not.toMatch(/\bfetch\s*\(/);
        expect(bundle).not.toMatch(/require\(['"]node:https?['"]\)/);
        expect(bundle).not.toMatch(/from\s*['"]node:https?['"]/);
        expect(bundle).not.toMatch(/\bundici\b/);
      }
    },
    30_000,
  );
});
