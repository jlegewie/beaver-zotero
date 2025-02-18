import { ChatMessage } from "react/atoms/messages";
import { fileToBase64, fileToContentPart } from "./OpenAIProvider";

export const chatCompletion = async (
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onFinish: () => void,
    onError: (error: Error) => void
) => {
    const filePath = '~/Desktop/Screenshot 2025-01-04 at 2.57.28 PM.png'
    // const filePath = '~/Desktop/Dog instruction.pdf'
    const image = await fileToBase64(filePath);

    // LLM provider
    // @ts-ignore Zotero.Beaver defined in hooks.ts
    const provider = Zotero.Beaver.aiProvider;
    const model = (provider.providerName === 'openai') ? 'gpt-4o' : 'gemini-2.0-flash';

    // Request messages 
    const requestMessages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user',   content: [
            { type: 'text',   text: 'Describe this image or pdf.' },
            await fileToContentPart(filePath)]
        },
    ]
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