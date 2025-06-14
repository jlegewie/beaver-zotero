/**
 * Custom error class for API-related errors
 */
export class ApiError extends Error {
    public readonly status: number;
    public readonly statusText: string;

    constructor(status: number, statusText: string, message?: string) {
        super(message || `API error: ${status} - ${statusText}`);
        this.name = 'ApiError';
        this.status = status;
        this.statusText = statusText;
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