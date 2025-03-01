import { atom } from 'jotai';
import { ChatMessage, createAssistantMessage, createUserMessage } from '../types/messages';
import { threadMessagesAtom, setMessageStatusAtom, streamToMessageAtom, currentUserMessageAtom } from './messages';
import { Resource } from '../types/resources';
import { isResourceValid } from '../utils/resourceUtils';
import { resetCurrentResourcesAtom, threadResourcesAtom } from './resources';
import { chatCompletion } from '../../src/services/chatCompletion';

export const generateResponseAtom = atom(
    null,
    async (get, set, payload: {
        content: string;
        resources: Resource[];
    }) => {
        // Get current messages
        const threadMessages = get(threadMessagesAtom);
        const threadResources = get(threadResourcesAtom);

        // Create user and assistant messages
        const userMsg = createUserMessage(payload.content);
        const assistantMsg = createAssistantMessage();

        // Update thread messages atom
        const newMessages = [...threadMessages, userMsg, assistantMsg];
        set(threadMessagesAtom, newMessages);

        // Update thread resources atom
        const newThreadResources: Resource[] = [...threadResources];
        if (payload.resources && payload.resources.length > 0) {
            for (const resource of payload.resources) {
                if (await isResourceValid(resource, true)) {
                    newThreadResources.push({...resource, messageId: userMsg.id});
                }
            }
        }
        console.log('validResources', newThreadResources);
        set(threadResourcesAtom, newThreadResources);
        
        // Reset user message and resources after adding to message
        set(resetCurrentResourcesAtom);
        set(currentUserMessageAtom, '');
        
        // Execute chat completion
        _processChatCompletion(newMessages, newThreadResources, assistantMsg.id, set);
        
        return assistantMsg.id;
    }
);

export const regenerateFromMessageAtom = atom(
    null,
    async (get, set, messageId: string) => {
        // Get current messages
        const threadMessages = get(threadMessagesAtom);
        const threadResources = get(threadResourcesAtom);

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

        // Remove resources for messages after the specified message
        const newThreadResources = threadResources.filter(r => r.messageId && messageIds.includes(r.messageId));
        set(threadResourcesAtom, newThreadResources);
        
        // Execute chat completion
        _processChatCompletion(newMessages, newThreadResources, assistantMsg.id, set);
        
        return assistantMsg.id;
    }
);

// Helper function to process chat completion
function _processChatCompletion(
    messages: ChatMessage[],
    resources: Resource[],
    assistantMsgId: string,
    set: any
) {
    // Filter out empty assistant messages
    const filteredMessages = messages.filter(
        m => !(m.role === 'assistant' && m.content === '')
    );
    
    chatCompletion(
        filteredMessages,
        resources,
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