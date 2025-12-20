import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ProviderType } from '../../react/atoms/models';


export type ErrorType = "AuthenticationError" | "PermissionDeniedError" | "RateLimitError" | "UnexpectedError" | "VerificationRequiredError";

export interface VerifyKeyRequest {
    provider: ProviderType;
    user_api_key: string;
}

export interface VerifyKeyResponse {
    valid: boolean;
    message?: string;
    error_type?: ErrorType;
    streaming_valid?: boolean;
    streaming_error_type?: ErrorType;
}

/**
 * Service for handling Chat-related API requests with Server-Sent Events (SSE)
 */
export class ChatService extends ApiService {
    /**
     * Creates a new ChatService instance
     * @param baseUrl The base URL of the backend API
     */
    constructor(baseUrl: string) {
        super(baseUrl);
    }

    /**
     * Verifies if a user-provided API key is valid for the specified provider
     * @param provider The LLM provider (anthropic, google, openai)
     * @param userApiKey The API key to verify
     * @returns Promise resolving to a verification response with valid status and optional error
     */
    async verifyApiKey(provider: ProviderType, userApiKey: string): Promise<VerifyKeyResponse> {
        try {
            const endpoint = `${this.baseUrl}/api/v1/chat/verify-key`;
            const headers = await this.getAuthHeaders();
            
            const requestBody: VerifyKeyRequest = {
                provider,
                user_api_key: userApiKey
            };

            const response = await Zotero.HTTP.request('POST', endpoint, {
                body: JSON.stringify(requestBody),
                headers,
                responseType: 'json'
            });
            
            return response.response as VerifyKeyResponse;
        } catch (error) {
            Zotero.debug(`ChatService: verifyApiKey error - ${error}`, 1);
            
            // If we can't reach the endpoint or get a response, return an error
            return {
                valid: false,
                error_type: 'UnexpectedError'
            };
        }
    }
}

// Export a singleton instance for backward compatibility during transition
export const chatService = new ChatService(API_BASE_URL);
