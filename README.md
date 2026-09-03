# @qualflare/playwright

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fplaywright.svg)](https://www.npmjs.com/package/@qualflare/playwright)
[![CI](https://github.com/Qualflare/qualflare-playwright/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-playwright/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

A native Playwright reporter for [Qualflare](https://qualflare.com) — captures test results directly
from your `playwright test` run: status, per-attempt retry history and flakiness, nested
`test.step()` trees,
screenshots, videos, traces, and author-facing metadata (labels, links, tags, priority, custom attachments).

The reporter itself makes **no network calls**. It writes a report directory, and
[`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) uploads it — which is what lets any
number of sharded CI jobs merge into a single Launch.

## Install

```sh
npm install --save-dev @qualflare/playwright
```

Requires `@playwright/test` `>=1.40.0` (installed separately as a peer dependency) and Node `>=18`
(Playwright 1.62+ itself requires Node `>=20`). You also need
[`@qualflare/cli`](https://github.com/Qualflare/qualflare-cli) **v0.1.17 or newer** to upload what
this reporter writes.

The peer range is deliberately open-ended rather than capped at a known-good version, so a new
Playwright release never hard-blocks `npm install` for you. 1.40, 1.50 and 1.62 are exercised in CI
against a real `playwright test` run; newer versions are untested but not refused — please
[open an issue](https://github.com/Qualflare/qualflare-playwright/issues) if one misbehaves.

## Quickstart

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { qualflareReporter } from '@qualflare/playwright';

export default defineConfig({
  reporter: [['list'], qualflareReporter({ environment: 'staging' })],
});
```

`qualflareReporter()` is a typed helper. Playwright types reporter options as `any`, so the
hand-written tuple form silently accepts typos — but it works too, if you prefer it:

```ts
reporter: [['list'], ['@qualflare/playwright/reporter', { environment: 'staging' }]],
```

Then run your tests and upload the results — two steps, and no token needed for the first:

```sh
# 1. Run. Writes ./qualflare-results (JSON + any videos). Zero network calls.
npx playwright test

# 2. Upload. `qf login <identifier> <token>` stores the credential once.
qf <your-project-identifier> collect ./qualflare-results
```

### Sharded CI

Point every shard at the **same** `outputDir` and collect once at the end. Each process writes its
own uniquely-named file, so shards never overwrite each other, and `qf collect` merges every file in
the directory into a single Launch:

```sh
# in each parallel job — all writing to the same directory
npx playwright test --shard="$SHARD_INDEX/$SHARD_TOTAL"

# once, after all shards finish (e.g. with the directory restored from CI artifacts)
qf <your-project-identifier> collect ./qualflare-results
```

Nothing needs configuring for this: Playwright hands reporters its own `--shard` value, so each
case is stamped with the shard that ran it automatically. (Playwright's shard index is 1-based and
Qualflare's is 0-based; the conversion is handled for you.)

## Enriching your tests

```ts
import { test, expect } from '@playwright/test';
import { qualflare } from '@qualflare/playwright';

test('a user can check out @smoke', async ({ page }) => {
  qualflare.label('epic', 'Billing');
  qualflare.link('https://tracker.example/QF-42', { type: 'issue', name: 'QF-42' });
  qualflare.priority('high');

  await qualflare.step('add an item to the cart', async () => {
    qualflare.parameter('sku', 'BOOK-1');
    await page.getByRole('button', { name: 'Add' }).click();
  });

  await expect(page.getByTestId('total')).toHaveText('10.00');
});
```

`qualflare.step()` delegates to Playwright's own `test.step()`, so your steps appear in the
Playwright HTML report and trace viewer as well as in Qualflare. Full reference in
[`docs/METADATA-API.md`](./docs/METADATA-API.md).

## Configuration

Every option has an environment-variable override, and everything has a sensible default — see
[`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md). There is no `token` option: this reporter makes
no requests, so it has no credential.

One option is worth calling out because it fails late: `environment` is matched against the
environment's **uid (slug)**, not its display name, so **Staging** in the UI is `staging` here. A
wrong value cannot fail at test time — the reporter makes no requests — so the run succeeds and
`collect` 404s afterwards. See
[the note in the configuration docs](./docs/CONFIGURATION.md#environment-is-matched-by-uid-not-display-name).

## Known limitations

- **Traces need `--upload-artifacts=trace` at collect time.** The zip is copied into `outputDir`,
  but `qf collect` uploads no heavy artifact unless asked — pass `--upload-artifacts=trace` (or
  `video,trace`). Needs `@qualflare/cli` v0.1.20+; older CLIs ignore it.
- **`pw:api` and `fixture` steps are filtered out by default** (`includeApiSteps`) — a single
  browser test emits hundreds, which buries the steps you actually wrote. A *failed* one is always
  kept.
- **A stale `outputDir` is refused, not merged** — each report carries a `runId`, and `qf collect`
  errors rather than merging files from two different runs. Needs `@qualflare/cli` v0.1.19+; older
  CLIs merge as before.
- **`merge-reports` mode is not supported** — use the `outputDir` flow above rather than
  Playwright's `blob` reporter.
- **Playwright-native `tag` needs 1.42+** while the peer floor is 1.40 — on 1.40/1.41 the
  native tag array is not read; `qualflare.tag()` works throughout.
- **`parameter()` outside a step is not masked** — `masked` is a display hint for the UI; the
  server never redacts the value, so never put a real secret in one. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md#parameter-outside-a-step-has-no-masking).
- **Attachment caps are two budgets, not one pool** — `maxAttachmentBytes` bounds a single
  attachment and `maxTotalAttachmentBytes` the whole run; anything over either is dropped
  outright rather than truncated. Raising them is the easiest way to push a request past
  `/collect`'s body limit. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md#per-case-and-per-attachment-caps-are-independent-not-pooled).
- **Retries carry per-attempt errors, but everything else is the final attempt** — `Case.attempts`
  records each attempt's status, duration and error; steps, labels, links, tags, priority,
  properties and attachments come from the last attempt only, so an abandoned attempt's step trace
  is discarded rather than replayed alongside the final one.

Full details in [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Development

```sh
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm run build            # tsup -> dist/ (ESM + CJS + d.ts)
npm test                 # unit tests
npm run test:integration # spawns a REAL `playwright test` against test/integration/fixtures/
```

The integration suite loads the reporter from the built `dist/`, not `src/`, so it exercises the
real package `exports` map — run `npm run build` first.

## License

Apache-2.0
