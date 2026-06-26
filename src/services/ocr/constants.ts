/** Shared OCR constants that are safe for both esbuild and webpack bundles. */

/**
 * Identity of the OCR engine generation that produces a result. Bump this when
 * the OCR engine changes enough to reprocess terminal no-text results.
 */
export const OCR_ENGINE_VERSION = 'ocrmypdf-1';

/** Loop-guard terminal codes recorded in `document_processing_failures`. */
export const OCR_TERMINAL_NO_TEXT = 'ocr_no_text';
export const OCR_TERMINAL_GEOMETRY = 'ocr_geometry_mismatch';
export const OCR_TERMINAL_FAILED = 'ocr_failed_permanent';

/** Backend `/api/v1/ocr/*` route prefix. */
export const OCR_API_PREFIX = '/api/v1/ocr';

/** Polling cadence for `/ocr/status` while a job is queued/in-flight. */
export const OCR_POLL_INITIAL_MS = 2_000;
export const OCR_POLL_MAX_MS = 15_000;
export const OCR_POLL_BACKOFF = 1.5;

/**
 * Wall-clock budget for one OcrExecutor run's polling. Kept under the queue's
 * visibility timeout so a long OCR releases the job (to be re-picked and resume
 * polling) instead of silently exceeding its lease.
 */
export const OCR_POLL_BUDGET_MS = 4 * 60_000;

/**
 * Max job ids per `/ocr/status/batch` request (mirrors the backend cap). The
 * shared poller chunks at this size, so raising the in-flight lane cap later
 * needs no poller change.
 */
export const OCR_STATUS_BATCH_MAX = 50;

/**
 * Background-queue priorities for OCR tickets (lower number = claimed first;
 * the dispatcher gates `priority >= 100` behind user idleness).
 *  - On-demand (a scan the user just opened) runs promptly and preempts backfill.
 *  - Backfill (whole-library signup processing) is idle-only.
 */
export const OCR_PRIORITY_ON_DEMAND = 90;
export const OCR_PRIORITY_BACKFILL = 100;
