/**
 * Custom error class for API-related errors
 */
export class ApiError extends Error {
    public readonly status: number;
    public readonly statusText: string;
    public readonly code?: string;
    public readonly detail?: Record<string, unknown>;
    public readonly retryAfterSeconds?: number;

    constructor(
        status: number,
        statusText: string,
        message?: string,
        code?: string,
        detail?: Record<string, unknown>,
    ) {
        super(message || `API error: ${status} - ${statusText}`);
        this.name = 'ApiError';
        this.status = status;
        this.statusText = statusText;
        this.code = code;
        this.detail = detail;
        this.retryAfterSeconds = typeof detail?.retry_after_seconds === 'number'
            ? detail.retry_after_seconds
            : undefined;
    }

    /**
     * Check if this error indicates sync is not allowed
     */
    isSyncNotAllowed(): boolean {
        return this.status === 403 && this.code === 'SYNC_NOT_ALLOWED';
    }
}

/**
 * Error thrown when an authenticated request can no longer be recovered
 * because the user's session is no longer valid.
 */
export class SessionExpiredError extends ApiError {
    constructor(message?: string) {
        super(401, 'Unauthorized', message || 'Session expired', 'SESSION_EXPIRED');
        this.name = 'SessionExpiredError';
    }
}

/**
 * Error thrown when refreshing an otherwise valid session fails for a
 * transient or retryable reason.
 */
export class SessionRefreshError extends ApiError {
    constructor(message?: string, status: number = 503, statusText: string = 'Service Unavailable') {
        super(status, statusText, message || 'Session refresh failed', 'SESSION_REFRESH_FAILED');
        this.name = 'SessionRefreshError';
    }
}

/**
 * The caller stopped waiting for a request whose outcome may be unknown.
 *
 * This remains a SessionRefreshError subtype so existing transient-network
 * handling continues to apply, while mutation callers can distinguish a
 * deadline from a definite server rejection and reconcile before updating UI.
 */
export class RequestTimeoutError extends SessionRefreshError {
    constructor(message?: string) {
        super(message || 'Request timed out', 0, 'Network Error');
        this.name = 'RequestTimeoutError';
    }
}

/**
 * Error thrown for server-side errors
 */
export class ServerError extends Error {
    constructor(message?: string) {
        super(message || 'Server error occurred');
        this.name = 'ServerError';
    }
}
