import type { TestStep } from '@playwright/test/reporter';

import { MAX_STEPS_PER_TEST_ATTEMPT } from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import { logger } from '../shared/logger.js';
import type { Step } from '../shared/types.js';

/** Playwright's built-in step categories, as of 1.62. `category` is typed as
 * a plain `string`, not a union — third-party integrations add their own — so
 * nothing here may switch exhaustively on it. */
const CATEGORY_TEST_STEP = 'test.step';
const CATEGORY_EXPECT = 'expect';
const CATEGORY_HOOK = 'hook';
const CATEGORY_FIXTURE = 'fixture';
const CATEGORY_PW_API = 'pw:api';

/** Depth beyond which nesting is flattened rather than followed.
 *
 * Playwright imposes no nesting limit: a `test.step()` inside a `test.step()`
 * around a `page.getByRole().click()` already reaches three levels before any
 * user intent, and a recursive helper can go arbitrarily deep. Real suites sit
 * at 3-6, so this is a runaway guard, not a product limit — steps past it are
 * still reported, just re-parented to the deepest ancestor within the cap
 * rather than dropped, since losing a failing assertion to a depth rule would
 * be far worse than showing it one level too shallow. */
const MAX_STEP_DEPTH = 10;

/** True when a step is worth reporting at all.
 *
 * `pw:api` is excluded by default and this is the single most important
 * filter in the mapper: one `page.goto()` plus a handful of assertions can
 * emit hundreds of `pw:api` steps, which would bury the user-authored
 * `test.step()` boundaries and exhaust MAX_STEPS_PER_TEST_ATTEMPT on noise
 * long before reaching anything a human wants to read.
 *
 * A step that FAILED is always kept, whatever its category — the failing
 * `pw:api` call is usually the single most useful line in the whole trace,
 * and dropping it to a volume heuristic would defeat the point of reporting
 * steps at all. */
function isReportable(step: TestStep, includeApiSteps: boolean): boolean {
  if (step.error) {
    return true;
  }
  switch (step.category) {
    case CATEGORY_TEST_STEP:
    case CATEGORY_EXPECT:
    case CATEGORY_HOOK:
    case CATEGORY_FIXTURE:
      return true;
    case CATEGORY_PW_API:
      return includeApiSteps;
    default:
      // An unrecognized category is most likely a third-party integration's
      // own step (Playwright allows any string). Keep it: an unknown step is
      // more likely signal than the `pw:api` firehose this filter exists for.
      return true;
  }
}

/** `file:line`, relative paths left as Playwright reports them. */
function formatLocation(step: TestStep): string | undefined {
  if (!step.location) {
    return undefined;
  }
  return `${step.location.file}:${step.location.line}`;
}

/**
 * Flattens Playwright's nested `TestStep` tree into the wire format's flat
 * `Step[]`, preserving the shape via `parentIndex` (a 0-based index into the
 * same array). The server reconstructs the tree from that — see
 * `ResolveStepParents` in api-service, which drops out-of-range or cyclic
 * values rather than rejecting the case.
 *
 * Read the tree in `onTestEnd`, never in `onStepBegin`/`onStepEnd`: Playwright
 * MUTATES the same step object when a step finishes (`step.duration` and
 * `step.error` are assigned in place), so anything captured at begin-time is a
 * live reference whose duration is still unset.
 */
export function mapSteps(steps: readonly TestStep[], includeApiSteps: boolean): Step[] {
  const out: Step[] = [];
  let capWarned = false;

  const walk = (nodes: readonly TestStep[], parentIndex: number | undefined, depth: number): void => {
    for (const node of nodes) {
      if (!isReportable(node, includeApiSteps)) {
        // Skipped, but still descend: a filtered-out `pw:api` wrapper can
        // contain a reportable child (an assertion, or anything that failed).
        // Those children re-parent to this node's own parent, which keeps the
        // tree connected instead of orphaning them at the root.
        walk(node.steps, parentIndex, depth);
        continue;
      }

      if (out.length >= MAX_STEPS_PER_TEST_ATTEMPT) {
        if (!capWarned) {
          capWarned = true;
          logger.warn(
            `a test produced more than ${MAX_STEPS_PER_TEST_ATTEMPT} reportable steps; the rest were dropped. ` +
              'Set `includeApiSteps: false` (the default) or reduce step nesting if this is unexpected.',
          );
        }
        return;
      }

      const index = out.length;
      out.push({
        name: node.title,
        keyword: node.category,
        status: node.error ? 'failed' : 'passed',
        duration: msToNs(node.duration),
        ...(node.error ? { error: formatStepError(node) } : {}),
        ...(formatLocation(node) ? { location: formatLocation(node) } : {}),
        ...(parentIndex !== undefined ? { parentIndex } : {}),
      });

      // Past the depth cap, keep reporting but stop deepening: children are
      // attached to the last in-cap ancestor rather than dropped.
      const nextParent = depth + 1 >= MAX_STEP_DEPTH ? parentIndex : index;
      walk(node.steps, nextParent, depth + 1);
    }
  };

  walk(steps, undefined, 0);
  return out;
}

/** Playwright's step errors carry the same shape as test errors; `message`
 * is set for thrown Errors and `value` for non-Error throws (`throw 'x'`). */
function formatStepError(step: TestStep): string {
  const err = step.error;
  if (!err) {
    return '';
  }
  return err.message ?? err.value ?? 'step failed';
}
