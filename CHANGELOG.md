# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
