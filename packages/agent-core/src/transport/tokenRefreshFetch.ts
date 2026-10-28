/**
 * Keeps a saved session through token-refresh failures that do not come from
 * the auth server rejecting the refresh token.
 *
 * auth-js deletes the stored session on every refresh error it does not
 * classify as a network failure, and it only treats a failed request and
 * HTTP 502/503/504 as one. A 500 or 429 from the auth server, or an HTML page
 * from a proxy, firewall or CDN in front of it, therefore signs the user out,
 * although none of them says the refresh token is invalid. Throwing from
 * `fetch` turns these into `AuthRetryableFetchError`, which keeps the session
 * and lets the next refresh attempt try again.
 */

/** Statuses that say nothing about the refresh token: retry them. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

function requestUrl(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object') {
        const candidate = input as { url?: unknown; href?: unknown };
        if (typeof candidate.url === 'string') return candidate.url;
        if (typeof candidate.href === 'string') return candidate.href;
    }
    return String(input);
}

/** Whether `input` is an auth-js refresh-token grant. */
export function isTokenRefreshRequest(input: unknown): boolean {
    const url = requestUrl(input);
    return url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token');
}

/**
 * Whether a failed refresh response is the auth server's own verdict on the
 * refresh token: a JSON 4xx error. Anything else may be transient or may not
 * come from the auth server at all.
 */
export function isAuthServerRejection(response: Response): boolean {
    if (response.status < 400 || response.status >= 500) return false;
    if (RETRYABLE_CLIENT_STATUSES.has(response.status)) return false;
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.toLowerCase().includes('json');
}

/**
 * Wrap `baseFetch` so a refresh-token request either resolves with a response
 * auth-js may act on, or rejects like a network failure.
 */
export function guardTokenRefreshFetch(baseFetch: typeof fetch): typeof fetch {
    return async (url, init) => {
        const response = await baseFetch(url, init);
        if (response.ok || !isTokenRefreshRequest(url) || isAuthServerRejection(response)) {
            return response;
        }
        const contentType = response.headers.get('content-type') || 'no content type';
        throw new TypeError(`Token refresh failed with HTTP ${response.status} (${contentType}); keeping the saved session`);
    };
}
