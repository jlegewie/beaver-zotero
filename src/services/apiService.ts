import { supabase } from './supabaseClient';

/**
* Base API service that handles authentication and common HTTP methods
*/
export class ApiService {
    protected baseUrl: string;
    
    constructor(baseUrl: string) {
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
    * Performs a GET request
    */
    async get<T>(endpoint: string): Promise<T> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status} - ${response.statusText}`);
        }
        
        return response.json() as Promise<T>;
    }
    
    /**
    * Performs a POST request
    */
    async post<T>(endpoint: string, body: any): Promise<T> {
        const headers = await this.getAuthHeaders();
        console.log('headers', headers);
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status} - ${response.statusText}`);
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
            throw new Error(`API error: ${response.status} - ${response.statusText}`);
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
            throw new Error(`API error: ${response.status} - ${response.statusText}`);
        }
        
        return;
    }
}