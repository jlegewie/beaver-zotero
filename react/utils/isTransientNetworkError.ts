import { ServerError, SessionRefreshError } from '../types/apiErrors';

/**
 * True for errors that callers should retry rather than treat as terminal.
 * apiService is the choke point for offline `fetch` failures: it converts them to
 * SessionRefreshError, so we only need typed-error checks here. A blanket
 * "any error while offline" rule would misclassify programming bugs (e.g.
 * "Cannot read properties of undefined") that happen to fire while the network is
 * down, leading to infinite retry loops.
 */
export function isTransientNetworkError(error: unknown): boolean {
    return error instanceof SessionRefreshError || error instanceof ServerError;
}
