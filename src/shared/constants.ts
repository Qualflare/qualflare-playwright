/**
 * Shared constants used across the reporter and the author-facing runtime
 * API.
 */

/** Reserved `testInfo.attach()` content type used to smuggle structured
 * `qualflare.*()` calls (label/tag/step/etc.) from test and hook code back to
 * the reporter — the only channel Playwright gives user code back to a
 * running reporter. The reporter recognizes this exact content type and
 * replays the message as a model mutation instead of reporting it as a
 * literal attachment. */
export const RESERVED_MESSAGE_MEDIA_TYPE = 'application/vnd.qualflare.message+json';

/** Server-side caps this client should respect defensively (see
 * `api-service/internal/core/domain/launch/launch.go`). */
export const MAX_SUITES_PER_LAUNCH = 2000;
export const MAX_CASES_PER_SUITE = 5000;
export const MAX_STEPS_PER_CASE = 1000;
export const MAX_PARAMETERS_PER_STEP = 50;
export const MAX_ATTACHMENTS_PER_CASE = 50;
export const MAX_LABELS_PER_CASE = 100;
export const MAX_LINKS_PER_CASE = 20;
export const MAX_TAGS_PER_CASE = 64;
export const MAX_TAG_LENGTH = 255;

/** Mirrors `launch.MaxCaseAttempts`. Beyond this the server keeps the first
 * 49 attempts plus the final one and drops the middle, so sending more is
 * wasted payload rather than an error. */
export const MAX_ATTEMPTS_PER_CASE = 50;

/** Mirrors the server's per-attempt text bounds (`launch.MaxAttempt*Runes`).
 *
 * Clamped CLIENT-side, not left to the server, because attempts are the only
 * repeated-per-case payload with no size budget of its own. Measured: one
 * retried test with a deep stack and a chatty log serializes to ~630KB
 * unclamped — most of it text the server discards on write — against a 10MB
 * request body limit that, once exceeded, loses the ENTIRE launch. Sending
 * bytes the server will throw away is pure risk. */
export const MAX_ATTEMPT_MESSAGE_RUNES = 8192;
export const MAX_ATTEMPT_TRACE_RUNES = 32768;
export const MAX_ATTEMPT_SNIPPET_RUNES = 4096;
export const MAX_ATTEMPT_OUTPUT_RUNES = 16384;
export const MAX_ATTEMPT_OUTPUT_LINES = 200;

/** Mirrors `launch.MaxAttachmentUploadFileSize` — the server's hard cap on a
 * single `POST /api/v1/attachments/upload-url` request (video). */
export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Client-side SOFT cap on steps recorded per scenario attempt — well under
 * the server's 1000-per-case hard cap (`MAX_STEPS_PER_CASE`). Once hit,
 * further steps within that attempt are dropped (with a one-time warning),
 * not queued and truncated later. */
export const MAX_STEPS_PER_TEST_ATTEMPT = 300;
