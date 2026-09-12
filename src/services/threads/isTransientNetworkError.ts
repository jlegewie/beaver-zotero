import {
    isApiError,
    isSessionRefreshError,
    isServerError,
} from "@beaver/agent-core/types/apiErrors";

/**
 * True for errors that callers should retry rather than treat as terminal.
 * apiService is the choke point for offline `fetch` failures: it converts them to
 * SessionRefreshError, so we only need typed-error checks here. A blanket
 * "any error while offline" rule would misclassify programming bugs (e.g.
 * "Cannot read properties of undefined") that happen to fire while the network is
 * down, leading to infinite retry loops.
 */
export function isTransientNetworkError(error: unknown): boolean {
    return (
        isSessionRefreshError(error) ||
        isServerError(error) ||
        (isApiError(error) && (error.status === 429 || error.status >= 500))
    );
}
