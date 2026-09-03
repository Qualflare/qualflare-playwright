# Known limitations

Deliberate boundaries of `@qualflare/playwright`, with the reasoning behind each. Everything here
is a considered trade-off rather than an oversight.

## Traces are not uploaded

Playwright's trace (`use.trace`) is its best debugging artifact, and this reporter **does not attach
it**.

Traces are `application/zip`. Qualflare's attachment-upload endpoint validates the MIME type against
a video-only allowlist (`video/mp4`, `video/webm`, `video/quicktime`) and rejects anything else, and
a trace is far too large to inline as base64 under the per-attachment cap. Attaching one anyway
would produce a row in the UI that can never be opened, which is worse than not showing it at all.

Traces still work normally in Playwright itself — `npx playwright show-trace` is unaffected.

## Videos are written, not uploaded

Video attachments are copied into `outputDir` next to the report file and referenced by
`localVideoPath`. `qualflare-cli` uploads them at collect time and resolves each into a real
`storageKey`. Screenshots take the other path — inlined as base64 `content` — because they are small
enough to fit the wire contract's caps.

Controlled by `maxVideoBytes` (default 50MB, matching the server's own cap, checked before anything
is copied). A video that can't be written is skipped with a warning; it never fails a run.

## `pw:api` and `fixture` steps are filtered out by default

Playwright emits a step for every API call (`pw:api`: each `page.click()`, `locator.fill()`,
assertion internals) and for every fixture setup (`fixture`: the implicit `browser`, `context` and
`page` every browser test opens with).

A single browser test routinely produces hundreds of these. Reporting them all buries the
`test.step()` boundaries you actually wrote and exhausts the 300-step per-attempt cap on noise
before reaching anything legible. Set `includeApiSteps: true` if you want them.

**A step that FAILED is always reported, whatever its category.** A failing `pw:api` call or a
fixture that throws is usually the single most useful line in the trace, and dropping it to a
volume heuristic would defeat the point of reporting steps at all.

## Step nesting is preserved, but depth is capped

Nested `test.step()` trees survive as `parentIndex` references, which Qualflare rebuilds into a real
tree. Nesting deeper than 10 levels stops deepening: those steps are still reported, but re-parented
to the deepest ancestor within the cap rather than dropped. Playwright imposes no nesting limit, so
this is a runaway guard, not a product decision.

## Sharded CI: point every shard at the same `outputDir`

Qualflare's `/collect` endpoint creates exactly one Launch per request. This reporter accumulates a
whole `playwright test` process in memory and writes it as one uniquely-named JSON file at `onEnd`.
It never uploads.

Merging is entirely `qualflare-cli`'s job: point every shard at the same `outputDir` and run
`qf <identifier> collect <outputDir>` once at the end. Because each file's name is a UUID, shards
sharing a directory never overwrite each other.

Requires [`@qualflare/cli`](https://github.com/Qualflare/qualflare-cli) **v0.1.17 or newer** — the
first release that preserves `labels`/`links` and step nesting through `collect`.

### Stale files are refused, not merged

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). If
`collect` finds files from more than one run it refuses to upload and names them:

```
Error: 2 different runs found in the report files:
    run 17244102887: 1 file(s)  (stale.json)
    run 17244981923: 2 file(s)  (shard-0.json, shard-1.json)
  A stale file from an earlier run would be merged into this launch.
  Clear the output directory before each run, or pass --allow-mixed-runs to upload anyway
```

Clearing `outputDir` at the start of each run is still the tidier habit — in CI it is usually free,
since the workspace is fresh — but forgetting now costs a failed upload rather than a launch
quietly containing results nobody ran.

Needs `@qualflare/cli` v0.1.19 or newer. An older CLI ignores `runId` and merges as before.

### `merge-reports` mode is not supported

Playwright has its own shard-merging flow (the `blob` reporter plus `npx playwright merge-reports`).
This reporter is not designed to run inside it in v0.1.0. Use the `outputDir` flow above instead.

The blocker is worth recording for whoever adds it: in merge mode Playwright deliberately does
**not** deduplicate projects — a project sharded across 5 machines appears as 5 distinct project
objects in the config handed to `onBegin`. Any grouping logic must therefore key on `project.name`
rather than object identity or array position.

## Retries: per-attempt error detail, final-attempt everything else

`Case.attempts` carries each attempt's status, duration and error, so a retried test reports
"attempt 1 failed with error X, attempt 2 passed" rather than collapsing to the final outcome.
`@qualflare/cucumberjs` and `@qualflare/cypress` send the same structure.

Everything *else* still comes from the final attempt: steps, labels, links, tags, description,
priority, properties and attachments. That is deliberate rather than a schema limit. An abandoned
attempt's step trace, replayed alongside the final one's, would misrepresent a single execution as
if the same steps ran twice — so earlier attempts' steps are discarded, never merged.

Two consequences worth knowing:

- A test that was **not** retried sends no `attempts` at all. There is no history in a run that
  happened once, and the server discards a single-element array, so sending one would only spend
  payload against the collect body limit.
- Past 50 attempts the server keeps the first 49 plus the final one and drops the middle. A test
  retrying more than fifty times is pathological; the launch still succeeds and `retryCount` still
  reflects the true total.

## `parameter()` outside a step has no masking

`qualflare.parameter(name, value, { masked: true })` inside an open `qualflare.step()` attaches to
that step and carries the masking hint. Outside any step, the parameter lands in `Case.properties`,
which has no masking concept — the value is stored as-is.

`masked` is a **display hint for the UI in either case**. The server does not redact the value, and
neither does this reporter. Do not pass a real secret expecting it to be protected.

## Per-case and per-attachment caps are independent, not pooled

`maxAttachmentBytes` bounds any single attachment; `maxTotalAttachmentBytes` bounds the inline total
for the whole run. An attachment that exceeds either is **dropped entirely**, never degraded to a
path-only entry — the server treats `path` as informational and never fetches it, so a path-only
attachment is a row a user can see but never open.

Videos are exempt from the inline budget: they are copied to disk rather than inlined, and bounded
separately by `maxVideoBytes`.

## Playwright-native tags need 1.42+

`TestCase.tags` — the `@token`s Playwright parses out of test titles and the `tag` option on
`test()`/`test.describe()` — only exists from Playwright **1.42**. On 1.40/1.41 the reporter reads
it defensively and simply reports no native tags, because that Playwright has no such concept.

`qualflare.tag()` works on every supported version, so nothing is lost that the runner could have
told us in the first place.

## Test identity

`Case.id` is Playwright's own `TestCase.id`, a hash of file + title + project. That means the same
test running under two projects is two cases (correctly — they can fail independently), but also
that **renaming a test or moving its file breaks its flaky-trend history**, since the id changes.
