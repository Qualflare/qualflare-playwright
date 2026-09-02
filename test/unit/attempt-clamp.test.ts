import { describe, expect, it } from 'vitest';

import { buildAttempts } from '../../src/reporter/case-builder.js';
import {
  MAX_ATTEMPT_MESSAGE_RUNES,
  MAX_ATTEMPT_OUTPUT_LINES,
  MAX_ATTEMPT_OUTPUT_RUNES,
  MAX_ATTEMPT_SNIPPET_RUNES,
  MAX_ATTEMPT_TRACE_RUNES,
} from '../../src/shared/constants.js';
import { clampOutputLines, truncateRunes } from '../../src/shared/text.js';

function result(opts: Record<string, unknown> = {}) {
  return {
    status: 'failed',
    duration: 1,
    startTime: new Date(0),
    errors: [],
    stdout: [],
    stderr: [],
    retry: 0,
    workerIndex: 0,
    parallelIndex: 0,
    attachments: [],
    steps: [],
    annotations: [],
    ...opts,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
  } as any;
}

const runes = (s: string) => Array.from(s).length;

describe('truncateRunes', () => {
  it('leaves a string that already fits untouched', () => {
    expect(truncateRunes('short', 100)).toBe('short');
  });

  it('truncates to the rune count, not the UTF-16 length', () => {
    expect(runes(truncateRunes('x'.repeat(500), 100))).toBe(100);
  });

  // The reason this helper exists rather than a plain slice(). An emoji is one
  // rune but two UTF-16 code units, so `s.slice(0, n)` both over-counts and can
  // cut a surrogate pair in half, putting a lone surrogate on the wire. Test
  // output contains emoji routinely (✅/❌ in assertion messages).
  it('never splits a surrogate pair', () => {
    const emoji = '🎭'.repeat(50);
    const out = truncateRunes(emoji, 10);

    expect(runes(out)).toBe(10);
    expect(out).toBe('🎭'.repeat(10));
    // A naive slice would have produced a lone surrogate here.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('clampOutputLines', () => {
  it('caps the line count', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    expect(clampOutputLines(lines, MAX_ATTEMPT_OUTPUT_LINES, 10_000_000)).toHaveLength(
      MAX_ATTEMPT_OUTPUT_LINES,
    );
  });

  it('caps the total runes across lines, not just per line', () => {
    const lines = Array.from({ length: 100 }, () => 'x'.repeat(100));
    const out = clampOutputLines(lines, MAX_ATTEMPT_OUTPUT_LINES, 500)!;
    const total = out.reduce((n, l) => n + runes(l) + 1, 0);
    expect(total).toBeLessThanOrEqual(500);
  });

  // A truncated final line of a stack trace is worth more than no line.
  it('keeps a partial final line rather than dropping it whole', () => {
    const out = clampOutputLines(['x'.repeat(100)], 200, 40)!;
    expect(out).toHaveLength(1);
    expect(runes(out[0]!)).toBe(39);
  });

  it('returns undefined when nothing survives', () => {
    expect(clampOutputLines([], 200, 100)).toBeUndefined();
  });
});

describe('buildAttempts payload bounds', () => {
  // The regression this whole change exists for. Measured before clamping: one
  // retried test with a deep stack and a chatty log serialized to ~630KB, against
  // a 10MB request body limit that loses the ENTIRE launch once exceeded — and
  // most of those bytes were text the server discards on write anyway.
  it('keeps a pathological retried test far under the body limit', () => {
    const chatty = Array.from({ length: 5000 }, (_, i) => `[log] iteration ${i} of a very chatty test`);
    const attempts = buildAttempts([
      result({
        error: {
          message: 'm'.repeat(20_000),
          stack: 's'.repeat(200_000),
          snippet: 'p'.repeat(10_000),
        },
        stdout: [chatty.join('\n') + '\n'],
        stderr: [chatty.join('\n') + '\n'],
      }),
      result({ status: 'passed' }),
    ])!;

    const bytes = Buffer.byteLength(JSON.stringify(attempts));
    // Unclamped this was ~630_000. The bound below is deliberately generous —
    // the point is the order of magnitude, not a byte-exact figure that would
    // churn whenever a cap moves.
    expect(bytes).toBeLessThan(120_000);

    const first = attempts[0]!;
    expect(runes(first.message!)).toBe(MAX_ATTEMPT_MESSAGE_RUNES);
    expect(runes(first.trace!)).toBe(MAX_ATTEMPT_TRACE_RUNES);
    expect(runes(first.snippet!)).toBe(MAX_ATTEMPT_SNIPPET_RUNES);
    expect(first.stdout!.length).toBeLessThanOrEqual(MAX_ATTEMPT_OUTPUT_LINES);
    expect(first.stderr!.length).toBeLessThanOrEqual(MAX_ATTEMPT_OUTPUT_LINES);

    // The line cap alone is not enough: 200 lines of a megabyte each would
    // still blow the body limit, so the rune budget has to hold too.
    for (const stream of [first.stdout!, first.stderr!]) {
      const total = stream.reduce((n, l) => n + runes(l) + 1, 0);
      expect(total).toBeLessThanOrEqual(MAX_ATTEMPT_OUTPUT_RUNES);
    }
  });

  it('leaves normal-sized errors and output completely untouched', () => {
    const attempts = buildAttempts([
      result({
        error: { message: 'expected true to be false', stack: 'at spec.ts:42:5' },
        stdout: ['one\ntwo\n'],
      }),
      result({ status: 'passed' }),
    ])!;

    expect(attempts[0]!.message).toBe('expected true to be false');
    expect(attempts[0]!.trace).toBe('at spec.ts:42:5');
    expect(attempts[0]!.stdout).toEqual(['one', 'two']);
  });
});
