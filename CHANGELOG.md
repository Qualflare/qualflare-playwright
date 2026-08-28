# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

Initial public release.

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
