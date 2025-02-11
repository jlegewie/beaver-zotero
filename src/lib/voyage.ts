/**
* VoyageClient.ts
*
* Voyage AI client for TypeScript.
*
* Usage:
*   const client = new VoyageClient({ apiKey: "YOUR_API_KEY", model: "voyage-3-lite" });
*
*   // Embed a query
*   const queryEmbedding = await client.embedQuery("What is the capital of France?");
*
*   // Embed a document
*   const docEmbedding = await client.embedDocument("Paris is the capital of France.");
*
*   // Rerank documents
*   const results = await client.rerank(
*     "What is the capital of France?",
*     [
*       "Paris is the capital of France.",
*       "France is a country in Europe.",
*       "The Eiffel Tower is in Paris.",
*       "London is the capital of the UK."
*     ],
*     2, // topN
*     "rerank-2-lite"
*   );
*   // results => [{ index: 0, relevance_score: ...}, { index: 2, relevance_score: ...}]
*/

export interface VoyageClientConfig {
    /** Voyage AI API key. */
    apiKey: string;
    /** The default embedding model to use (e.g., "voyage-3-lite"). */
    model?: string;
    /**
    * Base URL for Voyage AI. Defaults to:
    * "https://api.voyageai.com/v1"
    */
    baseUrl?: string;
    /** Max number of retry attempts on transient errors. Defaults to 3. */
    maxRetries?: number;
}

// Response type definitions
interface EmbeddingResponse {
    object: string;
    data: Array<{
        object: string;
        embedding: number[];
        index: number;
    }>;
    model: string;
    usage: {
        total_tokens: number;
    };
}

interface RerankResponse {
    object: string;
    data: Array<{
        index: number;
        relevance_score: number;
        document?: string;
    }>;
    model: string;
    usage: {
        total_tokens: number;
    };
}

export class VoyageClient {
    private apiKey: string;
    private model: string;
    private baseUrl: string;
    private maxRetries: number;
    
    constructor(config: VoyageClientConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model ?? "voyage-3-lite";
        this.baseUrl = config.baseUrl ?? "https://api.voyageai.com/v1";
        this.maxRetries = config.maxRetries ?? 3;
    }
    
    /**
    * Generate an embedding for a single query string.
    * @param query The query to embed.
    */
    public async embedQuery(query: string): Promise<number[]> {
        const embeddings = await this._embed([query], "query");
        return embeddings[0];
    }
    
    /**
    * Generate an embedding for a single document string.
    * @param document The document to embed.
    */
    public async embedDocument(document: string): Promise<number[]> {
        const embeddings = await this._embed([document], "document");
        return embeddings[0];
    }
    
    /**
    * Rerank a list of documents by their relevance to a query.
    * @param query The search query string.
    * @param documents List of strings to be reranked.
    * @param topN If provided, return only the top N results (sorted by score).
    * @param model Name of the reranker model. Defaults to "rerank-2-lite".
    * @param truncation Whether to truncate documents to the model's max length.
    */
    public async rerank(
        query: string,
        documents: string[],
        topN?: number,
        model: string = "rerank-2-lite",
        truncation: boolean = true
    ): Promise<{ index: number; relevance_score: number }[]> {
        const body: Record<string, unknown> = {
            query,
            documents,
            model,
            truncation
        };
        if (typeof topN === "number") {
            body.top_n = topN;
        }
        
        const response = await this._fetchWithBackoff(`${this.baseUrl}/rerank`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Rerank request failed with status ${response.status}: ${errorText}`
            );
        }
        
        const json = await response.json();
        return (json as unknown as RerankResponse).data;
    }
    
    /**
    * Internal method to call the Voyage Embeddings API for one or more texts.
    * @param texts Array of text strings to embed.
    * @param inputType "query" or "document". Helps the model with context.
    */
    private async _embed(
        texts: string[],
        inputType: "query" | "document"
    ): Promise<number[][]> {
        const response = await this._fetchWithBackoff(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                input: texts,
                model: this.model,
                input_type: inputType,
                truncation: true
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Embeddings request failed with status ${response.status}: ${errorText}`
            );
        }
        
        const json = await response.json();
        return (json as unknown as EmbeddingResponse).data.map(item => item.embedding);
    }
    
    /**
    * Internal utility to fetch with a simple exponential backoff on transient errors.
    * Retries on 429 or 5xx statuses, up to maxRetries times.
    */
    private async _fetchWithBackoff(
        url: string,
        options: RequestInit
    ): Promise<Response> {
        let attempt = 0;
        let waitTime = 200; // Initial backoff delay in ms
        
        while (attempt < this.maxRetries) {
            try {
                const response = await fetch(url, options);
                
                // Retry on rate limit (429) or server (5xx) errors
                if (
                    !response.ok &&
                    (response.status === 429 || (response.status >= 500 && response.status < 600))
                ) {
                    if (attempt < this.maxRetries - 1) {
                        await this._delay(waitTime);
                        waitTime *= 2;
                        attempt += 1;
                        continue;
                    }
                }
                
                return response;
            } catch (err) {
                // Network or fetch-level error
                if (attempt < this.maxRetries - 1) {
                    await this._delay(waitTime);
                    waitTime *= 2;
                    attempt += 1;
                } else {
                    throw err;
                }
            }
        }
        
        // Should never get here without returning or throwing
        throw new Error("Failed to fetch after maximum retry attempts");
    }
    
    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
