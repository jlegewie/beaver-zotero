import { atom } from 'jotai';
import { ChatMessage, createAssistantMessage, createUserMessage } from '../types/messages';
import { messagesAtom, setMessageStatusAtom, streamToMessageAtom, currentUserMessageAtom } from './messages';
import { Resource } from '../types/resources';
import { isResourceValid } from '../utils/resourceUtils';
import { resetResourcesAtom } from './resources';
import { chatCompletion } from '../../src/services/chatCompletion';

export const generateResponseAtom = atom(
    null,
    async (get, set, payload: {
        content: string;
        resources?: Resource[];
    }) => {
        // Get current messages
        const messages = get(messagesAtom);
        
        // Validate resources if provided
        const validResources: Resource[] = [];
        if (payload.resources && payload.resources.length > 0) {
            for (const resource of payload.resources) {
                if (await isResourceValid(resource, true)) {
                    validResources.push(resource);
                }
            }
        }
        console.log('validResources', validResources);
        
        // Create user message
        const userMsg = createUserMessage({
            content: payload.content,
            resources: validResources,
        });
        
        // Create assistant message
        const assistantMsg = createAssistantMessage();
        
        // Update messages atom
        const newMessages = [...messages, userMsg, assistantMsg];
        set(messagesAtom, newMessages);
        
        // Reset user message andresources after adding to message
        set(resetResourcesAtom);
        set(currentUserMessageAtom, '');
        
        // Execute chat completion
        _processChatCompletion(newMessages, assistantMsg.id, set);
        
        return assistantMsg.id;
    }
);

export const regenerateFromMessageAtom = atom(
    null,
    async (get, set, messageId: string) => {
        // Get current messages
        const messages = get(messagesAtom);
        
        // Find the index of the message to continue from
        const messageIndex = messages.findIndex(m => m.id === messageId);
        if (messageIndex < 0) return null; // Message not found
        
        // Truncate messages to the specified message
        const truncatedMessages = messages.slice(0, messageIndex);
        
        // Create a new assistant message
        const assistantMsg = createAssistantMessage();
        const newMessages = [...truncatedMessages, assistantMsg];
        
        // Update messages atom
        set(messagesAtom, newMessages);
        
        // Execute chat completion
        _processChatCompletion(newMessages, assistantMsg.id, set);
        
        return assistantMsg.id;
    }
);

// Helper function to process chat completion
function _processChatCompletion(
    messages: ChatMessage[],
    assistantMsgId: string,
    set: any
) {
    // Filter out empty assistant messages
    const filteredMessages = messages.filter(
        m => !(m.role === 'assistant' && m.content === '')
    );
    
    chatCompletion(
        filteredMessages,
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