import { atom } from 'jotai';
import { ChatMessage, createAssistantMessage, createUserMessage } from '../types/messages';
import { threadMessagesAtom, setMessageStatusAtom, streamToMessageAtom, currentUserMessageAtom } from './messages';
import { Source } from '../types/resources';
import { isSourceValid } from '../utils/resourceUtils';
import { resetCurrentSourcesAtom, threadSourcesAtom } from './resources';
import { chatCompletion } from '../../src/services/chatCompletion';

export const generateResponseAtom = atom(
    null,
    async (get, set, payload: {
        content: string;
        sources: Source[];
    }) => {
        // Get current messages
        const threadMessages = get(threadMessagesAtom);
        const threadSources = get(threadSourcesAtom);

        // Create user and assistant messages
        const userMsg = createUserMessage(payload.content);
        const assistantMsg = createAssistantMessage();

        // Update thread messages atom
        const newMessages = [...threadMessages, userMsg, assistantMsg];
        set(threadMessagesAtom, newMessages);

        // Update thread source atom
        const newThreadSources: Source[] = [...threadSources];
        if (payload.sources && payload.sources.length > 0) {
            for (const source of payload.sources) {
                if (await isSourceValid(source, true)) {
                    newThreadSources.push({...source, messageId: userMsg.id});
                }
            }
        }
        console.log('validSources', newThreadSources);
        set(threadSourcesAtom, newThreadSources);
        
        // Reset user message and source after adding to message
        set(resetCurrentSourcesAtom);
        set(currentUserMessageAtom, '');
        
        // Execute chat completion
        _processChatCompletion(newMessages, newThreadSources, assistantMsg.id, set);
        
        return assistantMsg.id;
    }
);

export const regenerateFromMessageAtom = atom(
    null,
    async (get, set, messageId: string) => {
        // Get current messages
        const threadMessages = get(threadMessagesAtom);
        const threadSources = get(threadSourcesAtom);

        // Find the index of the message to continue from
        const messageIndex = threadMessages.findIndex(m => m.id === messageId);
        if (messageIndex < 0) return null; // Message not found
        
        // Truncate messages to the specified message
        const truncatedMessages = threadMessages.slice(0, messageIndex);
        const messageIds = truncatedMessages.map(m => m.id);
        
        // Create a new assistant message
        const assistantMsg = createAssistantMessage();
        // Add the assistant message to the new messages
        const newMessages = [...truncatedMessages, assistantMsg];
        
        // Update messages atom
        set(threadMessagesAtom, newMessages);

        // Remove sources for messages after the specified message
        const newThreadSources = threadSources.filter(r => r.messageId && messageIds.includes(r.messageId));
        set(threadSourcesAtom, newThreadSources);
        
        // Execute chat completion
        _processChatCompletion(newMessages, newThreadSources, assistantMsg.id, set);
        
        return assistantMsg.id;
    }
);

// Helper function to process chat completion
function _processChatCompletion(
    messages: ChatMessage[],
    sources: Source[],
    assistantMsgId: string,
    set: any
) {
    // Filter out empty assistant messages
    const filteredMessages = messages.filter(
        m => !(m.role === 'assistant' && m.content === '')
    );
    
    chatCompletion(
        filteredMessages,
        sources,
        (chunk: string) => {
            set(streamToMessageAtom, { id: assistantMsgId, chunk });
        },
        () => {
            set(setMessageStatusAtom, { id: assistantMsgId, status: 'completed' });
        },
        (error: Error) => {
            // @ts-ignore - Custom error properties
            const errorType = error.errorType || 'unknown';
            set(setMessageStatusAtom, { 
                id: assistantMsgId, 
                status: 'error', 
                errorType 
            });
        }
    );
}