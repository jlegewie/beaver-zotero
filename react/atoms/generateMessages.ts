import { atom } from 'jotai';
import { ChatMessage, createAssistantMessage, createUserMessage } from '../types/messages';
import { threadMessagesAtom, setMessageStatusAtom, streamToMessageAtom, threadSourcesAtom, currentThreadIdAtom, addOrUpdateMessageAtom } from './threads';
import { InputSource, ThreadSource } from '../types/sources';
import { createSourceFromAttachmentOrNote, getChildItems, isSourceValid } from '../utils/sourceUtils';
import { resetCurrentSourcesAtom, currentUserMessageAtom } from './input';
import { chatCompletion } from '../../src/services/chatCompletion';
import { ReaderContext } from '../utils/readerUtils';
import { chatService, MessageAttachment } from '../../src/services/chatService';
import { getPref } from '../../src/utils/prefs';
import { AppState } from 'react/ui/types';

const MODE = getPref('mode');

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
    inputSources: InputSource[],
    messageId: string
): Promise<ThreadSource[]> {
    const sourcesFromRegularItems = inputSources
        .filter((s) => s.type === "regularItem")
        .flatMap((s) => getChildItems(s).map((item) => {
            const source = createSourceFromAttachmentOrNote(item);
            return {...source, messageId: messageId, timestamp: s.timestamp};
        })) as ThreadSource[];
    const sourcesFromAttachmentsOrNotes = inputSources
        .filter((s) => s.type !== "regularItem")
        .map((s) => ({
            ...s,
            messageId: messageId
        })) as ThreadSource[];
    const sources = [...sourcesFromRegularItems, ...sourcesFromAttachmentsOrNotes];
    const validSources = await Promise.all(sources.filter(async (s) => await isSourceValid(s)));
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
        sources: InputSource[];
        appState: AppState;
        isLibrarySearch: boolean;
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
        const payloadSources = await prepareSources(payload.sources, userMsg.id);

        // Combine existing thread sources with payload sources
        const newThreadSources: ThreadSource[] = [...threadSources, ...payloadSources];
        
        // Update thread sources atom
        set(threadSourcesAtom, newThreadSources);
        
        // Reset user message and source after adding to message
        set(resetCurrentSourcesAtom);
        set(currentUserMessageAtom, '');
        
        // Execute chat completion
        if (MODE === 'local') {
            _processChatCompletion(newMessages, newThreadSources, assistantMsg.id, undefined, set);
        } else {
            _processChatCompletionViaBackend(
                get(currentThreadIdAtom),
                userMsg.id,         // the ID from createUserMessage
                assistantMsg.id,    // the ID from createAssistantMessage
                userMsg.content,
                payloadSources.map((s) => ({
                    library_id: s.libraryID,
                    zotero_key: s.itemKey
                } as MessageAttachment)),
                payload.appState,
                payload.isLibrarySearch,
                set
            );
        }
        
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
    sources: ThreadSource[],
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

function _processChatCompletionViaBackend(
    currentThreadId: string | null,
    userMessageId: string,
    assistantMessageId: string,
    content: string,
    attachments: MessageAttachment[],
    appState: AppState,
    isLibrarySearch: boolean,
    set: any
) {
    chatService.requestChatCompletion(
        {
            thread_id: currentThreadId,
            user_message_id: userMessageId,
            assistant_message_id: assistantMessageId,
            content: content,
            attachments: attachments,
            app_state: appState,
            is_library_search: isLibrarySearch
        },
        {
            onThread: (newThreadId) => {
                console.log('Current thread ID:', newThreadId);
                set(currentThreadIdAtom, newThreadId);
            },
            onToken: (partial) => {
                // SSE partial chunk → append to the assistant message
                set(streamToMessageAtom, {
                    id: assistantMessageId,
                    chunk: partial
                });
            },
            onToolcall: (data) => {
                const toolcallMessage = data.message;
                if (!toolcallMessage) return;

                const message: ChatMessage = {
                    id: toolcallMessage.id,
                    role: toolcallMessage.role,
                    content: toolcallMessage.content,
                    status: toolcallMessage.status,
                    tool_calls: toolcallMessage.tool_calls,
                };

                set(addOrUpdateMessageAtom, {message});

            },
            onDone: () => {
                // Mark the assistant as completed
                set(setMessageStatusAtom, { id: assistantMessageId, status: 'completed' });
            },
            onError: (errorType) => {
                // Mark the assistant message as error
                set(setMessageStatusAtom, {
                    id: assistantMessageId,
                    status: 'error',
                    errorType
                });
            }
        }
    );
}