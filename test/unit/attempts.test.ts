import { describe, expect, it } from 'vitest';

import { buildAttempts } from '../../src/reporter/case-builder.js';
import { MAX_ATTEMPTS_PER_CASE } from '../../src/shared/constants.js';

/** Minimal TestResult-shaped fake. buildAttempts reads only these fields;
 * constructing a real TestResult would test nothing extra and would break on
 * every Playwright minor. */
function result(
  opts: {
    status?: string;
    duration?: number;
    startTime?: Date;
    error?: { message?: string; value?: string; stack?: string; snippet?: string; location?: { line: number } };
    stdout?: (string | Buffer)[];
    stderr?: (string | Buffer)[];
    retry?: number;
  } = {},
) {
  return {
    status: opts.status ?? 'passed',
    duration: opts.duration ?? 1,
    startTime: opts.startTime ?? new Date(0),
    error: opts.error,
    errors: opts.error ? [opts.error] : [],
    stdout: opts.stdout ?? [],
    stderr: opts.stderr ?? [],
    retry: opts.retry ?? 0,
    workerIndex: 0,
    parallelIndex: 0,
    attachments: [],
    steps: [],
    annotations: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake, see above
  } as any;
}

// Written as an explicit \u001b rather than a literal control byte: a literal
// one is invisible in review and can be stripped by tooling or a copy-paste,
// which would leave the ANSI test below passing against input containing no
// ANSI at all — green, and proving nothing.
const ESC = '\u001b';

describe('buildAttempts', () => {
  // A test that ran once has no history: its status, duration and error are
  // already on the Case. The server discards a one-element array, so sending
  // one is payload spent against the 10MB body limit for a row it drops.
  it('sends nothing for a test that was not retried', () => {
    expect(buildAttempts([result()])).toBeUndefined();
    expect(buildAttempts([])).toBeUndefined();
  });

  it('numbers attempts 1..N and keeps them in execution order', () => {
    const attempts = buildAttempts([
      result({ status: 'failed', duration: 10 }),
      result({ status: 'failed', duration: 20 }),
      result({ status: 'passed', duration: 30 }),
    ]);

    expect(attempts).toHaveLength(3);
    expect(attempts!.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(attempts!.map((a) => a.status)).toEqual(['failed', 'failed', 'passed']);
    // Nanoseconds on the wire, milliseconds from Playwright.
    expect(attempts!.map((a) => a.duration)).toEqual([10_000_000, 20_000_000, 30_000_000]);
  });

  // The final attempt must be present. The server overwrites its status and
  // duration from the Case, but keeps its message/trace — so omitting it loses
  // the error text of the execution that actually counted.
  it('includes the final attempt, not just the failed ones', () => {
    const attempts = buildAttempts([result({ status: 'failed' }), result({ status: 'passed' })]);
    expect(attempts).toHaveLength(2);
    expect(attempts![1]!.status).toBe('passed');
  });

  // Playwright's statuses are not the wire's. timedOut/interrupted in
  // particular have dedicated wire values rather than collapsing to failed.
  it('maps every Playwright status onto the wire vocabulary', () => {
    const attempts = buildAttempts([
      result({ status: 'timedOut' }),
      result({ status: 'interrupted' }),
      result({ status: 'skipped' }),
      result({ status: 'passed' }),
    ]);
    expect(attempts!.map((a) => a.status)).toEqual(['timeout', 'aborted', 'skipped', 'passed']);
  });

  it('splits the error into message, trace, snippet and line', () => {
    const attempts = buildAttempts([
      result({
        status: 'failed',
        error: {
          message: 'expected true to be false',
          stack: 'Error: expected true\n    at spec.ts:42:5',
          snippet: '> 42 |   expect(x).toBe(y)',
          location: { line: 42 },
        },
      }),
      result({ status: 'passed' }),
    ]);

    const first = attempts![0]!;
    expect(first.message).toBe('expected true to be false');
    expect(first.trace).toContain('at spec.ts:42:5');
    expect(first.snippet).toContain('expect(x).toBe(y)');
    expect(first.line).toBe(42);
    // The passing attempt carries no error fields at all.
    expect(attempts![1]!.message).toBeUndefined();
    expect(attempts![1]!.trace).toBeUndefined();
  });

  // A non-Error throw populates `value` instead of `message`.
  it('falls back to the thrown value when there is no message', () => {
    const attempts = buildAttempts([result({ status: 'failed', error: { value: 'boom' } }), result()]);
    expect(attempts![0]!.message).toBe('boom');
  });

  it('strips ANSI from every error field', () => {
    const attempts = buildAttempts([
      result({
        status: 'failed',
        error: {
          message: `${ESC}[31mred failure${ESC}[39m`,
          stack: `${ESC}[2mat spec.ts${ESC}[22m`,
        },
      }),
      result(),
    ]);
    expect(attempts![0]!.message).toBe('red failure');
    expect(attempts![0]!.trace).toBe('at spec.ts');
  });

  // Playwright flushes stdout in arbitrary chunks, so an entry may hold many
  // lines or part of one. The server caps at 200 LINES, so those have to be
  // real lines rather than flush boundaries.
  it('splits captured output into one entry per line, not per chunk', () => {
    const attempts = buildAttempts([
      result({ status: 'failed', stdout: ['one\ntwo\n', 'three\n'], stderr: [Buffer.from('warn\n')] }),
      result(),
    ]);
    expect(attempts![0]!.stdout).toEqual(['one', 'two', 'three']);
    expect(attempts![0]!.stderr).toEqual(['warn']);
  });

  it('omits captured output entirely when there is none', () => {
    const attempts = buildAttempts([result({ status: 'failed' }), result()]);
    expect(attempts![0]!.stdout).toBeUndefined();
    expect(attempts![0]!.stderr).toBeUndefined();
  });

  // Over the cap the server keeps the first 49 plus the final one. Trimming the
  // same way here means the bytes are never sent — and, more importantly, that
  // the FINAL attempt survives, which a plain slice(0, 50) would drop.
  it('caps at the server limit while preserving the final attempt', () => {
    const results = [
      ...Array.from({ length: 60 }, () => result({ status: 'failed' })),
      result({ status: 'passed', duration: 999 }),
    ];
    const attempts = buildAttempts(results)!;

    expect(attempts).toHaveLength(MAX_ATTEMPTS_PER_CASE);
    expect(attempts[attempts.length - 1]!.status).toBe('passed');
    expect(attempts[attempts.length - 1]!.duration).toBe(999_000_000);
    // Still contiguous from 1, so the server does not read the trim as a hole.
    expect(attempts.map((a) => a.attempt)).toEqual(
      Array.from({ length: MAX_ATTEMPTS_PER_CASE }, (_, i) => i + 1),
    );
  });

  it('records when each attempt started', () => {
    const attempts = buildAttempts([
      result({ status: 'failed', startTime: new Date('2026-09-02T10:00:00.000Z') }),
      result({ status: 'passed', startTime: new Date('2026-09-02T10:00:05.000Z') }),
    ]);
    expect(attempts![0]!.startedAt).toBe('2026-09-02T10:00:00.000Z');
    expect(attempts![1]!.startedAt).toBe('2026-09-02T10:00:05.000Z');
  });
});
