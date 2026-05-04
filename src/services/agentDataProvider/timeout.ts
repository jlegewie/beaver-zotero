/** Default timeout in seconds if not specified by backend */
export const DEFAULT_TIMEOUT_SECONDS = 25;

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
