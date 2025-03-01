import { ChatMessage } from "react/types/messages";
import { APIMessage, ContentPart } from "./OpenAIProvider";
import { sourceToContentParts } from "../../react/utils/contentPartUtils";
import { getZoteroItem } from "../../react/utils/sourceUtils";
import { Source } from "react/types/sources";

const SYSTEM_PROMPT_PATH = `chrome://beaver/content/prompts/chatbot.prompt`

async function chatMessageToRequestMessage(message: ChatMessage, sources: Source[]): Promise<APIMessage> {
    if (message.role === 'user') {
        // Get sources for the message
        const messageSources = sources.filter(r => r.messageId === message.id);
        
        // Flatten sources
        const flattenedSources = messageSources?.flatMap(
            source => source.type === 'zotero_item' && getZoteroItem(source)?.isRegularItem()
                ? source.childItemKeys.map(key => ({...source, itemKey: key}))
                : source
        );

        // Convert sources to content parts
        const sourcesContent: ContentPart[] = [];
        for (const source of flattenedSources || []) {
            const contentParts = await sourceToContentParts(source);
            sourcesContent.push(...contentParts);
        }
        
        // Add the user's message
        const content: ContentPart[] = [
            ...sourcesContent,
            {
                type: 'text',
                text: `# User Query\n${message.content}`
            }
        ];
        
        return {
            role: message.role,
            content: content
        };
    }

    // For non-user messages, return as is
    return {
        role: message.role,
        content: message.content
    };
}

export const chatCompletion = async (
    messages: ChatMessage[],
    sources: Source[],
    onChunk: (chunk: string) => void,
    onFinish: () => void,
    onError: (error: Error) => void
) => {
    // System prompt
    const systemPrompt = await Zotero.File.getResourceAsync(SYSTEM_PROMPT_PATH);

    // Thread messages
    messages = messages.filter(message => !(message.role == 'assistant' && message.content == ''));
    const messagesFormatted = await Promise.all(messages.map(message => chatMessageToRequestMessage(message, sources)));
    console.log('messagesFormatted', messagesFormatted);

    // Request messages
    const requestMessages = [
        { role: 'system', content: systemPrompt },
        ...messagesFormatted,
    ];

    // LLM provider
    // @ts-ignore Zotero.Beaver defined in hooks.ts
    const provider = Zotero.Beaver.aiProvider;
    const model = (provider.providerName === 'openai') ? 'gpt-4o' : 'gemini-2.0-flash';
    
    const request = {
        model: model,
        messages: requestMessages,
    }

    console.log('requestMessages', requestMessages);
    
    // Call chat completion
    try {
        await provider.createChatCompletionStreaming(request, onChunk);
        // Call finish callback
        onFinish();
    } catch (error: any) {        
        // Error classification based on status code
        let errorType = 'unknown';
        let status = -1;
        
        // Try to get status code from the error object
        if ('status' in error) {
            // @ts-ignore - Access status property
            status = error.status || -1;
        }
        
        // Map status codes to error types
        if (status === -1) {
            errorType = 'network';
        } else if (status === 401 || status === 403) {
            errorType = 'auth';
        } else if (status === 400) {
            errorType = 'invalid_request'; // Invalid API key often results in 400
        } else if (status === 429) {
            errorType = 'rate_limit';
        } else if (status === 503 || status === 502 || status === 500) {
            errorType = 'service_unavailable';
        } else if (status >= 400 && status < 500) {
            errorType = 'bad_request';
        } else if (status >= 500) {
            errorType = 'server_error';
        }

        // Create standardized error object
        const enhancedError = error instanceof Error ? error : new Error('API request failed');
        // @ts-ignore - Add errorType
        enhancedError.errorType = errorType;
        
        onError(enhancedError);
    }
}