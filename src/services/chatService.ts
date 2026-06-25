import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ProviderType } from '../../react/atoms/models';
import { CustomChatModel } from '../../react/types/settings';
import { ApiError } from '../../react/types/apiErrors';


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

export type RockPaperScissorsMove = 'rock' | 'paper' | 'scissors';
export type RockPaperScissorsOutcome = 'user' | 'agent' | 'tie';

/**
 * Result of the toy Rock Paper Scissors agent used to validate that a custom
 * model/provider supports streaming + tool calling. Mirrors the backend
 * `RockPaperScissorsTestResult`. The endpoint returns HTTP 200 even when the
 * provider fails (`provider_works: false`); transport/validation problems are
 * surfaced as thrown errors instead.
 */
export interface RockPaperScissorsTestResult {
    provider_works: boolean;
    tool_called?: boolean;
    user_move?: RockPaperScissorsMove | null;
    agent_move?: RockPaperScissorsMove | null;
    result?: RockPaperScissorsOutcome | null;
    agent_message?: string | null;
    error_type?: string | null;
    error_message?: string | null;
    error_details?: string | null;
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

    /**
     * Runs the toy Rock Paper Scissors agent against a custom model/provider to
     * verify that it supports streaming and tool calling end-to-end. Resolves
     * with the test result (including `provider_works: false` when the provider
     * responds but fails the checks). Rejects only on transport, auth, or
     * request-validation errors, with a human-readable message.
     */
    async testCustomProviderRockPaperScissors(
        customModel: CustomChatModel,
        userMove: RockPaperScissorsMove,
    ): Promise<RockPaperScissorsTestResult> {
        try {
            return await this.post<RockPaperScissorsTestResult>(
                '/api/v1/agents/provider-test/rock-paper-scissors',
                { user_move: userMove, custom_model: customModel },
            );
        } catch (error) {
            if (error instanceof ApiError) {
                // FastAPI 4xx responses (e.g. request validation) carry a
                // readable message in `detail`; surface it directly.
                throw new Error(error.message || 'The provider test request was rejected.');
            }
            throw error;
        }
    }
}

// Export a singleton instance for backward compatibility during transition
export const chatService = new ChatService(API_BASE_URL);
