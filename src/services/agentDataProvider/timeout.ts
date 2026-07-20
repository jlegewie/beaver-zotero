import { createAbortController } from '../../utils/abortController';

/** Default timeout in seconds if not specified by backend */
export const DEFAULT_TIMEOUT_SECONDS = 25;
export const DEFAULT_PAGES_TIMEOUT_SECONDS = 40;
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_IMAGES_TIMEOUT_SECONDS = 60;
/** Default deadline for single image-attachment processing (decode/resize/encode). */
export const DEFAULT_ATTACHMENT_IMAGE_TIMEOUT_SECONDS = 30;
export const MAX_PDF_TIMEOUT_SECONDS = 180;
/**
 * Ceiling for interactive (hot-slot) PDF worker requests. The hot worker
 * enforces a busy-age lease (`DEFAULT_BUSY_LEASE_MS_HOT`) as a last-resort
 * backstop against a wedged worker; an interactive request's own timeout —
 * plus `HOT_SHARED_EXTRACTION_GRACE_MS` for a detached shared extraction —
 * must always reclaim the worker before that lease fires, so in-budget work
 * is never reaped. Raise the lease alongside any increase here. Background
 * extractions are exempt: their slot uses the full `MAX_PDF_TIMEOUT_SECONDS`
 * ceiling under a proportionally larger lease.
 */
export const MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS = 60;

/** Timeout error for cooperative cancellation */
export class TimeoutError extends Error {
    constructor(
        public readonly timeoutSeconds: number,
        public readonly elapsedMs: number,
        public readonly phase: string,
    ) {
        super(`Operation timed out after ${timeoutSeconds} seconds`);
        this.name = 'TimeoutError';
    }
}

/**
 * Caller-initiated abort relayed into the timeout controller via the
 * `externalSignal` argument. Distinguished from `TimeoutError` so callers
 * can treat external aborts as "not a failure, just an interruption."
 */
export class ExternalAbortError extends Error {
    constructor(public readonly phase: string) {
        super(`Operation aborted by caller`);
        this.name = 'ExternalAbortError';
    }
}

/**
 * Marker used as `AbortController.abort(reason)` when the external signal
 * fired. Read back via `signal.reason` inside `throwIfTimedOut` to decide
 * between `TimeoutError` and `ExternalAbortError`.
 */
const externalAbortMarker: { kind: 'external-abort' } = { kind: 'external-abort' };

function isExternalAbortReason(reason: unknown): boolean {
    return (
        reason !== null
        && typeof reason === 'object'
        && (reason as { kind?: unknown }).kind === 'external-abort'
    );
}

/** Context passed to executors for cooperative timeout checking */
export interface TimeoutContext {
    signal: AbortSignal;
    timeoutSeconds: number;
    startTime: number;
}

/**
 * Check if the operation has been aborted and throw TimeoutError if so.
 * Called at checkpoints before irreversible operations (saves, transactions).
 */
export function checkAborted(ctx: TimeoutContext, phase: string): void {
    const elapsed = Date.now() - ctx.startTime;
    if (ctx.signal.aborted || elapsed >= ctx.timeoutSeconds * 1000) {
        throw new TimeoutError(ctx.timeoutSeconds, elapsed, phase);
    }
}

/** Timeout controller for PDF handlers with caller-controlled deadlines. */
export interface TimeoutControllerContext {
    signal: AbortSignal;
    timeoutSeconds: number;
    throwIfTimedOut: (phase: string) => void;
    dispose: () => void;
}

/**
 * Create an AbortController-backed timeout with strict positive-number parsing.
 * Invalid values fall back to the handler default; valid values are capped so a
 * bad caller cannot pin the single shared PDF worker for an unbounded period.
 *
 * `maxSeconds` sets the cap (default `MAX_PDF_TIMEOUT_SECONDS`). Handlers
 * whose deadline governs hot-slot PDF worker operations must pass
 * `MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS` so the request timeout stays below
 * the hot worker's busy lease.
 *
 * Optional `externalSignal` lets a parent (e.g. the background processor)
 * abort an in-flight extraction mid-flight. When the external signal fires,
 * `throwIfTimedOut` raises `ExternalAbortError` instead of `TimeoutError`
 * so callers can release the work without counting it as a failure.
 */
export function createTimeoutController(
    rawTimeoutSeconds: number | undefined,
    defaultSeconds: number,
    externalSignal?: AbortSignal,
    maxSeconds: number = MAX_PDF_TIMEOUT_SECONDS,
): TimeoutControllerContext {
    const parsedTimeoutSeconds =
        typeof rawTimeoutSeconds === 'number'
        && Number.isFinite(rawTimeoutSeconds)
        && rawTimeoutSeconds > 0
            ? rawTimeoutSeconds
            : defaultSeconds;
    const timeoutSeconds = Math.min(parsedTimeoutSeconds, maxSeconds);
    const startTime = Date.now();
    const controller = createAbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    let externalListener: (() => void) | null = null;
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort(externalAbortMarker);
        } else {
            externalListener = () => controller.abort(externalAbortMarker);
            externalSignal.addEventListener('abort', externalListener, { once: true });
        }
    }

    return {
        signal: controller.signal,
        timeoutSeconds,
        throwIfTimedOut: (phase: string) => {
            const elapsed = Date.now() - startTime;
            if (controller.signal.aborted) {
                if (isExternalAbortReason(controller.signal.reason)) {
                    throw new ExternalAbortError(phase);
                }
                throw new TimeoutError(timeoutSeconds, elapsed, phase);
            }
            if (elapsed >= timeoutSeconds * 1000) {
                throw new TimeoutError(timeoutSeconds, elapsed, phase);
            }
        },
        dispose: () => {
            clearTimeout(timer);
            if (externalSignal && externalListener) {
                externalSignal.removeEventListener('abort', externalListener);
                externalListener = null;
            }
        },
    };
}

/** Await shared work while preserving the caller's own abort/timeout result. */
export async function awaitWithRequestAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    throwIfTimedOut: (phase: string) => void,
    phase: string,
): Promise<T> {
    if (signal.aborted) {
        throwIfTimedOut(phase);
    }

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
            try {
                throwIfTimedOut(phase);
                reject(new Error('Operation aborted'));
            } catch (error) {
                reject(error);
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
        return await Promise.race([promise, abortPromise]);
    } finally {
        if (onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    }
}
