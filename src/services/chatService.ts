import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { MessageData, MessageModel, ToolCall } from '../../react/types/chat/apiTypes';
import { ProviderType } from '../../react/atoms/models';
import { CustomChatModel } from '../../react/types/settings';
import { CitationMetadata } from '../../react/types/citations';
import { ZoteroLibrary, ZoteroCollection, ZoteroTag } from '../../react/types/zotero';

export interface ToolRequest {
    function: "rag_search";
    parameters: Record<string, any>;
}

export const search_tool_request: ToolRequest = {
    function: "rag_search",
    // function: "related_items_search",
    parameters: {}
}

export interface MessageSearchFilters {
    libraries: ZoteroLibrary[] | null;
    collections: ZoteroCollection[] | null;
    tags: ZoteroTag[] | null;
}

// Interface for the request body (matching 'ChatCompletionRequest' in backend)
export interface ChatCompletionRequestBody {
    mode?: 'stateful' | 'stateless';
    messages: MessageData[];
    thread_id?: string;
    assistant_message_id?: string;
    user_api_key?: string;
    model_id?: string;
    access_id?: string;
    custom_instructions?: string;
    frontend_version?: string;
    custom_model?: CustomChatModel;
}

export type DeltaType = "reasoning" | "content";

export interface SSECallbacks {
    /**
     * Handles "thread" event when a new thread is created or resumed
     * @param threadId The new thread ID to set in currentThreadIdAtom
     */
    onThread: (threadId: string) => void;
    
    /**
     * Handles "token" event with partial text as it streams in
     * @param messageId ID of the assistant message to append the token to
     * @param delta Text chunk to append to the assistant message
     * @param type Type of delta (e.g. "text", "citation", "image")
     */
    onDelta: (messageId: string, delta: string, type: DeltaType) => void;
    
    /**
     * Handles "message" event to add or update a complete message
     * @param data The complete message object to add or update
     */
    onMessage: (data: MessageModel) => Promise<void>;
    
    /**
     * Handles "toolcall" event when a tool call is received
     * @param messageId ID of the assistant message
     * @param toolcallId ID of the tool call
     * @param toolCall The tool call object
     */
    onToolcall: (messageId: string, toolcallId: string, toolCall: ToolCall) => Promise<void>;

    /**
     * Handles "annotation" event when annotation data is streamed
     * @param messageId ID of the assistant message
     * @param toolcallId ID of the tool call
     * @param annotation Raw annotation payload
     */
    onAnnotation: (
        messageId: string,
        toolcallId: string,
        annotations: Record<string, any>[]
    ) => void;

    /**
     * Handles "citation_metadata" event when a citation metadata is received
     * @param messageId ID of the assistant message
     * @param citationMetadata The citation metadata object
     */
    onCitationMetadata: (messageId: string, citationMetadata: CitationMetadata) => Promise<void>;
    
    /**
     * Handles "complete" event when a message processing is fully complete.
     * @param messageId ID of the completed message.
     */
    onComplete: (messageId: string) => void;
    
    /**
     * Handles "done" event when the assistant completes its response
     * @param messageId ID of the completed message, or null
     */
    onDone: (messageId: string | null) => void;
    
    /**
     * Handles "error" event when an error occurs during processing
     * @param messageId ID of the message to mark as error, or null to create a temporary error message
     * @param errorType Type of error that occurred
     */
    onError: (messageId: string | null, errorType: string, errorMessage?: string) => void;
    
    /**
     * Handles "warning" event when a non-fatal issue occurs
     * @param messageId ID of the message to mark with warning, or null to create a temporary warning
     * @param warningType Type of warning that occurred
     * @param data Additional data related to the warning
     */
    onWarning: (messageId: string | null, warningType: string, message: string, data: any) => Promise<void>;
}


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

    /**
     * Cancels a chat completion
     * @param threadId The ID of the thread to cancel
     * @param assistantMessageId The ID of the assistant message to cancel
     * @param partialContent The partial content of the message to cancel
     */
    async cancelChatCompletion(
        assistantMessageId: string,
        threadId: string,
        partialContent: string
    ): Promise<void> {
        try {
            const endpoint = `${this.baseUrl}/api/v1/chat/cancel`;
            const headers = await this.getAuthHeaders();

            await Zotero.HTTP.request('POST', endpoint, {
                body: JSON.stringify({
                    assistant_message_id: assistantMessageId,
                    thread_id: threadId,
                    partial_content: partialContent
                }),
                headers
            });
            
            Zotero.debug('Chat completion canceled successfully');
        } catch (error) {
            Zotero.debug(`Error canceling chat completion: ${error}`);
        }
    }

    /**
     * requestChatCompletion
     * 
     * Makes a POST request to /chat/completions with SSE streaming. 
     * The backend emits events like:
     * 
     *  event: thread
     *  data: {"thread_id":"<uuid>"}
     *  
     *  event: token
     *  data: {"content":"partial text"}
     *  
     *  event: done
     *  data: null
     *  
     *  event: error
     *  data: {"detail":"..."}
     */
    async requestChatCompletion(
        requestBody: ChatCompletionRequestBody,
        callbacks: SSECallbacks,
        setCanceller?: (canceller: () => void) => void
    ): Promise<void> {
        const {
            onThread,
            onDelta,
            onMessage,
            onToolcall,
            onAnnotation,
            onCitationMetadata,
            onComplete,
            onDone,
            onError,
            onWarning,
        } = callbacks;

        const endpoint = `${this.baseUrl}/api/v1/chat/completions`;
        
        // Get authentication headers
        const headers = await this.getAuthHeaders();

        return new Promise<void>((resolve, reject) => {
            try {
                // Buffer incoming data, parse chunk by chunk
                let buffer = '';
                let lastPosition = 0;
                const doneReceived = false;

                // XHR observer for Zotero
                const requestObserver = (xhr: XMLHttpRequest) => {
                    // Called repeatedly as more data arrives
                    xhr.onprogress = () => {
                        const newData = xhr.responseText.substring(lastPosition);
                        lastPosition = xhr.responseText.length;

                        buffer += newData;
                        let boundaryIndex: number;

                        // SSE events are separated by "\n\n"
                        while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1) {
                            // Extract one full event text
                            const rawEvent = buffer.slice(0, boundaryIndex).trim();
                            buffer = buffer.slice(boundaryIndex + 2); // skip "\n\n"

                            if (rawEvent) {
                                // parse it
                                this.parseAndHandleEvent(rawEvent, {
                                    onThread,
                                    onDelta,
                                    onMessage,
                                    onToolcall,
                                    onAnnotation,
                                    onCitationMetadata,
                                    onComplete,
                                    onDone,
                                    onError,
                                    onWarning
                                });
                            }
                        }
                    };

                    // Called when the request finishes or fails
                    xhr.onreadystatechange = () => {
                        if (xhr.readyState === 4) {
                            // Non-2xx -> error
                            if (xhr.status < 200 || xhr.status >= 300) {
                                this.handleXHRError(xhr, onError);
                                resolve(); // Don't reject since we've handled the error
                                return;
                            }
                            // onDone();
                            resolve();
                        }
                    };
                };

                // Fire off the request
                Zotero.HTTP.request('POST', endpoint, {
                    body: JSON.stringify(requestBody),
                    headers,
                    requestObserver,
                    timeout: 0, // indefinite streaming
                    cancellerReceiver: setCanceller // Pass the canceller function to the caller
                }).catch((err: unknown) => {
                    // Errors are handled in onreadystatechange, which has access
                    // to the xhr object and can provide more specific error types.
                    // This catch is to prevent unhandled promise rejection warnings.
                    Zotero.debug(`Zotero.HTTP.request rejected: ${err}. This is handled by onreadystatechange.`);
                });

            } catch (outerErr) {
                // Some error in constructing the request
                onError(null, 'bad_request');
                reject(outerErr);
            }
        });
    }

    /**
     * parseAndHandleEvent
     * 
     * Splits a raw SSE event into lines, finds `event: ...` and `data: ...`,
     * then dispatches to the appropriate callback.
     */
    private async parseAndHandleEvent(
        rawEvent: string,
        {
            onThread,
            onDelta,
            onMessage,
            onToolcall,
            onAnnotation,
            onCitationMetadata,
            onComplete,
            onDone,
            onError,
            onWarning
        }: {
            onThread: (threadId: string) => void;
            onDelta: (
                messageId: string,
                delta: string,
                type: DeltaType
            ) => void;
            onMessage: (data: MessageModel) => Promise<void>;
            onToolcall: (
                messageId: string,
                toolcallId: string,
                toolCall: ToolCall
            ) => Promise<void>;
            onAnnotation: (
                messageId: string,
                toolcallId: string,
                annotations: Record<string, any>[]
            ) => void;
            onCitationMetadata: (
                messageId: string,
                citationMetadata: CitationMetadata
            ) => Promise<void>;
            onComplete: (messageId: string) => void;
            onDone: (messageId: string | null) => void;
            onError: (messageId: string | null, errorType: string, errorMessage?: string) => void;
            onWarning: (messageId: string | null, warningType: string, message: string, data: any) => Promise<void>;
        }
    ): Promise<void> {
        let eventName = 'message';
        let eventData = '';

        // SSE lines: "event: X" or "data: Y"
        const lines = rawEvent.split('\n');
        for (const line of lines) {
            if (line.startsWith('event: ')) {
                eventName = line.slice(7).trim(); // e.g. "thread", "token", ...
            } else if (line.startsWith('data: ')) {
                // Append it
                const part = line.slice(6).trim();
                eventData += part + '\n';
            }
        }

        eventData = eventData.trim(); // remove trailing newline

        // Attempt to parse JSON in data
        let parsedData: any = null;
        if (eventData) {
            try {
                parsedData = JSON.parse(eventData);
            } catch (error) {
                // If we cannot parse the data, treat as an error
                onError(null, 'server_error');
                return;
            }
        }

        switch (eventName) {
            case 'thread':
                // e.g. data: {"threadId": "uuid"}
                if (parsedData?.threadId) {
                    onThread(parsedData.threadId);
                }
                break;
            case 'delta':
                // e.g. data: {"messageId": "uuid", "token": "some partial text"}
                if (parsedData?.messageId && parsedData?.delta && parsedData?.type) {
                    onDelta(parsedData.messageId, parsedData.delta, parsedData.type);
                }
                // if (parsedData?.id && parsedData?.reasoning)
                break;
            case 'message':
                if (parsedData?.message) {
                    const message = JSON.parse(parsedData.message) as MessageModel;
                    await onMessage(message);
                }
                break;
            case 'toolcall':
                // e.g. data: {"messageId": "uuid", "toolcallId": "uuid", "toolcall": {...}}
                if (parsedData?.messageId && parsedData?.toolcallId && parsedData?.toolcall) {
                    const toolcall = JSON.parse(parsedData.toolcall) as ToolCall;
                    await onToolcall(parsedData.messageId, parsedData.toolcallId, toolcall);
                }
                break;
            case 'annotation':
                if (parsedData?.messageId && parsedData?.toolcallId && parsedData?.annotation) {
                    const annotation =
                        typeof parsedData.annotation === 'string'
                            ? JSON.parse(parsedData.annotation)
                            : parsedData.annotation;
                    const annotations = Array.isArray(annotation) ? annotation : [annotation];
                    onAnnotation(
                        parsedData.messageId,
                        parsedData.toolcallId,
                        annotations
                    );
                }
                break;
            case 'citation_metadata':
                // e.g. data: {"messageId": "uuid", "citationMetadata": {...}}
                if (parsedData?.messageId && parsedData?.metadata) {
                    onCitationMetadata(parsedData.messageId, parsedData.metadata as CitationMetadata);
                }
                break;
            case 'complete':
                // e.g. data: {"messageId": "uuid"}
                if (parsedData?.messageId) {
                    onComplete(parsedData.messageId);
                }
                break;
            case 'done':
                // e.g. data: null
                onDone(parsedData?.messageId || null);
                break;
            case 'error':
                onError(parsedData?.messageId || null, parsedData?.type || 'server_error', parsedData?.message || undefined);
                break;
            case 'warning':
                if (parsedData?.type && parsedData?.message) {
                    await onWarning(parsedData?.messageId || null, parsedData?.type, parsedData?.message, parsedData?.data || null);
                }
                break;
            default:
                // console.log('Unknown SSE event:', eventName, parsedData);
                break;
        }
    }

    /**
     * handleXHRError
     * 
     * Classify an XHR error code into a known errorType, then call onError.
     */
    private handleXHRError(xhr: XMLHttpRequest, onError: (messageId: string | null, errorType: string, errorMessage?: string) => void) {
        let errorType = 'unknown';
        const status = xhr.status;
        if (status === 0) {
            errorType = 'network';
        } else if (status === 401 || status === 403) {
            errorType = 'auth';
        } else if (status === 400) {
            errorType = 'invalid_request';
        } else if (status === 429) {
            errorType = 'beaver_rate_limit';
        } else if (status >= 500) {
            errorType = 'server_error';
        } else if (status >= 400) {
            errorType = 'bad_request';
        }
        onError(null, errorType);
    }
}

// Export a singleton instance for backward compatibility during transition
export const chatService = new ChatService(API_BASE_URL);
