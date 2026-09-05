# @qualflare/playwright

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fplaywright.svg)](https://www.npmjs.com/package/@qualflare/playwright)
[![CI](https://github.com/Qualflare/qualflare-playwright/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-playwright/actions/workflows/ci.yml)
[![Qualflare](https://api.qualflare.com/p/qualflare-playwright/badge.svg)](https://reports.qualflare.com/p/qualflare-playwright/launches)
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
[`@qualflare/cli`](https://github.com/Qualflare/qualflare-cli) **v0.1.24 or newer** to upload what
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

> **Requires `@qualflare/cli` v0.1.24 or newer.** Screenshots are written into `outputDir` and
> referenced by name (`localImagePath`) instead of being base64-inlined into the report, the same
> way videos and traces already were. An older CLI does not read the field, and because such an
> attachment carries neither content nor a storage key the server records it from its name alone —
> an undownloadable placeholder. Upgrade the CLI before upgrading this reporter.
>
> **Videos and traces are opt-in; screenshots are not.** `collect` uploads the report and the
> screenshots always, but a heavy artifact only when asked: `--upload-artifacts=video`, `=trace`, or
> `=video,trace` (or `QF_UPLOAD_ARTIFACTS`). Named kinds are *added* to that default, so asking for
> video does not turn screenshots off; `--upload-artifacts=none` declines everything, screenshots
> included. Nothing is dropped silently — `collect` prints how many artifacts it skipped and the
> exact flag to include them.

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

## Test reports

This reporter is tested with itself. `e2e/` is a Playwright suite covering this package's own
behaviour — the metadata API, nested steps, image attachments and per-attempt retry history — run by
this reporter and uploaded to Qualflare on every merge to `main`. The results below are that suite's,
reported through the code this README documents:

[![Qualflare](https://api.qualflare.com/p/qualflare-playwright/banner.svg)](https://reports.qualflare.com/p/qualflare-playwright/launches)

Every case there is meant to pass, so a red run is a real regression rather than a fixture that fails
on purpose. Deliberately-failing cases live in `test/integration/`, which is never uploaded.

## Known limitations

- **`merge-reports` mode is not supported** — use the `outputDir` flow above rather than
  Playwright's `blob` reporter.
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
