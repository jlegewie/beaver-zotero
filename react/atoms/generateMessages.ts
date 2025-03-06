import { atom } from 'jotai';
import { ChatMessage, createAssistantMessage, createUserMessage } from '../types/messages';
import { threadMessagesAtom, setMessageStatusAtom, streamToMessageAtom, threadSourcesAtom } from './threads';
import { Source, ZoteroSource } from '../types/sources';
import { createZoteroSource, getChildItems, getZoteroItem, isSourceValid } from '../utils/sourceUtils';
import { resetCurrentSourcesAtom, currentUserMessageAtom } from './input';
import { chatCompletion } from '../../src/services/chatCompletion';

/**
 * Context for the reader.
 */
export type ReaderContext = {
    itemKey: string;
    page: number | null;
    selection: string | null;
}

/**
 * Processes and organizes sources for use in a message.
 * 
 * This function performs the following operations:
 * 1. Organizes sources by associating child sources with their parent sources
 * 2. Ensures regular Zotero items include their best attachment, or fall back to using child items
 * 3. Validates all sources and removes invalid ones
 * 4. Returns sources sorted by timestamp
 * 
 * @param sources - Array of Source objects to be processed
 * @param userMsg - Object containing the user message ID
 * @returns Promise resolving to an array of valid sources sorted by timestamp
 */
async function prepareSources(
    sources: Source[],
    userMsg: { id: string }
): Promise<Source[]> {
    // Keys for regular zotero items
    const regularItemKeys = new Set(
        sources.filter((s) => s.type === 'zotero_item' && s.isRegularItem).map((s) => (s as ZoteroSource).itemKey)
    );

    // Sources that should be added as children of regular items
    const childrenSources = sources.filter((s) => s.type === 'zotero_item' && s.parentKey && regularItemKeys.has(s.parentKey)) as ZoteroSource[];
    const childrenSourcesIds = new Set(childrenSources.map((s) => s.id));

    // Main source list
    const payloadSources = sources.filter((s) => !childrenSourcesIds.has(s.id));
    
    // Add child sources to parent sources
    childrenSources.forEach((childSource) => {
        const parentSource = payloadSources.find((s) => s.type === 'zotero_item' && s.itemKey === childSource.parentKey) as ZoteroSource;
        if (parentSource && !parentSource.childItemKeys.includes(childSource.itemKey)) {
            parentSource.childItemKeys = [...parentSource.childItemKeys, childSource.itemKey];
        }
    });

    // Ensure that regular zotero items include best attachment. If not, return children items as sources.
    const updatedPayloadSources = (await Promise.all(payloadSources.flatMap(async (s) => {
        if (!(s.type === 'zotero_item' && s.isRegularItem)) return s;
        const item = getZoteroItem(s);
        if (!item) return []
        // Return regular item if child items include best attachment
        const bestAttachment = await item.getBestAttachment();
        if (bestAttachment && s.childItemKeys.includes(bestAttachment.key)) return s;
        // Otherwise, return children items
        const childItems = getChildItems(s);
        const childSources = await Promise.all(childItems.map(async (item) => {
            return {
                ...(await createZoteroSource(item)),
                messageId: userMsg.id,
                timestamp: s.timestamp
            } as ZoteroSource;
        }));
        return childSources;
    }))).flat();

    // Filter out invalid sources
    const validSources = updatedPayloadSources.filter(async (s) => await isSourceValid(s));

    // Sort sources by timestamp
    return validSources.sort((a, b) => a.timestamp - b.timestamp);
}


/**
 * Generates a response from the assistant based on the user's message and sources.
 * 
 * This function performs the following operations:
 * 1. Creates a user message from the provided content
 * 2. Creates an assistant message
 * 3. Updates the thread messages atom with the new messages
 * 4. Prepares sources for the chat completion
 * 5. Combines existing thread sources with payload sources
 * 6. Updates the thread sources atom with the new sources
 * 7. Resets the current user message and source after adding to message
 * 8. Executes chat completion
 */
export const generateResponseAtom = atom(
    null,
    async (get, set, payload: {
        content: string;
        sources: Source[];
        readerContext?: ReaderContext;
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
        
        // Prepare sources
        const payloadSources = await prepareSources(payload.sources, userMsg);

        // Combine existing thread sources with payload sources
        const newThreadSources: Source[] = [...threadSources];
        for (const source of payloadSources) {
            newThreadSources.push({...source, messageId: userMsg.id});
        }
        
        // Update thread sources atom
        set(threadSourcesAtom, newThreadSources);

        // Provide reader context sources contain current reader item
        let context: ReaderContext | undefined;
        if (payload.readerContext) {
            const sourceKeys = newThreadSources
                .filter((s) => s.type === 'zotero_item')
                .flatMap((s) => [s.itemKey, ...s.childItemKeys]);
            if (sourceKeys.includes(payload.readerContext.itemKey)) {
                context = payload.readerContext;
            }
        }
        
        // Reset user message and source after adding to message
        set(resetCurrentSourcesAtom);
        set(currentUserMessageAtom, '');
        
        // Execute chat completion
        _processChatCompletion(newMessages, newThreadSources, assistantMsg.id, context, set);
        
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
        _processChatCompletion(newMessages, newThreadSources, assistantMsg.id, undefined, set);
        
        return assistantMsg.id;
    }
);

// Helper function to process chat completion
function _processChatCompletion(
    messages: ChatMessage[],
    sources: Source[],
    assistantMsgId: string,
    context: ReaderContext | undefined,
    set: any
) {
    // Filter out empty assistant messages
    const filteredMessages = messages.filter(
        m => !(m.role === 'assistant' && m.content === '')
    );
    
    chatCompletion(
        filteredMessages,
        sources,
        context,
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