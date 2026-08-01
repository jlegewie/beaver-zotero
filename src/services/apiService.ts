import { AuthApiError, AuthError, AuthSessionMissingError, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { ApiError, ServerError, SessionExpiredError, SessionRefreshError } from '../../react/types/apiErrors';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';
import { recordBackendHttpSuccess } from './backendReachability';
import { getRuntimeAdapter } from '../platform/runtime';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Per-request overrides. */
export interface RequestOptions {
    /**
     * Give up this many milliseconds after the call starts. Off by default, so
     * a request runs until the connection settles. Set it when a caller blocks
     * UI on the result and a stalled backend would leave it stuck.
     *
     * This is a deadline for the whole call, not per attempt: it spans the auth
     * lookup, the connection, a 401 refresh-and-retry, and reading the response
     * body. Exceeding it always surfaces as `SessionRefreshError`, which callers
     * treat as retryable.
     */
    timeoutMs?: number;
}

/** An in-flight call's abort controller plus the deadline that armed it. */
interface RequestDeadline {
    controller: AbortController;
    timeoutMs: number;
}

/**
 * Runs `call` under a deadline when one is requested.
 *
 * `fetch` resolves as soon as response headers arrive, so a timer cleared at
 * that point leaves a stalled body read unbounded. The timer is held until
 * `call` — which includes parsing the body — has settled.
 */
async function withDeadline<T>(
    options: RequestOptions | undefined,
    call: (deadline?: RequestDeadline) => Promise<T>,
): Promise<T> {
    const timeoutMs = options?.timeoutMs;
    if (!timeoutMs) return call();

    const deadline: RequestDeadline = { controller: new AbortController(), timeoutMs };
    const timer = setTimeout(() => deadline.controller.abort(), timeoutMs);
    try {
        return await call(deadline);
    } catch (error) {
        // Classify here rather than at the fetch: an expired deadline can also
        // surface while reading the body, where the abort would otherwise escape
        // raw or be mistaken for the HTTP status that came with it. Callers
        // treat `SessionRefreshError` as retryable, which a timeout is.
        if (deadline.controller.signal.aborted) {
            throw new SessionRefreshError(`Request timed out after ${timeoutMs}ms`, 0, 'Network Error');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
* Base API service that handles authentication and common HTTP methods
*/
export class ApiService {
    protected baseUrl: string;
    
    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }
    
    /**
    * Sets the base URL for API requests
    * @param baseUrl The new base URL
    */
    setBaseUrl(baseUrl: string): void {
        this.baseUrl = baseUrl;
    }

    private buildAuthHeaders(token: string): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...this.getVersionHeaders()
        };
    }

    private createSessionRefreshError(message?: string, status?: number): SessionRefreshError {
        const normalizedStatus = status && status > 0 ? status : 503;
        const statusText = normalizedStatus === 429
            ? 'Too Many Requests'
            : 'Service Unavailable';

        return new SessionRefreshError(message, normalizedStatus, statusText);
    }

    private classifyRefreshError(error: unknown): SessionExpiredError | SessionRefreshError {
        // When the OS reports we're offline, no supabase classification can prove the session
        // is permanently gone. Always treat as transient so callers don't trigger logout.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return this.createSessionRefreshError('Offline', 0);
        }

        if (isAuthRetryableFetchError(error)) {
            return this.createSessionRefreshError(error.message, error.status);
        }

        if (error instanceof AuthSessionMissingError) {
            return new SessionExpiredError('User not authenticated');
        }

        if (error instanceof AuthApiError) {
            if (error.status === 429 || error.status >= 500) {
                return this.createSessionRefreshError(error.message, error.status);
            }

            return new SessionExpiredError('Session expired and refresh failed');
        }

        if (error instanceof AuthError) {
            return this.createSessionRefreshError(error.message, error.status);
        }

        // Defense-in-depth for auth errors that may lose their prototype
        // across boundaries and arrive as plain Error-like objects.
        if (
            typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            typeof error.message === 'string' &&
            error.message.includes('Invalid Refresh Token')
        ) {
            return new SessionExpiredError('Session expired and refresh failed');
        }

        return this.createSessionRefreshError('Session refresh failed');
    }

    private async refreshAccessToken(context: string): Promise<string> {
        try {
            const refreshResult = await supabase.auth.refreshSession();

            if (refreshResult.error) {
                logger(`${context}: session refresh failed: ${refreshResult.error?.message}`, 2);
                throw this.classifyRefreshError(refreshResult.error);
            }

            const token = refreshResult.data.session?.access_token;
            if (!token) {
                logger(`${context}: session refresh returned no access token`, 2);
                throw new SessionExpiredError('Session expired and refresh failed');
            }

            return token;
        } catch (error) {
            if (error instanceof SessionExpiredError || error instanceof SessionRefreshError) {
                throw error;
            }

            logger(`${context}: unexpected error during session refresh: ${error}`, 2);
            throw this.createSessionRefreshError('Session refresh failed');
        }
    }

    private async request(
        endpoint: string,
        method: HttpMethod,
        body?: unknown,
        deadline?: RequestDeadline,
    ): Promise<Response> {
        const bodyText = body === undefined ? undefined : JSON.stringify(body);
        const logMessage = method === 'PATCH' && bodyText
            ? `${method}: ${endpoint} ${bodyText}`
            : `${method}: ${endpoint}`;

        const makeRequest = async (headers: Record<string, string>): Promise<Response> => {
            try {
                return await fetch(`${this.baseUrl}${endpoint}`, {
                    method,
                    headers,
                    body: bodyText,
                    ...(deadline ? { signal: deadline.controller.signal } : {}),
                });
            } catch (e) {
                // An expired deadline aborts the fetch; `withDeadline` owns that
                // classification, so leave it alone here.
                if (deadline?.controller.signal.aborted) throw e;
                // fetch throws TypeError on network failure (offline, DNS, TLS, aborted).
                // We reuse SessionRefreshError as the typed transient signal even though
                // this isn't actually a session-refresh path — callers (useProfileSync,
                // sync.ts) treat SessionRefreshError as retryable, which is the desired
                // behavior here. If the type-name mismatch becomes confusing, introduce
                // a generic TransientNetworkError class and update isTransientNetworkError.
                if (e instanceof TypeError) {
                    throw new SessionRefreshError(e.message || 'Network request failed', 0, 'Network Error');
                }
                throw e;
            }
        };

        let headers = await this.getAuthHeaders();
        logger(logMessage);

        let response = await makeRequest(headers);
        if (response.status === 401) {
            logger(`${method}: Received 401 for ${endpoint}. Refreshing session and retrying once.`, 2);
            const refreshedToken = await this.refreshAccessToken(`${method} ${endpoint}`);
            headers = this.buildAuthHeaders(refreshedToken);
            response = await makeRequest(headers);

            if (response.status === 401) {
                logger(`${method}: Received 401 again for ${endpoint} after refresh.`, 2);
                throw new SessionExpiredError('Session expired after retry');
            }
        }

        if (!response.ok) {
            await this.handleApiError(response);
        }

        // Every successful REST call proves Beaver's regular HTTPS API was
        // reachable; connection-failure diagnostics report how recent that
        // proof is. The recorder normalizes the path so no query strings or
        // dynamic identifiers (thread/run ids, item keys) reach telemetry.
        recordBackendHttpSuccess(endpoint);

        return response;
    }

    private async parseJsonResponse<T>(response: Response, method: HttpMethod): Promise<T> {
        const responseText = await response.text();
        try {
            return JSON.parse(responseText) as T;
        } catch (parseError) {
            logger(`${method}: JSON parse error. Response text: ${responseText}`);
            throw parseError;
        }
    }
    
    /**
    * Gets authentication headers with JWT token if user is signed in.
    * This method leverages supabase.auth.getSession() to ensure a valid
    * access token is available, automatically handling token refreshes.
    */
    async getAuthHeaders(): Promise<Record<string, string>> {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
            logger(`Error getting session: ${error.message}`, 2);
            throw this.classifyRefreshError(error);
        }

        if (!data.session) {
            throw new SessionExpiredError('User not authenticated');
        }

        // Defense-in-depth: refresh if the token expires within 30s
        const expiresAt = data.session.expires_at;
        if (expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 30) {
            logger('Access token expired or near-expiry, refreshing session');
            const refreshedToken = await this.refreshAccessToken('getAuthHeaders');
            return this.buildAuthHeaders(refreshedToken);
        }
        
        const token = data.session.access_token;
        if (!token) {
            throw new SessionExpiredError('No access token available');
        }

        return this.buildAuthHeaders(token);
    }

    /**
    * Adds host and plugin version identifiers to outgoing headers when available.
    *
    * These headers are diagnostic, so a host adapter that cannot report them
    * must not fail the request: a throwing adapter degrades to no headers.
    */
    private getVersionHeaders(): Record<string, string> {
        try {
            return getRuntimeAdapter().getVersionHeaders?.() ?? {};
        } catch (error) {
            logger(`ApiService: version headers unavailable: ${error}`, 2);
            return {};
        }
    }
    
    /**
    * Handles API response errors and throws appropriate custom errors
    */
    private async handleApiError(response: Response): Promise<never> {
        if (response.status >= 500) {
            throw new ServerError(`Server error: ${response.status} - ${response.statusText}`);
        } else {
            let errorBody = '';
            try {
                errorBody = await response.text();
                logger(`API error ${response.status} ${response.statusText}: ${errorBody}`, 2);
                const errorJson = JSON.parse(errorBody);
                // Handle FastAPI HTTPException detail format (can be string or object)
                const detail = errorJson.detail;
                if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
                    throw new ApiError(
                        response.status,
                        response.statusText,
                        detail.message || response.statusText,
                        detail.code
                    );
                } else {
                    throw new ApiError(
                        response.status,
                        response.statusText,
                        detail || errorJson.message || response.statusText
                    );
                }
            } catch (e) {
                if (e instanceof ApiError) throw e;
                logger(`API error ${response.status} ${response.statusText} (non-JSON body: ${errorBody})`, 2);
                throw new ApiError(response.status, response.statusText);
            }
        }
    }
    
    /**
    * Performs a GET request
    */
    async get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
        return withDeadline(options, async (deadline) => {
            const response = await this.request(endpoint, 'GET', undefined, deadline);
            return await this.parseJsonResponse<T>(response, 'GET');
        });
    }

    /**
    * Performs a POST request
    */
    async post<T>(endpoint: string, body: any, options?: RequestOptions): Promise<T> {
        return withDeadline(options, async (deadline) => {
            const response = await this.request(endpoint, 'POST', body, deadline);
            return await this.parseJsonResponse<T>(response, 'POST');
        });
    }
    
    /**
    * Performs a PATCH request
    */
    async patch<T>(endpoint: string, body: any): Promise<T> {
        const response = await this.request(endpoint, 'PATCH', body);
        return await this.parseJsonResponse<T>(response, 'PATCH');
    }
    
    /**
    * Performs a DELETE request
    */
    async delete(endpoint: string): Promise<void> {
        await this.request(endpoint, 'DELETE');
        return;
    }
}
