import { ChatMessage } from "../../react/types/chat/ui";
import { APIMessage, ContentPart } from "./OpenAIProvider";
import { sourceToContentParts } from "../../react/utils/contentPartUtils";
import { getZoteroItem } from "../../react/utils/sourceUtils";
import { InputSource, ThreadSource } from "../../react/types/sources";
import { ReaderContext } from "../../react/utils/readerUtils";
import Handlebars from 'handlebars';

// Handlebars helpers
Handlebars.registerHelper('arrayLength', function(array) {
    if (Array.isArray(array)) {
        return array.length;
    } else {
        return 0;
    }
});

Handlebars.registerHelper('identifiers', function(array) {
    if (Array.isArray(array)) {
        return array.map(item => `"${item.identifier}"`).join(', ');
    } else {
        return '';
    }
});

// System prompt path
const SYSTEM_PROMPT_PATH = `chrome://beaver/content/prompts/chatbot.prompt`


async function sourceToRequestMessage(source: ThreadSource): Promise<APIMessage> {
    // Convert sources to content parts
    const sourcesContent = await sourceToContentParts(source);
    
    // Return the sources as a user message
    return {
        role: 'user',
        content: sourcesContent
    } as APIMessage;
}

function chatMessageToRequestMessage(message: ChatMessage): APIMessage {
    // For non-user messages, return as is
    return {
        role: message.role,
        content: message.content
    } as APIMessage;
}

export const chatCompletion = async (
    messages: ChatMessage[],
    sources: ThreadSource[],
    context: ReaderContext | undefined,
    onChunk: (chunk: string) => void,
    onFinish: () => void,
    onError: (error: Error) => void
) => {
    console.log('context', context);
    
    // Compile system prompt
    const systemPromptTemplate = await Zotero.File.getResourceAsync(SYSTEM_PROMPT_PATH);
    const compiledTemplate = Handlebars.compile(systemPromptTemplate, { noEscape: true });
    const attachments = sources.filter(source => source.type === "attachment");
    const notes = sources.filter(source => source.type === "note");
    const systemPrompt = compiledTemplate({ context, attachments, notes });
    console.log('systemPrompt', systemPrompt);

    // Create request messages
    const requestMessages: APIMessage[] = [{ role: 'system', content: systemPrompt }];

    // Thread messages
    for (const message of messages) {
        if (message.content === '' || message.status === 'error') continue;
        // Add sources
        const messageSources = await Promise.all(sources
            .filter(source => source.messageId === message.id)
            .map(source => sourceToRequestMessage(source)));
        requestMessages.push(...messageSources);
        // Add chat message
        requestMessages.push(chatMessageToRequestMessage(message));
    }

    console.log('requestMessages', requestMessages);

    // LLM provider
    // @ts-ignore Zotero.Beaver defined in hooks.ts
    const provider = Zotero.Beaver.aiProvider;
    const model = (provider.providerName === 'openai') ? 'gpt-4o' : 'gemini-2.0-flash';
    
    const request = {
        model: model,
        messages: requestMessages,
    }
    
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