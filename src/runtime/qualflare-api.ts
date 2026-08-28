import { test } from '@playwright/test';

import { RESERVED_MESSAGE_MEDIA_TYPE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { CasePriority, LinkType } from '../shared/types.js';
import type { RuntimeMessage } from './message-types.js';

/**
 * Ships one structured message from the test process to the reporter.
 *
 * Playwright runs tests in worker processes and reporters in the main
 * process, with no shared memory — the only user-reachable channel back is
 * `testInfo.attach()`. So every `qualflare.*()` call is serialized and
 * attached under a reserved content type; the reporter recognizes that exact
 * type in `onTestEnd`, replays it as a model mutation, and excludes it from
 * real attachment processing. Same trick `@qualflare/cucumberjs` plays with
 * `World.attach()`, for the same reason.
 *
 * `test.info()` throws when called outside a running test (module scope, a
 * `globalSetup`, a stray import). Warn and drop: a metadata call is never
 * worth failing somebody's suite over.
 */
function send(message: RuntimeMessage): void {
  try {
    void test.info().attach(`qualflare:${message.type}`, {
      body: Buffer.from(JSON.stringify(message), 'utf8'),
      contentType: RESERVED_MESSAGE_MEDIA_TYPE,
    });
  } catch {
    logger.warn(`qualflare.${message.type}() was called outside a running test; the call was ignored.`);
  }
}

/**
 * Author-facing metadata API. Import it in a spec and annotate tests with
 * business context Playwright itself has no concept of:
 *
 * ```ts
 * import { qualflare } from '@qualflare/playwright';
 *
 * test('checks out', async ({ page }) => {
 *   qualflare.label('epic', 'Billing');
 *   qualflare.link('https://tracker/QF-1', { type: 'issue', name: 'QF-1' });
 *   await qualflare.step('pay', async () => { ... });
 * });
 * ```
 */
export const qualflare = {
  /** Arbitrary name/value metadata (epic, feature, story, owner, severity). */
  label(name: string, value: string): void {
    send({ type: 'label', name, value });
  },

  /** A typed external reference. `type` defaults to `custom`. */
  link(url: string, opts?: { type?: LinkType; name?: string }): void {
    send({ type: 'link', url, linkType: opts?.type, name: opts?.name });
  },

  /** One or more free-text tags. */
  tag(...tags: string[]): void {
    send({ type: 'tag', tags });
  },

  /** Markdown description shown on the case. */
  description(text: string): void {
    send({ type: 'description', text });
  },

  /** Case priority (low | medium | high | critical). */
  priority(value: CasePriority): void {
    send({ type: 'priority', value });
  },

  /** A named input. Inside an open `step()` it attaches to that step;
   * outside any step it lands in the case's properties. `masked` is a
   * display hint for the UI only — the server does not redact the value. */
  parameter(name: string, value?: string, opts?: { masked?: boolean }): void {
    send({ type: 'parameter', name, value, masked: opts?.masked });
  },

  /** Attach in-memory content. */
  attachment(name: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; mimeType?: string }): void {
    const contentBase64 = opts?.encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
    send({ type: 'attachment', name, contentBase64, mimeType: opts?.mimeType });
  },

  /** Attach a file from disk. */
  attachmentFromFile(name: string, path: string, opts?: { mimeType?: string }): void {
    send({ type: 'attachment_from_file', name, path, mimeType: opts?.mimeType });
  },

  /**
   * Records a named step around `fn`.
   *
   * Unlike the cucumber-js equivalent, this delegates to Playwright's own
   * `test.step()` as well, so the step shows up in Playwright's HTML report
   * and trace viewer in addition to Qualflare — there is no reason to make
   * users choose, and a step that exists in only one of the two is a
   * confusing thing to debug against.
   */
  async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    return test.step(name, async () => {
      send({ type: 'step_start', name, timestamp: Date.now() });
      try {
        const result = await fn();
        send({ type: 'step_stop', status: 'passed', timestamp: Date.now() });
        return result;
      } catch (err) {
        send({
          type: 'step_stop',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
        throw err;
      }
    });
  },
};
