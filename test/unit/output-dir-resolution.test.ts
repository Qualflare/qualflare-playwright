import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import QualflareReporter from '../../src/reporter/reporter.js';

/**
 * A relative `outputDir` resolves against the Playwright CONFIG's directory,
 * not the shell's cwd — and it must resolve to the SAME place for the report
 * and for every artifact beside it.
 *
 * This is a regression test. `resolveOutputDir` was applied only where the JSON
 * was written; the video, trace and screenshot writers each took the raw config
 * string, which resolves against the cwd. Running
 * `playwright test --config e2e/playwright.config.ts` from a repo root with
 * `outputDir: '../e2e-results'` put the report inside the repo and every
 * artifact one directory ABOVE it, leaving localVideoPath / localImagePath
 * pointing at files the CLI cannot find. Nothing failed; the report just
 * referenced absent files.
 *
 * The existing integration suites could not catch it: they pass an ABSOLUTE
 * mkdtempSync path, where both resolutions agree.
 */
describe('outputDir resolution', () => {
  const begin = (reporter: QualflareReporter, rootDir: string) => {
    (reporter as never as { rootDir: string }).rootDir = rootDir;
    reporter.onBegin({ rootDir, projects: [], shard: null } as never, { suites: [] } as never);
    return (reporter as never as { config: { outputDir: string } }).config.outputDir;
  };

  it('resolves a relative outputDir against the config directory, not the cwd', () => {
    const configDir = '/repo/e2e';
    const reporter = new QualflareReporter({ outputDir: '../e2e-results', configDir });
    expect(begin(reporter, '/repo')).toBe(path.resolve(configDir, '../e2e-results'));
  });

  it('leaves an absolute outputDir alone', () => {
    const reporter = new QualflareReporter({ outputDir: '/tmp/somewhere', configDir: '/repo/e2e' });
    expect(begin(reporter, '/repo')).toBe('/tmp/somewhere');
  });

  it('falls back to rootDir when no configDir was supplied', () => {
    const reporter = new QualflareReporter({ outputDir: './out' });
    expect(begin(reporter, '/repo')).toBe(path.resolve('/repo', './out'));
  });

  it('resolves once, so a second pass is a no-op', () => {
    // The bug was two resolutions disagreeing. Whatever else changes, resolving
    // an already-resolved value must not move it.
    const reporter = new QualflareReporter({ outputDir: '../e2e-results', configDir: '/repo/e2e' });
    const once = begin(reporter, '/repo');
    expect(path.resolve(once)).toBe(once);
    expect(path.isAbsolute(once)).toBe(true);
  });
});
