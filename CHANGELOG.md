# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0

### Added

- **Playwright traces are attached.** The trace zip is copied into `outputDir` and referenced by
  `localTracePath`, the same shape videos use. Traces were dropped entirely before this: Qualflare's
  attachment-upload endpoint validated against a video-only MIME allowlist and rejected
  `application/zip`, so an attached trace would have been a row pointing at nothing. Widening that
  allowlist server-side is what made it possible.

  The upload is opt-in on the CLI side — pass `--upload-artifacts=trace` (or `video,trace`) to
  `qf collect`. A trace written into `outputDir` is not automatically a trace uploaded. Requires
  `@qualflare/cli` v0.1.20 or newer; an older CLI ignores the field.

- `maxTraceBytes` (`QUALFLARE_MAX_TRACE_BYTES`, default 50MB to match the server cap), checked with
  `fs.statSync` before anything is copied so an oversized trace is never written just to be rejected
  at collect time.

### Fixed

- A superseded retry attempt now cleans up its orphaned trace as well as its video.
- The `merge-reports` limitation no longer claims to be about "v0.1.0".

## 0.3.0

### Added

- Per-attempt execution history on every retried test, sent as `Case.attempts`.

  Until now a retried test reported only `retryCount` and `isFlaky` — that it was retried
  twice, but nothing about *what* went wrong each time. Playwright already gives the reporter
  the full `test.results[]`, so every intermediate attempt's status, duration, start time,
  error message, stack, snippet, source line and captured stdout/stderr were being computed
  and then thrown away.

  Each attempt is now sent individually, including the final one — the server takes the
  final attempt's status and duration from the case itself so the two can never disagree,
  but keeps that attempt's own error text.

  A test that was not retried sends nothing: a single attempt has no history beyond what the
  case already carries, and the server discards it. Requires an API that stores attempt
  history; older servers ignore the field.

  Attempt text is bounded to what the server stores: `message` 8192 characters, `trace` 32768,
  `snippet` 4096, and `stdout`/`stderr` 200 lines or 16384 characters each, whichever comes
  first. A chatty retried test would otherwise serialize to hundreds of KB of text the server
  discards on write — enough of them to exceed the request body limit and lose the whole
  launch. The Case's own `error` field is unaffected.

## 0.2.0

### Added

- `metadata.runId` on every report, plus a `runId` option (`QUALFLARE_RUN_ID`) to set it
  explicitly. Every shard of one CI run resolves the same value (`GITHUB_RUN_ID`,
  `CI_PIPELINE_ID`, and so on); outside CI it is a per-process UUID.

  This is what lets `qf collect` tell the shards of the current run apart from a file left behind
  by an earlier one. Until now a stale report sitting in `outputDir` was merged into the launch
  silently — the launch looked entirely plausible and contained results nobody ran, which corrupts
  the history flaky-detection is built on. Requires `@qualflare/cli` v0.1.19 or newer, which
  refuses the merge and names the offending files; older CLIs ignore `runId` and merge as before.

### Changed

- The stale-file caveat in `README.md` and `docs/LIMITATIONS.md` documents what now actually
  happens, instead of asking you to remember to clear the directory.

## 0.1.0

Initial public release.

### Behavior worth knowing

- `qualflare.attachment()` and `qualflare.attachmentFromFile()` are subject to `maxAttachmentBytes`
  and the run-wide `maxTotalAttachmentBytes` budget, exactly like Playwright's own attachments. An
  attachment over either limit is skipped with a warning rather than inlined. This matters because
  `/collect` rejects a request body over 10MB outright, and a rejected request loses the **entire**
  launch — not just the oversized attachment.

### Added

- Native Playwright reporter: suite/case results, real retry counts and flakiness, nested
  `test.step()` trees (via `parentIndex`), and per-project browser attribution.
- Writes one uniquely-named report per process into `outputDir` (default `./qualflare-results`) and
  makes **zero network calls**; `qf collect <outputDir>` uploads the result.
- Automatic shard support. Playwright hands reporters its own `--shard` value, so each case is
  stamped with the shard that ran it with no configuration — converting Playwright's 1-based index
  to Qualflare's 0-based one.
- Failure screenshots inlined as base64; videos copied into `outputDir` and referenced by
  `localVideoPath` for `qualflare-cli` to upload.
- Author-facing `qualflare` metadata API: `label`, `link`, `tag`, `description`, `priority`,
  `parameter`, `attachment`, `attachmentFromFile`, `step`. `qualflare.step()` delegates to
  Playwright's own `test.step()`, so steps appear in both reports.
- `qualflareReporter()` typed registration helper, since Playwright types reporter options as `any`.

### Notes

- Requires `@qualflare/cli >= v0.1.17` — the first release whose `qf collect` preserves
  `labels`/`links` and step nesting.
- Traces are not attached: `application/zip` is rejected by the attachment upload endpoint's MIME
  allowlist. See `docs/LIMITATIONS.md`.
- `pw:api` and `fixture` steps are filtered out by default (`includeApiSteps`); a failed one is
  always kept.
- Playwright-native tags require Playwright 1.42+ (`TestCase.tags` does not exist before that).
  On 1.40/1.41 the reporter reports no native tags rather than refusing to install;
  `qualflare.tag()` works throughout.
