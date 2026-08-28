import { describe, expect, it } from 'vitest';

import { mapSteps } from '../../src/reporter/step-mapper.js';

/** Minimal TestStep-shaped fake. Playwright's real type carries far more, but
 * mapSteps only reads these — building a full TestStep would test nothing
 * extra and would break on every Playwright minor. */
function step(
  title: string,
  opts: {
    category?: string;
    duration?: number;
    error?: { message?: string; value?: string };
    location?: { file: string; line: number; column: number };
    steps?: ReturnType<typeof step>[];
  } = {},
) {
  return {
    title,
    category: opts.category ?? 'test.step',
    startTime: new Date(0),
    duration: opts.duration ?? 1,
    error: opts.error,
    location: opts.location,
    steps: opts.steps ?? [],
    annotations: [],
    attachments: [],
    parent: undefined,
    titlePath: () => [title],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake, see above
  } as any;
}

describe('mapSteps', () => {
  it('flattens a nested tree into parentIndex references', () => {
    const out = mapSteps([step('outer', { steps: [step('inner', { steps: [step('deepest')] })] })], false);

    expect(out.map((s) => s.name)).toEqual(['outer', 'inner', 'deepest']);
    expect(out[0]!.parentIndex).toBeUndefined(); // root
    expect(out[1]!.parentIndex).toBe(0);
    expect(out[2]!.parentIndex).toBe(1);
  });

  it('converts milliseconds to nanoseconds', () => {
    const out = mapSteps([step('a', { duration: 5 })], false);
    expect(out[0]!.duration).toBe(5_000_000);
  });

  it('marks only errored steps failed, and carries the message', () => {
    const out = mapSteps([step('ok'), step('boom', { error: { message: 'it broke' } })], false);
    expect(out[0]!.status).toBe('passed');
    expect(out[1]!.status).toBe('failed');
    expect(out[1]!.error).toBe('it broke');
  });

  it('uses error.value when a non-Error was thrown', () => {
    const out = mapSteps([step('boom', { error: { value: 'a bare string' } })], false);
    expect(out[0]!.error).toBe('a bare string');
  });

  it('records category as keyword and location as file:line', () => {
    const out = mapSteps([step('a', { category: 'expect', location: { file: 'a.spec.ts', line: 12, column: 3 } })], false);
    expect(out[0]!.keyword).toBe('expect');
    expect(out[0]!.location).toBe('a.spec.ts:12');
  });

  describe('pw:api filtering', () => {
    it('drops pw:api steps by default', () => {
      const out = mapSteps([step('click', { category: 'pw:api' }), step('mine')], false);
      expect(out.map((s) => s.name)).toEqual(['mine']);
    });

    it('includes them when asked', () => {
      const out = mapSteps([step('click', { category: 'pw:api' }), step('mine')], true);
      expect(out.map((s) => s.name)).toEqual(['click', 'mine']);
    });

    it('ALWAYS keeps a failed pw:api step — the failing call is the useful one', () => {
      const out = mapSteps([step('click', { category: 'pw:api', error: { message: 'no such element' } })], false);
      expect(out.map((s) => s.name)).toEqual(['click']);
      expect(out[0]!.status).toBe('failed');
    });

    it('re-parents a filtered step’s children instead of orphaning them', () => {
      // A dropped pw:api wrapper must not detach the reportable step inside
      // it, or the tree silently loses a branch.
      const out = mapSteps(
        [step('kept', { steps: [step('dropped', { category: 'pw:api', steps: [step('grandchild')] })] })],
        false,
      );
      expect(out.map((s) => s.name)).toEqual(['kept', 'grandchild']);
      expect(out[1]!.parentIndex).toBe(0);
    });
  });

  it('keeps steps from unknown categories — an unrecognized one is likely signal', () => {
    const out = mapSteps([step('third-party thing', { category: 'someplugin:thing' })], false);
    expect(out).toHaveLength(1);
  });

  it('caps runaway step counts rather than blowing the server limit', () => {
    const many = Array.from({ length: 500 }, (_, i) => step(`s${i}`));
    const out = mapSteps(many, false);
    expect(out.length).toBe(300); // MAX_STEPS_PER_TEST_ATTEMPT
  });

  it('stops deepening past the depth cap but still reports the steps', () => {
    // Build a 15-deep chain; nesting is unbounded in Playwright, so this is a
    // runaway guard. Nothing may be dropped for being deep.
    let leaf = step('d14');
    for (let i = 13; i >= 0; i -= 1) {
      leaf = step(`d${i}`, { steps: [leaf] });
    }
    const out = mapSteps([leaf], false);
    expect(out).toHaveLength(15);
    // Beyond the cap, parents flatten onto the deepest in-cap ancestor
    // instead of continuing to nest.
    const deepest = out[out.length - 1]!;
    expect(deepest.parentIndex).toBeLessThan(out.length - 1);
  });
});

describe('fixture-step filtering', () => {
  it('drops fixture steps by default — they are runner internals', () => {
    const out = mapSteps(
      [step('Fixture "page"', { category: 'fixture' }), step('my step')],
      false,
    );
    expect(out.map((s) => s.name)).toEqual(['my step']);
  });

  it('keeps a FAILED fixture — a fixture that throws is a real failure', () => {
    const out = mapSteps([step('Fixture "page"', { category: 'fixture', error: { message: 'setup blew up' } })], false);
    expect(out.map((s) => s.name)).toEqual(['Fixture "page"']);
    expect(out[0]!.status).toBe('failed');
  });

  it('keeps hook steps, which are user-authored', () => {
    const out = mapSteps([step('beforeEach hook', { category: 'hook' })], false);
    expect(out).toHaveLength(1);
  });
});
