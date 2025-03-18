import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ReaderContext } from 'react/utils/readerUtils';

export interface SSERequestParams {
    threadId: string | null;            // If continuing an existing thread, else null
    userMessageId: string;              // The UUID from the frontend
    assistantMessageId: string;         // The in-progress assistant UUID
    content: string;                    // The user's input text
    sources: string[];                  // The sources to include in the request
    context: ReaderContext | undefined; // Current reader context (e.g. page user is on)
}

// Interface for the request body (matching 'ChatCompletionRequest' in backend)
interface ChatCompletionRequestBody {
    thread_id: string | null;
    user_message_id: string;
    assistant_message_id: string;
    content: string;
    sources: string[];
    metadata?: {
        reader_context: ReaderContext;
    };
}

export interface SSECallbacks {
    onThread: (threadId: string) => void;
    onToken: (token: string) => void;
    onDone: () => void;
    onError: (errorType: string) => void;
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
        params: SSERequestParams,
        callbacks: SSECallbacks
    ): Promise<void> {
        const { threadId, userMessageId, assistantMessageId, content, sources, context } = params;
        const { onThread, onToken, onDone, onError } = callbacks;

        // Construct the request body
        const body: ChatCompletionRequestBody = {
            thread_id: threadId,
            user_message_id: userMessageId,
            assistant_message_id: assistantMessageId,
            content,
            sources
        };
        if (context) {
            body.metadata = {reader_context: context};
        }

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
                                    onDone: () => {
                                        doneReceived = true;
                                        onDone();
                                    },
                                    onError
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
                            // If success but we never got an explicit "done"
                            if (!doneReceived) {
                                onDone();
                            }
                            resolve();
                        }
                    };
                };

                // Fire off the request
                Zotero.HTTP.request('POST', endpoint, {
                    body: JSON.stringify(body),
                    headers,
                    requestObserver,
                    timeout: 0 // indefinite streaming
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
            onDone,
            onError
        }: {
            onThread: (threadId: string) => void;
            onToken: (token: string) => void;
            onDone: () => void;
            onError: (errorType: string) => void;
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
            case 'done':
                // e.g. data: null
                onDone();
                break;
            case 'error':
                // e.g. data: {"detail": "..."}
                onError('server_error');
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
}

// Export a singleton instance for backward compatibility during transition
export const chatService = new ChatService(API_BASE_URL);