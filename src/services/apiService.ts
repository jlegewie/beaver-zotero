import { AuthApiError, AuthError, AuthSessionMissingError, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { ApiError, ServerError, SessionExpiredError, SessionRefreshError } from '../../react/types/apiErrors';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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

    private async request(endpoint: string, method: HttpMethod, body?: unknown): Promise<Response> {
        const bodyText = body === undefined ? undefined : JSON.stringify(body);
        const logMessage = method === 'PATCH' && bodyText
            ? `${method}: ${endpoint} ${bodyText}`
            : `${method}: ${endpoint}`;

        const makeRequest = async (headers: Record<string, string>): Promise<Response> => {
            return await fetch(`${this.baseUrl}${endpoint}`, {
                method,
                headers,
                body: bodyText
            });
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
    * Adds Zotero and plugin version identifiers to outgoing headers when available
    */
    private getVersionHeaders(): Record<string, string> {
        const versionHeaders: Record<string, string> = {};

        if (typeof Zotero !== 'undefined') {
            const { version, Beaver } = Zotero;
            if (version && typeof version === 'string') {
                versionHeaders['X-Zotero-Version'] = version;
            }
            const pluginVersion = Beaver?.pluginVersion;
            if (pluginVersion && typeof pluginVersion === 'string') {
                versionHeaders['X-Beaver-Version'] = pluginVersion;
            }
        }

        return versionHeaders;
    }
    
    /**
    * Handles API response errors and throws appropriate custom errors
    */
    private async handleApiError(response: Response): Promise<never> {
        if (response.status >= 500) {
            throw new ServerError(`Server error: ${response.status} - ${response.statusText}`);
        } else {
            // Try to parse error response as JSON, but don't fail if it's not
            let errorBody = '';
            try {
                errorBody = await response.text();
                const errorJson = JSON.parse(errorBody);
                // Handle FastAPI HTTPException detail format (can be string or object)
                const detail = errorJson.detail;
                if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
                    // Structured error with code and message
                    throw new ApiError(
                        response.status,
                        response.statusText,
                        detail.message || response.statusText,
                        detail.code
                    );
                } else {
                    // Simple string detail or fallback
                    throw new ApiError(
                        response.status,
                        response.statusText,
                        detail || errorJson.message || response.statusText
                    );
                }
            } catch (e) {
                // Re-throw if it's already an ApiError
                if (e instanceof ApiError) throw e;
                throw new ApiError(response.status, response.statusText);
            }
        }
    }
    
    /**
    * Performs a GET request
    */
    async get<T>(endpoint: string): Promise<T> {
        const response = await this.request(endpoint, 'GET');
        return await this.parseJsonResponse<T>(response, 'GET');
    }
    
    /**
    * Performs a POST request
    */
    async post<T>(endpoint: string, body: any): Promise<T> {
        const response = await this.request(endpoint, 'POST', body);
        return await this.parseJsonResponse<T>(response, 'POST');
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
