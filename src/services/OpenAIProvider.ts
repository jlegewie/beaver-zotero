/**
* OpenAI API Wrapper for Zotero 7
*
* Wrapper for interacting with OpenAI API that uses Zotero.HTTP.request()
* for network requests.
*
* Usage Example:
*      // Initialize providers
*      const provider = new OpenAIProvider('YOUR_KEY_HERE');
*      const provider_gemini = new GeminiProvider('YOUR_GOOGLE_API_KEY');
* 
*      // Create a chat completion
*      const responseText = await provider.createChatCompletion({
*         model: 'gpt-4',
*         messages: [
*           { role: 'system', content: 'You are a helpful assistant.' },
*           { role: 'user',   content: 'Hello!' },
*         ],
*      });
*      console.log('Completion text: ' + responseText);
*
*      // Create a chat completion with streaming
*      await provider.createChatCompletionStreaming(
*         {
*            model: 'gpt-4',
*            messages: [ ... ],
*            stream: true
*         },
*         (chunk) => {
*            // This callback fires for each text chunk
*            console.log('Stream chunk received: ' + chunk);
*         }
*      );
*
*/


// Single chat message
export interface ChatMessage {
    role: string;
    content: string;
    name?: string;
}

// Request parameters
export interface CreateChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    // Other optional parameters (e.g., top_p, frequency_penalty, presence_penalty, etc.)
    [key: string]: any;
}

// Chat completion response
export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string | null;
    }>;
    [key: string]: any;
}

// Configuration settings for an AI provider
export interface ProviderConfig {
    baseUrl?: string;
    apiKey: string;
    providerName?: string;
}

// Callback signature for streaming tokens (chunks)
export type StreamCallback = (textChunk: string) => void;

/**
* Abstract base class defining a generic AI Provider for
* any OpenAI-like endpoints
*/
export abstract class AIProvider {
    protected baseUrl: string;
    protected apiKey: string;
    protected providerName: string;
    
    constructor(config: ProviderConfig) {
        this.baseUrl = config.baseUrl || '';
        this.apiKey = config.apiKey;
        this.providerName = config.providerName || 'GenericAI';
    }
    
    /**
    * Create a chat completion (non-streaming). Returns the complete text in one shot.
    *
    * @param request A request object specifying model, messages, etc.
    * @returns The assistant's text.
    */
    public async createChatCompletion(request: CreateChatCompletionRequest): Promise<string> {
        // Make sure stream is false
        request.stream = false;
        
        const endpoint = `${this.baseUrl}/chat/completions`;
        const headers = this.buildHeaders();
        let responseText = '';
        
        try {
            const body = JSON.stringify(request);
            
            // Perform the HTTP request via Zotero.HTTP
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const xhr = await Zotero.HTTP.request('POST', endpoint, {
                body,
                headers,
            });
            
            const rawResponse = xhr.responseText;
            if (!rawResponse) {
                throw new Error('No response from OpenAI Chat Completion API.');
            }
            
            // Parse JSON (text at json.choices[0].message.content)
            const json: ChatCompletionResponse = JSON.parse(rawResponse);
            if (
                json.choices &&
                json.choices.length > 0 &&
                json.choices[0].message &&
                json.choices[0].message.content
            ) {
                responseText = json.choices[0].message.content;
            } else {
                // Fallback, log if format unexpected.
                this.logError(`Unexpected response format from OpenAI: ${rawResponse}`);
                responseText = '';
            }
        } catch (e) {
            this.logError(e);
            throw e;
        }
        
        return responseText;
    }
    
    /**
    * Create a chat completion with streaming. Invokes `onChunk` callback for each text chunk.
    *
    * @param request   The Chat Completion request with `stream = true`.
    * @param onChunk   Callback invoked on each partial text update.
    */
    public async createChatCompletionStreaming(
        request: CreateChatCompletionRequest,
        onChunk: StreamCallback
    ): Promise<void> {
        // Must explicitly request streaming from the API
        request.stream = true;
        
        const endpoint = `${this.baseUrl}/chat/completions`;
        const headers = this.buildHeaders();
        let accumulated = ''; // For leftover partial lines when parsing
        let completed = false; // Mark when the final [DONE] arrives or request ends
        
        return new Promise<void>((resolve, reject) => {
            try {
                const body = JSON.stringify(request);
                
                // Build a request observer to handle streaming chunk by chunk
                const requestObserver = (xhr: XMLHttpRequest) => {
                    // number of processed characters
                    let lastPosition = 0;
                    
                    // onprogress is triggered periodically as more data arrives
                    xhr.onprogress = () => {
                        try {
                            const newData = xhr.responseText.substring(lastPosition);
                            lastPosition = xhr.responseText.length;
                            
                            // Append to buffer and parse SSE lines
                            accumulated += newData;
                            const lines = accumulated.split('\n');
                            
                            // Keep the last partial line in 'accumulated' if it didn't end with \n
                            // so we reset accumulated to just that leftover.
                            accumulated = lines.pop() || '';
                            
                            for (const line of lines) {
                                const trimmed = line.trim();
                                // SSE lines begin with "data: "
                                // e.g. data: {"id": "...","object":"chat.completion.chunk", ...}
                                if (trimmed.startsWith('data: ')) {
                                    const sseData = trimmed.replace(/^data: /, '');
                                    if (sseData === '[DONE]') {
                                        // End of stream
                                        completed = true;
                                        break;
                                    }
                                    
                                    // Attempt to parse JSON
                                    try {
                                        const parsed = JSON.parse(sseData);
                                        // For OpenAI's streaming, the text is in parsed.choices[0].delta.content
                                        if (
                                            parsed.choices &&
                                            parsed.choices.length > 0 &&
                                            parsed.choices[0].delta &&
                                            typeof parsed.choices[0].delta.content === 'string'
                                        ) {
                                            onChunk(parsed.choices[0].delta.content);
                                        }
                                    } catch (err) {
                                        // Possibly partial/incomplete JSON
                                        // We log and continue
                                        this.logError(`Failed to parse streaming JSON chunk: ${sseData}`);
                                        this.logError(err);
                                    }
                                }
                            }
                        } catch (err) {
                            this.logError(err);
                            // Non-fatal; keep streaming
                        }
                    };
                    
                    // onreadystatechange=4 => request finished (success or failure)
                    xhr.onreadystatechange = () => {
                        if (xhr.readyState === 4) {
                            // If we haven't gotten an explicit [DONE], consider it ended anyway
                            if (!completed) {
                                completed = true;
                            }
                            
                            // Check status
                            const status = xhr.status;
                            if (status < 200 || status >= 300) {
                                const errMsg = `OpenAI streaming request failed with status ${status}`;
                                this.logError(errMsg);
                                reject(new Error(errMsg));
                                return;
                            }
                            
                            // If done successfully
                            resolve();
                        }
                    };
                };
                
                // Fire off the request
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                Zotero.HTTP.request('POST', endpoint, {
                    body,
                    headers,
                    // The key to streaming is hooking into the XHR events
                    requestObserver,
                    timeout: 0,
                }).catch((err: unknown) => {
                    // If the request fails to even start
                    this.logError(err);
                    reject(err);
                });
            } catch (outerErr) {
                this.logError(outerErr);
                reject(outerErr);
            }
        });
    }
    
    /**
    * Builds standard headers, including Authorization.
    */
    protected buildHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        };
    }
    
    /**
    * Convenience method to log errors to Zotero's error console.
    */
    protected logError(e: unknown): void {
        // @ts-ignore - Zotero global in plugin environment
        Zotero.logError(e);
    }
}

// Generic provider based on OpenAI endpoints (e.g. OpenRouter)
export class GenericProvider extends AIProvider {
    constructor(config: ProviderConfig) {
        super({
            ...config,
            // If user didn't provide a baseUrl, default to OpenAI
            baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
            providerName: config.providerName ?? 'OpenAI',
        });
    }

}

// OpenAI provider
export class OpenAIProvider extends AIProvider {
    constructor(apiKey: string) {
        super({
            baseUrl: 'https://api.openai.com/v1',
            apiKey: apiKey,
            providerName: 'OpenAI',
        });
    }
}

// Gemini provider
export class GeminiProvider extends AIProvider {
    constructor(apiKey: string) {
        super({
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            apiKey,
            providerName: 'Gemini',
        });
    }
}
