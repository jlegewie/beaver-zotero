import { ApiError, ServerError, TimeoutError } from '../../react/types/apiErrors';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';

/** Default timeout for API requests (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
* Base API service that handles authentication and common HTTP methods
*/
export class ApiService {
    protected baseUrl: string;
    protected defaultTimeoutMs: number;
    
    constructor(baseUrl: string, defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
        this.baseUrl = baseUrl;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    
    /**
    * Sets the base URL for API requests
    * @param baseUrl The new base URL
    */
    setBaseUrl(baseUrl: string): void {
        this.baseUrl = baseUrl;
    }
    
    /**
    * Gets authentication headers with JWT token if user is signed in.
    * This method leverages supabase.auth.getSession() to ensure a valid
    * access token is available, automatically handling token refreshes.
    */
    async getAuthHeaders(): Promise<Record<string, string>> {
        // Get the current session from Supabase, which handles token refreshes
        const { data, error } = await supabase.auth.getSession();

        if (error) {
            logger(`Error getting session: ${error.message}`, 2);
            throw new ApiError(401, 'Error retrieving user session');
        }

        if (!data.session) {
            throw new ApiError(401, 'User not authenticated');
        }
        
        const token = data.session.access_token;
        if (!token) {
            throw new ApiError(401, 'No access token available');
        }
        
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...this.getVersionHeaders()
        };
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
                throw new ApiError(response.status, errorJson.message || response.statusText);
            } catch (e) {
                throw new ApiError(response.status, response.statusText);
            }
        }
    }

    /**
    * Performs a fetch request with timeout support
    * @param url The URL to fetch
    * @param options Fetch options
    * @param timeoutMs Timeout in milliseconds (uses default if not provided)
    * @returns Promise with the response
    */
    private async fetchWithTimeout(
        url: string,
        options: RequestInit,
        timeoutMs?: number
    ): Promise<Response> {
        const timeout = timeoutMs ?? this.defaultTimeoutMs;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            return response;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new TimeoutError(timeout, `Request timed out after ${timeout}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }
    
    /**
    * Performs a GET request
    * @param endpoint API endpoint
    * @param timeoutMs Optional timeout in milliseconds
    */
    async get<T>(endpoint: string, timeoutMs?: number): Promise<T> {
        const headers = await this.getAuthHeaders();
        logger(`GET: ${endpoint}`);
        const response = await this.fetchWithTimeout(
            `${this.baseUrl}${endpoint}`,
            { method: 'GET', headers },
            timeoutMs
        );
        
        if (!response.ok) {
            await this.handleApiError(response);
        }
        
        // Return the response as JSON or throw an error if it's not valid JSON
        const responseText = await response.text();
        try {
            return JSON.parse(responseText) as T;
        } catch (parseError) {
            logger(`GET: JSON parse error. Response text: ${responseText}`);
            throw parseError;
        }
    }
    
    /**
    * Performs a POST request
    * @param endpoint API endpoint
    * @param body Request body
    * @param timeoutMs Optional timeout in milliseconds
    */
    async post<T>(endpoint: string, body: any, timeoutMs?: number): Promise<T> {
        const headers = await this.getAuthHeaders();
        logger(`POST: ${endpoint}`);
        const response = await this.fetchWithTimeout(
            `${this.baseUrl}${endpoint}`,
            { method: 'POST', headers, body: JSON.stringify(body) },
            timeoutMs
        );
        
        if (!response.ok) {
            await this.handleApiError(response);
        }
        
        // Return the response as JSON or throw an error if it's not valid JSON
        const responseText = await response.text();
        try {
            return JSON.parse(responseText) as T;
        } catch (parseError) {
            logger(`POST: JSON parse error. Response text: ${responseText}`);
            throw parseError;
        }
    }
    
    /**
    * Performs a PATCH request
    * @param endpoint API endpoint
    * @param body Request body
    * @param timeoutMs Optional timeout in milliseconds
    */
    async patch<T>(endpoint: string, body: any, timeoutMs?: number): Promise<T> {
        const headers = await this.getAuthHeaders();
        logger(`PATCH: ${endpoint} ${JSON.stringify(body)}`);
        const response = await this.fetchWithTimeout(
            `${this.baseUrl}${endpoint}`,
            { method: 'PATCH', headers, body: JSON.stringify(body) },
            timeoutMs
        );
        
        if (!response.ok) {
            await this.handleApiError(response);
        }
        
        // Return the response as JSON or throw an error if it's not valid JSON
        const responseText = await response.text();
        try {
            return JSON.parse(responseText) as T;
        } catch (parseError) {
            logger(`PATCH: JSON parse error. Response text: ${responseText}`);
            throw parseError;
        }
    }
    
    /**
    * Performs a DELETE request
    * @param endpoint API endpoint
    * @param timeoutMs Optional timeout in milliseconds
    */
    async delete(endpoint: string, timeoutMs?: number): Promise<void> {
        const headers = await this.getAuthHeaders();
        logger(`DELETE: ${endpoint}`);
        const response = await this.fetchWithTimeout(
            `${this.baseUrl}${endpoint}`,
            { method: 'DELETE', headers },
            timeoutMs
        );
        
        if (!response.ok) {
            await this.handleApiError(response);
        }
        
        return;
    }
}