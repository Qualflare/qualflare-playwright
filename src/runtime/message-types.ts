import type { CasePriority, LinkType, Parameter } from '../shared/types.js';

/**
 * `qualflare.*()` calls (see `qualflare-api.ts`) are fire-and-forget: each
 * one is serialized into one of these and shipped to the reporter process
 * via `test.info().attach(JSON.stringify(message), { contentType:
 * RESERVED_MESSAGE_MEDIA_TYPE })` — the only channel Playwright gives test
 * code back to a running reporter (see `shared/constants.ts`'s
 * `RESERVED_MESSAGE_MEDIA_TYPE` doc comment). There is no client-side
 * accumulator/buffer the way `@qualflare/cypress` has (`TestMetadataBuffer`)
 * — all accumulation happens reporter-side, in `reporter/case-builder.ts`'s
 * `replayMetadata`, which reads them off the attempt's own attachment list.
 */
export type RuntimeMessage =
  | { type: 'label'; name: string; value: string }
  | { type: 'link'; url: string; linkType?: LinkType; name?: string }
  | { type: 'tag'; tags: string[] }
  | { type: 'description'; text: string }
  | { type: 'priority'; value: CasePriority }
  | { type: 'parameter'; name: string; value?: string; masked?: boolean }
  | { type: 'attachment'; name: string; contentBase64: string; mimeType?: string }
  | { type: 'attachment_from_file'; name: string; path: string; mimeType?: string }
  | { type: 'step_start'; name: string; timestamp: number }
  | { type: 'step_stop'; status: 'passed' | 'failed'; error?: string; timestamp: number };

/** One `qualflare.step()` call, fully resolved (both `step_start` and
 * `step_stop` messages applied) — mirrors `@qualflare/cypress`'s
 * `ManualStepRecord` shape for cross-package consistency. Timing here is
 * EXACT (real `Date.now()` deltas around an `await`ed step body), unlike
 * Cypress's documented approximation. */
export interface ManualStepRecord {
  name: string;
  status: 'passed' | 'failed';
  error?: string;
  parentIndex?: number;
  parameters?: Parameter[];
  startedAt: number;
  durationMs?: number;
}
