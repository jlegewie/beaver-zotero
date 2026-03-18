/**
 * Custom error class for API-related errors
 */
export class ApiError extends Error {
    public readonly status: number;
    public readonly statusText: string;
    public readonly code?: string;

    constructor(status: number, statusText: string, message?: string, code?: string) {
        super(message || `API error: ${status} - ${statusText}`);
        this.name = 'ApiError';
        this.status = status;
        this.statusText = statusText;
        this.code = code;
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
 * Error thrown when Zotero instance is not linked to the user account
 */
export class ZoteroInstanceMismatchError extends Error {
    constructor() {
        super('This Zotero instance is not linked to your account');
        this.name = 'ZoteroInstanceMismatchError';
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
