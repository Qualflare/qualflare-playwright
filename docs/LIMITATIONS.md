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

### A leftover report does not need clearing

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). When
`collect` finds files from more than one run it uploads the run that just finished and says what it
left out:

```
ignored 1 file(s) from 1 earlier run(s) (--allow-mixed-runs to include them)
Processing 2 test result file(s)...
OK Test results collected successfully
```

Nothing is deleted — the older files stay on disk, they are simply not uploaded.
`--allow-mixed-runs` merges every run into one launch instead, which is occasionally what you want
when several tools write into one directory.

There was a period where this was stricter than it needed to be: `collect` refused the whole upload
and left you to clear the directory by hand. Before that it merged the stale file silently, which
produced a launch that looked entirely plausible and contained results nobody ran.

**On `@qualflare/cli` older than v0.1.21 you get one of those two older behaviours** — a refusal on
v0.1.19–v0.1.20, and a silent merge before that.

### `merge-reports` mode is not supported

Playwright has its own shard-merging flow (the `blob` reporter plus `npx playwright merge-reports`).
This reporter is not designed to run inside it. Use the `outputDir` flow above instead.

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

## `parameter()` masking redacts the value

`{ masked: true }` drops the value before the report is written. The secret never leaves this
process, so it is not stored server-side and cannot be read back through the API.

Inside a step, the parameter travels as `{ name, masked: true }` with no value, and the Qualflare UI
renders `••••••` from the flag. Outside any step it lands in the case's `properties`, a flat
`Record<string, string>` with nowhere to put the flag — so the value itself becomes `••••••`.
Either way the report carries no secret.

**The value is unrecoverable.** That is the point, but it is worth stating: masking is not a display
toggle you can undo later. Mask a value you may need to read back and it is gone.

This used to be a display hint only — the real value was sent, stored in plaintext and readable
through the API, while the UI drew dots over it. Anyone who trusted the name got no protection at
all, which is why the docs had to say "never put a real secret in one". They no longer do.

## Attachment caps

`maxAttachmentBytes` (5MB) bounds a single attachment; `maxTotalAttachmentBytes` (10MB) bounds the
run. Anything over either is dropped with a warning rather than truncated — a half-written screenshot
is worse than none.

They used to be 1.5MB and 750KB, and the run budget being *smaller* than the per-item cap was the
tell: every attachment was base64-inlined into `/collect`'s 10MB body, competing with the test
results, so the per-run number had to assume this process was one shard among many. It was a poor
assumption either way — the cap is per process, and `collect` merges every shard into one request,
so eleven shards each honouring 750KB still assembled a body over the limit and lost the whole
launch to a 413.

`@qualflare/cli` v0.1.22+ uploads attachments through the presigned-URL flow and references a
`storageKey`, so the body no longer grows with them. These numbers now only bound the report file on
disk.

**They require that CLI version.** An older one still inlines, and these limits would push it past
the body limit — the failure this change exists to remove. They stay bounded rather than unlimited
so the worst case is one launch rather than an out-of-memory.

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
