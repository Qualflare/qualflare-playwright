# Known limitations

Deliberate boundaries of `@qualflare/playwright`, with the reasoning behind each. Everything here
is a considered trade-off rather than an oversight.

## Traces need `--upload-artifacts=trace`

Playwright's trace (`use.trace`) is its best debugging artifact, and this reporter now attaches it:
the zip is copied into `outputDir` and referenced by `localTracePath`, the same shape videos use.

It was dropped entirely before v0.4.0. The blocker was never Playwright or this reporter — Qualflare's
attachment-upload endpoint validated against a video-only MIME allowlist and rejected
`application/zip`. Widening that allowlist is what made traces possible.

Two things to know:

- **The upload is opt-in.** `qf collect` uploads no heavy artifact by default; pass
  `--upload-artifacts=trace` (or `video,trace`) or set `QF_UPLOAD_ARTIFACTS`. A trace written into
  `outputDir` is not automatically a trace uploaded, and `collect` prints what it skipped.
- **Needs `@qualflare/cli` v0.1.20+.** An older CLI ignores `localTracePath` entirely, so the zip
  sits in `outputDir` and never reaches a launch.

`maxTraceBytes` (default 50MB, matching the server's own cap) bounds one trace, checked with
`fs.statSync` before anything is copied. Traces still work normally in Playwright itself either way —
`npx playwright show-trace` is unaffected.

## Artifacts are written, not uploaded

Videos, traces and screenshots are all copied into `outputDir` next to the report file and referenced
by `localVideoPath`, `localTracePath` and `localImagePath`. `qualflare-cli` uploads them at collect
time and resolves each into a real `storageKey`; this reporter never makes a network call.

Screenshots used to take the other path — inlined as base64 `content` — which put them inside
`/collect`'s request body and made them compete with the results for it. They now travel like
everything else, and only text attachments (logs, JSON, markdown) still inline.

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

## Retries: per-attempt error detail, final-attempt everything else

`Case.attempts` carries each attempt's status, duration and error, so a retried test reports
"attempt 1 failed with error X, attempt 2 passed" rather than collapsing to the final outcome.

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

## Attachment caps need `@qualflare/cli` v0.1.22+

`maxAttachmentBytes` (5MB) and `maxTotalAttachmentBytes` (10MB) are configurable — see
[`CONFIGURATION.md`](./CONFIGURATION.md). Anything over either is skipped with a warning rather than
truncated; a half-written screenshot is worse than none.

The **version requirement is the real constraint**, and it is not something this reporter can detect
for you. From v0.1.22 the CLI uploads attachments through the presigned-URL flow and references a
`storageKey`, so they no longer occupy `/collect`'s 10MB request body. On an older CLI they are still
base64-inlined, and these limits are large enough to push a request past that body limit — which
fails the entire launch, not just the attachment.

That failure is what the pairing exists to remove. It used to happen without anyone changing a
setting: the caps are per process, `collect` merges every shard into one request, and eleven shards
each honouring the old 750KB budget still assembled a body over the limit.

## Test identity

`Case.id` is Playwright's own `TestCase.id`, a hash of file + title + project. That means the same
test running under two projects is two cases (correctly — they can fail independently), but also
that **renaming a test or moving its file breaks its flaky-trend history**, since the id changes.

## Not limitations of this reporter

Things Playwright itself does not do. They are recorded here because people ask why a Playwright launch
looks different from the other reporters' — not because anything is being withheld. Each would need
a change in Playwright, not here.

**Native `tag` needs Playwright 1.42+.** The `tag` option on `test()`/`test.describe()` does not
exist below 1.42, and the peer floor is 1.40, so on 1.40/1.41 there is no native tag array to read.
`qualflare.tag()` works throughout; upgrading is what gets you the native ones.
