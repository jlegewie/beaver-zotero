import { ApiError, ServerError } from '../../react/types/apiErrors';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { sessionAtom } from '../../react/atoms/auth';

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
    
    /**
    * Gets authentication headers with JWT token if user is signed in
    */
    async getAuthHeaders(): Promise<Record<string, string>> {
        // Get the current session
        const session = store.get(sessionAtom);
        if (!session) {
            throw new ApiError(401, 'User not authenticated');
        }

        const token = session.access_token;
        if (!token) {
            throw new ApiError(401, 'No access token available');
        }

        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        };
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
    * Performs a GET request
    */
    async get<T>(endpoint: string): Promise<T> {
        const headers = await this.getAuthHeaders();
        logger(`GET: ${endpoint}`);
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'GET',
            headers
        });
        
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
    */
    async post<T>(endpoint: string, body: any): Promise<T> {
        const headers = await this.getAuthHeaders();
        logger(`POST: ${endpoint}`);
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        
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
    */
    async patch<T>(endpoint: string, body: any): Promise<T> {
        const headers = await this.getAuthHeaders();
        logger(`PATCH: ${endpoint} ${JSON.stringify(body)}`);
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body)
        });
        
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
    */
    async delete(endpoint: string): Promise<void> {
        const headers = await this.getAuthHeaders();
        logger(`DELETE: ${endpoint}`);
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'DELETE',
            headers
        });
        
        if (!response.ok) {
            await this.handleApiError(response);
        }
        
        return;
    }
}