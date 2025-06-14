import { supabase } from './supabaseClient';
import { ApiError, ServerError } from '../../react/types/apiErrors';

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
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        
        return {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        };
    }
    
    /**
    * Handles API response errors and throws appropriate custom errors
    */
    private handleApiError(response: Response): never {
        if (response.status >= 500) {
            throw new ServerError(`Server error: ${response.status} - ${response.statusText}`);
        } else {
            throw new ApiError(response.status, response.statusText);
        }
    }
    
    /**
    * Performs a GET request
    */
    async get<T>(endpoint: string): Promise<T> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            this.handleApiError(response);
        }
        
        return response.json() as Promise<T>;
    }
    
    /**
    * Performs a POST request
    */
    async post<T>(endpoint: string, body: any): Promise<T> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            this.handleApiError(response);
        }
        
        return response.json() as Promise<T>;
    }
    
    /**
    * Performs a PATCH request
    */
    async patch<T>(endpoint: string, body: any): Promise<T> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            this.handleApiError(response);
        }
        
        return response.json() as Promise<T>;
    }
    
    /**
    * Performs a DELETE request
    */
    async delete(endpoint: string): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'DELETE',
            headers
        });
        
        if (!response.ok) {
            this.handleApiError(response);
        }
        
        return;
    }
}