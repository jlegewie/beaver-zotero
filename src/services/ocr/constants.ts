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
