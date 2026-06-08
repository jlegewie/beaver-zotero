import { createAbortController } from '../../utils/abortController';

/** Default timeout in seconds if not specified by backend */
export const DEFAULT_TIMEOUT_SECONDS = 25;
export const DEFAULT_PAGES_TIMEOUT_SECONDS = 40;
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_IMAGES_TIMEOUT_SECONDS = 60;
export const MAX_PDF_TIMEOUT_SECONDS = 180;

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
 * Optional `externalSignal` lets a parent (e.g. the background processor)
 * abort an in-flight extraction mid-flight. When the external signal fires,
 * `throwIfTimedOut` raises `ExternalAbortError` instead of `TimeoutError`
 * so callers can release the work without counting it as a failure.
 */
export function createTimeoutController(
    rawTimeoutSeconds: number | undefined,
    defaultSeconds: number,
    externalSignal?: AbortSignal,
): TimeoutControllerContext {
    const parsedTimeoutSeconds =
        typeof rawTimeoutSeconds === 'number'
        && Number.isFinite(rawTimeoutSeconds)
        && rawTimeoutSeconds > 0
            ? rawTimeoutSeconds
            : defaultSeconds;
    const timeoutSeconds = Math.min(parsedTimeoutSeconds, MAX_PDF_TIMEOUT_SECONDS);
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
