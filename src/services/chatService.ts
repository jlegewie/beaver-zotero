import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { MessageModel } from '../../react/types/chat/apiTypes';
import { MessageAttachment, ReaderState } from '../../react/types/attachments/apiTypes';
import { Model, ProviderType } from '../../react/atoms/models';

export interface ToolRequest {
    function: "hybrid_search" | "related_items_search";
    parameters: Record<string, any>;
}

export const search_tool_request: ToolRequest = {
    function: "hybrid_search",
    // function: "related_items_search",
    parameters: {}
}

// Interface for the request body (matching 'ChatCompletionRequest' in backend)
export interface ChatCompletionRequestBody {
    thread_id: string | null;           // If continuing an existing thread, else null
    user_message_id: string;            // The UUID from the frontend
    assistant_message_id: string;       // The in-progress assistant UUID
    content: string;                    // The user's input text
    user_api_key: string | null;        // The user's API key, if provided
    model: Model;                       // The model to use for the request
    custom_instructions?: string;       // Custom instructions for the assistant
    attachments: MessageAttachment[];   // The attachments to include in the request
    tool_request: ToolRequest | null;   // User tool request, if any
    reader_state: ReaderState | null;   // Reader state, if any
}

export interface SSECallbacks {
    // Callback for "thread" event: called when a new thread is created or resumed.
    //      Sets currentThreadIdAtom to the new thread ID.
    onThread: (threadId: string) => void;
    // Callback for "token" event: receives partial text as it comes in.
    //      Appends chunk to the assistant message with id=assistantMessageId.
    onToken: (token: string) => void;
    // Callback for "message" event: adds or updates message of type MessageModel.
    //    When completed, adds attachments from tool responses (if any) to the thread sources.
    onMessage: (data: MessageModel) => void;
    // Callback for "toolcall" event (obsolete): adds or updates message of type MessageModel.
    //    When completed, adds attachments from tool responses (if any) to the thread sources.
    onToolcall: (data: MessageModel) => void;
    // Callback for "done" event: called when the assistant is done.
    onDone: () => void;
    // Callback for "error" event: called when an error occurs.
    onError: (errorType: string) => void;
    // Callback for "warning" event: called when a warning occurs.
    onWarning: (warningType: string, data: any) => void;
}


export type ErrorType = "AuthenticationError" | "PermissionDeniedError" | "RateLimitError" | "UnexpectedError";

export interface VerifyKeyRequest {
    provider: ProviderType;
    user_api_key: string;
}

export interface VerifyKeyResponse {
    valid: boolean;
    error_type?: ErrorType;
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
            const endpoint = `${this.baseUrl}/chat/verify-key`;
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
            const endpoint = `${this.baseUrl}/chat/cancel`;
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
        const { onThread, onToken, onMessage, onToolcall, onDone, onError, onWarning } = callbacks;

        const endpoint = `${this.baseUrl}/chat/completions`;
        
        // Get authentication headers
        const headers = await this.getAuthHeaders();

        return new Promise<void>((resolve, reject) => {
            try {
                // Buffer incoming data, parse chunk by chunk
                let buffer = '';
                let lastPosition = 0;
                let doneReceived = false;

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
                                    onToken,
                                    onMessage,
                                    onToolcall,
                                    onDone: () => {
                                        doneReceived = true;
                                        onDone();
                                    },
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
                                reject(xhr.status);
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
                    // If the request fails to even start (network error)
                    onError('network');
                    reject(err);
                });

            } catch (outerErr) {
                // Some error in constructing the request
                onError('bad_request');
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
    private parseAndHandleEvent(
        rawEvent: string,
        {
            onThread,
            onToken,
            onMessage,
            onToolcall,
            onDone,
            onError,
            onWarning
        }: {
            onThread: (threadId: string) => void;
            onToken: (token: string) => void;
            onMessage: (data: MessageModel) => void;
            onToolcall: (data: MessageModel) => void;
            onDone: () => void;
            onError: (errorType: string) => void;
            onWarning: (type: string, data: any) => void;
        }
    ): void {
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
                onError('server_error');
                return;
            }
        }

        switch (eventName) {
            case 'thread':
                // e.g. data: {"thread_id": "uuid"}
                if (parsedData?.thread_id) {
                    onThread(parsedData.thread_id);
                }
                break;
            case 'token':
                // e.g. data: {"content": "some partial text"}
                if (parsedData?.content) {
                    onToken(parsedData.content);
                }
                break;
            case 'message':
                if (parsedData?.message) {
                    const message = JSON.parse(parsedData.message) as MessageModel;
                    onMessage(message);
                }
                break;
            case 'toolcall':
                // e.g.
                //  data: {"id": "...", "function": "search", "status": "start"}
                //  data: {"id": "...", "function": "search", "status": "results", "results": [...]}
                //  data: {"id": "...", "function": "search", "status": "complete"}
                //  data: {"id": "...", "function": "search", "status": "error", "error": "..."}
                if (parsedData?.message) {
                    const message = JSON.parse(parsedData.message) as MessageModel;
                    onToolcall(message);
                }
                break;
            case 'done':
                // e.g. data: null
                onDone();
                break;
            case 'error':
                onError(parsedData.type || 'server_error');
                break;
            case 'warning':
                if (parsedData?.type) {
                    onWarning(parsedData.type, parsedData?.data || null);
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
    private handleXHRError(xhr: XMLHttpRequest, onError: (err: string) => void) {
        let errorType = 'unknown';
        const status = xhr.status;
        if (status === 0) {
            errorType = 'network';
        } else if (status === 401 || status === 403) {
            errorType = 'auth';
        } else if (status === 400) {
            errorType = 'invalid_request';
        } else if (status === 429) {
            errorType = 'rate_limit';
        } else if (status >= 500) {
            errorType = 'server_error';
        } else if (status >= 400) {
            errorType = 'bad_request';
        }
        onError(errorType);
    }

    /**
     * Fetches the list of models supported by the backend
     * @returns Promise resolving to an array of supported models
     */
    async getModelList(): Promise<Model[]> {
        try {
            const endpoint = `${this.baseUrl}/chat/model-list`;
            const headers = await this.getAuthHeaders();
            
            const response = await Zotero.HTTP.request('GET', endpoint, {
                headers,
                responseType: 'json'
            });
            
            return response.response as Model[];
        } catch (error) {
            Zotero.debug(`ChatService: getModelList error - ${error}`, 1);
            // Return empty array on error
            return [];
        }
    }
}

// Export a singleton instance for backward compatibility during transition
export const chatService = new ChatService(API_BASE_URL);