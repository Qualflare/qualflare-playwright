# Metadata API

`qualflare` is the author-facing runtime API — the thing Playwright's own JSON reporter has no
equivalent of, and the main reason this package exists rather than parsing that file.

```ts
import { test, expect } from '@playwright/test';
import { qualflare } from '@qualflare/playwright';
```

Every call attaches to the **currently running test**, wherever it is made: the test body, a
`test.beforeEach`, a fixture, or a helper several frames deep. Calling one outside a running test
(at module load, from `globalSetup`, or after a test has finished) logs a one-time warning and is
ignored — a metadata call must never fail somebody's suite.

## How it works

Playwright runs tests in worker processes and reporters in the main process, with no shared memory.
The only channel back is `testInfo.attach()`, so each call is serialized and attached under a
reserved content type (`application/vnd.qualflare.message+json`). The reporter recognizes that exact
type in `onTestEnd`, replays it, and excludes it from real attachment processing — you never see
these in your report.

---

## `qualflare.label(name, value)`

Arbitrary name/value metadata. This is how Allure-style `epic`/`feature`/`story`/`owner`/`severity`
are expressed.

```ts
qualflare.label('epic', 'Billing');
qualflare.label('owner', 'payments-team');
```

Capped at 100 labels per case (the server's limit); further labels are dropped.

**Requires `@qualflare/cli >= v0.1.17`.** Earlier CLI versions parsed the report but silently
discarded `labels` and `links`, so they never reached the server.

## `qualflare.link(url, opts?)`

A typed external reference.

```ts
qualflare.link('https://tracker.example/QF-42', { type: 'issue', name: 'QF-42' });
qualflare.link('https://wiki.example/runbook');            // type defaults to 'custom'
```

`opts.type` is `'issue' | 'tms' | 'custom'`. Capped at 20 links per case.

## `qualflare.tag(...tags)`

```ts
qualflare.tag('smoke');
qualflare.tag('billing', 'regression');
```

Merged with Playwright's own tags — both the `@token`s it parses out of test titles and the `tag`
option on `test()`/`test.describe()`. Capped at 64 tags per case, each truncated to 255 characters.

## `qualflare.description(text)`

```ts
qualflare.description('Signs a user in and asserts the greeting renders.');
```

Markdown. Last call wins within a test.

## `qualflare.priority(value)`

```ts
qualflare.priority('high');
```

One of `'low' | 'medium' | 'high' | 'critical'`. Last call wins.

## `qualflare.parameter(name, value?, opts?)`

Records a named input.

```ts
qualflare.parameter('sku', 'BOOK-1');
qualflare.parameter('password', secret, { masked: true });
```

**Placement matters.** Inside an open `qualflare.step()`, the parameter attaches to that step.
Outside any step it becomes a `Case.properties` entry instead, because the wire contract has no
case-level `Parameter[]`.

`masked` is a **display hint for the UI only**. Neither this reporter nor the server redacts the
value — do not pass a real secret expecting it to be protected.

## `qualflare.attachment(name, content, opts?)`

Attach in-memory content.

```ts
qualflare.attachment('request', JSON.stringify(body), { mimeType: 'application/json' });
qualflare.attachment('thumbnail', pngBase64, { encoding: 'base64', mimeType: 'image/png' });
```

`opts.encoding` is `'utf8'` (default) or `'base64'`. Subject to the same size caps as any other
inline attachment — see [`CONFIGURATION.md`](./CONFIGURATION.md).

## `qualflare.attachmentFromFile(name, path, opts?)`

Attach a file from disk, read at report time.

```ts
qualflare.attachmentFromFile('har', 'artifacts/session.har', { mimeType: 'application/json' });
```

An unreadable path is skipped with a warning rather than failing the test.

## `qualflare.step(name, fn)`

Records a named step around `fn`, capturing its duration and whether it threw.

```ts
await qualflare.step('add an item to the cart', async () => {
  qualflare.parameter('sku', 'BOOK-1');
  await page.getByRole('button', { name: 'Add' }).click();
});
```

Always `await` it — it returns a promise resolving to whatever `fn` returns, and a rejection is
re-thrown after the failure is recorded, so control flow is unchanged.

**It delegates to Playwright's own `test.step()`**, so the step appears in the Playwright HTML
report and trace viewer as well as in Qualflare. There is no reason to make you choose, and a step
visible in only one of the two is a confusing thing to debug against. Because of that delegation
the step is captured natively; the runtime message only marks the bracket that `parameter()` calls
attach to.

Steps nest, and nesting is preserved in the report via `parentIndex`.

## Playwright's own attachments are captured automatically

You do not need `qualflare.attachment()` for anything Playwright already produces. Failure
screenshots (`use.screenshot`) are inlined, videos (`use.video`) are copied and referenced for
upload, and `testInfo.attach()` calls you make directly are picked up as ordinary attachments.

Traces are the exception — they are deliberately not attached. See
[`LIMITATIONS.md`](./LIMITATIONS.md).
