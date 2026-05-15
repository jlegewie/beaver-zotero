/** Default timeout in seconds if not specified by backend */
export const DEFAULT_TIMEOUT_SECONDS = 25;
export const DEFAULT_PAGES_TIMEOUT_SECONDS = 40;
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_IMAGES_TIMEOUT_SECONDS = 60;
export const MAX_PDF_TIMEOUT_SECONDS = 120;

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
 */
export function createTimeoutController(
    rawTimeoutSeconds: number | undefined,
    defaultSeconds: number,
): TimeoutControllerContext {
    const parsedTimeoutSeconds =
        typeof rawTimeoutSeconds === 'number'
        && Number.isFinite(rawTimeoutSeconds)
        && rawTimeoutSeconds > 0
            ? rawTimeoutSeconds
            : defaultSeconds;
    const timeoutSeconds = Math.min(parsedTimeoutSeconds, MAX_PDF_TIMEOUT_SECONDS);
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    return {
        signal: controller.signal,
        timeoutSeconds,
        throwIfTimedOut: (phase: string) => {
            const elapsed = Date.now() - startTime;
            if (controller.signal.aborted || elapsed >= timeoutSeconds * 1000) {
                throw new TimeoutError(timeoutSeconds, elapsed, phase);
            }
        },
        dispose: () => clearTimeout(timer),
    };
}
