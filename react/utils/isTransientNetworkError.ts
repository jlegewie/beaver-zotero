import { ServerError, SessionRefreshError } from '../types/apiErrors';

/**
 * True for errors that callers should retry rather than treat as terminal.
 * apiService converts offline `fetch` failures to `SessionRefreshError`, so we
 * mostly only need typed-error checks here. The `navigator.onLine` guard is a
 * fallback in case some other path produces an untyped error while offline.
 */
export function isTransientNetworkError(error: unknown): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return error instanceof SessionRefreshError || error instanceof ServerError;
}
