import { ChatMessage } from "react/atoms/messages";
import { fileToContentPart, urlToContentPart, APIMessage, ContentPart } from "./OpenAIProvider";

const SYSTEM_PROMPT = `You are a helpful assistant that helps researchers answer questions related to research papers, reports, and other research-related documents.

Answer the users question using the provided documents as source materials. Keep your answer ground in the facts of the documents.

If the documents do not contain information to answer the question, clearly state that.

If there are no provided documents or materials, you can still answer the question based on your knowledge.

Follow these rules when refering to documents:
- Use the bibliographic information to refer to a specific document. For example, you can say "the article titled 'Research on AI'" or "John Doe argues that...".
- Support your statements with source citations that include document id(s) at the end of sentences or paragraphs following best citations practices for an academic researcher. Format citations using the following format:
    - For a single document: "[ID]"
    - For multiple documents: "[ID1, ID2, ID3]"
`

const chatMessageToRequestMessage = async (message: ChatMessage): Promise<APIMessage> => {
    if (message.role === 'user') {
        // Convert attachments to content parts
        const attachmentsContent = await Promise.all(
            (message.attachments || [])
                .filter((attachment) => attachment.valid)
                .map(async (attachment) => {
                    switch (attachment.type) {
                        case 'zotero_item':
                        case 'file':
                            return await fileToContentPart(attachment.filePath!);
                        case 'remote_file':
                            return urlToContentPart(attachment.url);
                        default:
                            return undefined;
                    }
                })
        );
        
        // Add the user's message
        const content: ContentPart[] = [
            ...attachmentsContent.filter((content): content is ContentPart => content !== undefined),
            {
                type: 'text',
                text: message.content
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
    onChunk: (chunk: string) => void,
    onFinish: () => void,
    onError: (error: Error) => void
) => {
    // LLM provider
    // @ts-ignore Zotero.Beaver defined in hooks.ts
    const provider = Zotero.Beaver.aiProvider;
    const model = (provider.providerName === 'openai') ? 'gpt-4o' : 'gemini-2.0-flash';

    // Request messages 
    const requestMessages = [
        {
            role: 'system',
            content: SYSTEM_PROMPT
        },
        ...(await Promise.all(messages.map(chatMessageToRequestMessage))),
    ];
    
    const request = {
        model: model,
        messages: requestMessages,
    }

    // Call chat completion
    try {
        // const response = await provider.createChatCompletion(request);    
        await provider.createChatCompletionStreaming(request, onChunk);
    } catch (error) {
        console.error(error);
        onError(error as Error);
    }

    // Call finish callback
    onFinish();
}