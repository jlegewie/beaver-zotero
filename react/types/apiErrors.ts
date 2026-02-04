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