/**
 * Shared constants used across the formatter and the author-facing runtime
 * API.
 */

/** Reserved `World.attach()` media type used to smuggle structured
 * `qualflare.*()` calls (label/tag/step/etc.) from step-definition and hook
 * code back to the formatter process — the only data channel CucumberJS
 * gives user code back to a running formatter. The formatter's attachment
 * handler recognizes this exact media type and replays the message as a
 * model mutation instead of rendering it as a literal attachment. */
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

/** Mirrors `launch.MaxAttachmentUploadFileSize` — the server's hard cap on a
 * single `POST /api/v1/attachments/upload-url` request (video). */
export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Client-side SOFT cap on steps recorded per scenario attempt — well under
 * the server's 1000-per-case hard cap (`MAX_STEPS_PER_CASE`). Once hit,
 * further steps within that attempt are dropped (with a one-time warning),
 * not queued and truncated later. */
export const MAX_STEPS_PER_TEST_ATTEMPT = 300;
