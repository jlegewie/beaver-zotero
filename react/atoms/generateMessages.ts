import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { ChatMessage, createAssistantMessage, createUserMessage, Warning } from '../types/chat/uiTypes';
import { MessageModel } from '../types/chat/apiTypes';
import { MessageAttachment, ReaderAttachment, SourceAttachment } from '../types/attachments/apiTypes';
import {
    threadMessagesAtom,
    setMessageStatusAtom,
    streamToMessageAtom,
    threadSourcesAtom,
    currentThreadIdAtom,
    addOrUpdateMessageAtom,
    addToolCallSourcesToThreadSourcesAtom,
    cancellerHolder,
    isCancellableAtom,
    isCancellingAtom,
    cancelStreamingMessageAtom
} from './threads';
import { InputSource, ThreadSource } from '../types/sources';
import { createSourceFromAttachmentOrNote, getChildItems, isSourceValid } from '../utils/sourceUtils';
import { resetCurrentSourcesAtom, currentMessageContentAtom, currentReaderAttachmentAtom, currentSourcesAtom, readerAnnotationsAtom, readerTextSelectionAtom } from './input';
import { chatCompletion } from '../../src/services/chatCompletion';
import { ReaderContext, getCurrentPage } from '../utils/readerUtils';
import { chatService, search_tool_request, ChatCompletionRequestBody } from '../../src/services/chatService';
import { Model, selectedModelAtom, DEFAULT_MODEL } from './models';
import { getPref } from '../../src/utils/prefs';
import { toMessageUI } from '../types/chat/converters';
import { store } from '../index';
import { toMessageAttachment, toThreadSource } from '../types/attachments/converters';
import { logger } from '../../src/utils/logger';
import { uint8ArrayToBase64 } from '../utils/fileUtils';

const MODE = getPref('mode');

/**
 * Flattens sources from regular items, attachments, notes, and annotations.
 * 
 * @param inputSources - Array of InputSource objects to be flattened
 * @returns Array of ThreadSource objects
 */
function flattenSources(
    inputSources: InputSource[]
): ThreadSource[] {
    // Flatten regular item attachments
    const sourcesFromRegularItems = inputSources
        .filter((s) => s.type === "regularItem")
        .flatMap((s) => getChildItems(s).map((item) => {
            const source = createSourceFromAttachmentOrNote(item);
            return {...source, timestamp: s.timestamp};
        })) as ThreadSource[];
    
    // Source, note, and annotation attachments
    const otherSources = (inputSources
        .filter((s) => s.type === "attachment" || s.type === "note"  || s.type === "annotation")) as ThreadSource[];
    
    // Return flattened sources
    return [...sourcesFromRegularItems, ...otherSources];
}

/**
 * Validates sources and removes invalid ones.
 * 
 * @param sources - Array of ThreadSource objects to be validated
 * @returns Array of valid sources sorted by timestamp
 */
async function validateSources(
    sources: ThreadSource[]
): Promise<ThreadSource[]> {
    const validSources = await Promise.all(sources.filter(async (s) => await isSourceValid(s)));
    return validSources.sort((a, b) => a.timestamp - b.timestamp);
}


export async function getCurrentReaderAttachment(): Promise<ReaderAttachment | null> {
    // Get current reader attachment
    const readerSource = store.get(currentReaderAttachmentAtom);
    if (!readerSource || readerSource.type !== "reader") {
        return null;
    }

    // Text selection
    const currentTextSelection = store.get(readerTextSelectionAtom);
    
    // Annotations from readerAnnotationsAtom
    const annotations = store.get(readerAnnotationsAtom)
        .filter((a) => 
            (a.annotation_type === 'underline' && (a.text || a.comment)) ||
            (a.annotation_type === 'highlight' && (a.text || a.comment)) ||
            (a.annotation_type === 'note' && (a.text || a.comment)) ||
            (a.annotation_type === 'image')
        );
    
    // Process image annotations to add base64 data
    const processedAnnotations = await Promise.all(
        annotations.map(async (annotation) => {
            // Only process image annotations
            if (annotation.annotation_type !== 'image') {
                return annotation;
            }

            // Create a reference to the Zotero item
            const item = {
                libraryID: annotation.library_id,
                key: annotation.zotero_key
            };

            // Check if image exists in cache
            const hasCachedImage = await Zotero.Annotations.hasCacheImage(item);
            if (!hasCachedImage) {
                logger(`getCurrentReaderAttachment: No cached image found for annotation ${annotation.zotero_key}`);
                return annotation;
            }

            try {
                // Get image path
                const imagePath = Zotero.Annotations.getCacheImagePath(item);
                
                // Read the image file and convert to base64
                const imageData = await IOUtils.read(imagePath);
                const image_base64 = uint8ArrayToBase64(imageData);
                
                // Return annotation with image data
                return {
                    ...annotation,
                    image_base64: image_base64
                };
            } catch (error) {
                logger(`getCurrentReaderAttachment: Failed to process image for annotation ${annotation.zotero_key}: ${error}`);
                return annotation;
            }
        })
    );

    // ReaderAttachment
    return {
        type: "reader",
        library_id: readerSource.libraryID,
        zotero_key: readerSource.itemKey,
        current_page: getCurrentPage() || 0,
        ...(currentTextSelection && { text_selection: currentTextSelection }),
        annotations: processedAnnotations
    } as ReaderAttachment;
}


export async function getCurrentMessageAttachments(sources?: InputSource[]): Promise<MessageAttachment[]> {
    // Get attachments
    sources = sources || store.get(currentSourcesAtom);
    
    // Message attachments
    const attachments: MessageAttachment[] = [];

    // Reader Attachment
    const readerAttachment = await getCurrentReaderAttachment();
    if (readerAttachment) {
        attachments.push(readerAttachment);
    }
    
    // Source attachments
    for(const source of sources) {
        if (source.type === "reader") continue;
        attachments.push(...await toMessageAttachment(source));
    }
    return attachments;
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
        isLibrarySearch: boolean;
    }) => {
        // Get current model
        const model = get(selectedModelAtom);

        // Create user and assistant messages
        const userMsg = createUserMessage(payload.content);
        const assistantMsg = createAssistantMessage();

        // Update thread messages atom
        const threadMessages = get(threadMessagesAtom);
        const newMessages = [...threadMessages, userMsg, assistantMsg];
        set(threadMessagesAtom, newMessages);
        
        // Prepare sources
        const flattenedSources = flattenSources(payload.sources);
        const validatedSources = await validateSources(flattenedSources);

        // Convert sources to MessageAttachments
        const readerAttachment = await getCurrentReaderAttachment();
        const userAttachments = await Promise.all(
            validatedSources
                .filter((s) => !readerAttachment || s.itemKey !== readerAttachment.zotero_key)
                .map(async (s) => await toMessageAttachment(s))
        );
        const messageAttachments: MessageAttachment[] = [
            ...userAttachments.flat(),
            ...(readerAttachment ? [readerAttachment] : [])
        ];

        // Update thread sources
        const newThreadSources = await Promise.all(messageAttachments.map(a => toThreadSource(a, userMsg.id)));
        set(threadSourcesAtom, (prev) => 
            [...prev, ...newThreadSources.filter(Boolean) as ThreadSource[]]);
        
        // Reset user message and source after adding to message
        set(resetCurrentSourcesAtom);
        set(currentMessageContentAtom, '');
        
        // Execute chat completion
        _processChatCompletionViaBackend(
            get(currentThreadIdAtom),
            userMsg.id,         // the ID from createUserMessage
            assistantMsg.id,    // the ID from createAssistantMessage
            userMsg.content,
            messageAttachments,
            payload.isLibrarySearch,
            model,
            set,
            get
        );
        
        return assistantMsg.id;
    }
);

function findLastUserMessageIndexBefore(messages: ChatMessage[], beforeIndex: number) {
    if (messages[beforeIndex]?.role === 'user') {
        return beforeIndex;
    }
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            return i;
        }
    }
    return -1;
}


export const regenerateFromMessageAtom = atom(
    null,
    async (get, set, assistantMessageId: string) => {
        // Get current messages and sources
        const threadMessages = get(threadMessagesAtom);
        const threadSources = get(threadSourcesAtom);
        const currentThreadId = get(currentThreadIdAtom);
        const model = get(selectedModelAtom);
        if (!currentThreadId) return null;

        // Find the index of the last user message
        const messageIndex = threadMessages.findIndex(m => m.id === assistantMessageId);
        if (messageIndex < 0) return null; // Message not found
        const lastUserMessageIndex = findLastUserMessageIndexBefore(threadMessages, messageIndex);
        const userMessageId = threadMessages[lastUserMessageIndex].id;
        if (lastUserMessageIndex < 0) return null;
        
        // Truncate messages
        const truncatedMessages = threadMessages.slice(0, lastUserMessageIndex + 1);
        
        // New assistant message
        const assistantMsg = createAssistantMessage();

        // Add the assistant message to the new messages
        const newMessages = [...truncatedMessages, assistantMsg];

        // Update messages atom
        set(threadMessagesAtom, newMessages);

        // Update sources
        // TODO: tool calls sources missing (and app state??)
        const messageIds = truncatedMessages.map(m => m.id);
        const newThreadSources = threadSources.filter(r => r.messageId && messageIds.includes(r.messageId));
        set(threadSourcesAtom, newThreadSources);
        
        // Execute chat completion
        if (MODE === 'local') {
            console.error('Local mode not supported for regenerateFromMessage');
        } else {
            _processChatCompletionViaBackend(
                currentThreadId,
                userMessageId,      // existing user message ID
                assistantMsg.id,    // new assistant message ID
                "",                 // content remains unchanged
                [],                 // sources remain unchanged
                false,              // isLibrarySearch remains unchanged
                model,
                set,
                get
            );
        }
        
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
            set(setMessageStatusAtom, { id: assistantMsgId, status: 'error', errorType });
        }
    );
}

function _processChatCompletionViaBackend(
    currentThreadId: string | null,
    userMessageId: string,
    assistantMessageId: string,
    content: string,
    attachments: MessageAttachment[],
    isLibrarySearch: boolean,
    model: Model,
    set: any,
    get: any
) {
    // Set user API key
    let userApiKey = undefined;
    if (!model.app_key) {
        if (model.provider === 'google') {
            userApiKey = getPref('googleGenerativeAiApiKey') || undefined;
        } else if (model.provider === 'openai') {
            userApiKey = getPref('openAiApiKey') || undefined;
        } else if (model.provider === 'anthropic') {
            userApiKey = getPref('anthropicApiKey') || undefined;
        }
        if (!userApiKey) {
            model = DEFAULT_MODEL;
        }
    }

    // Set payload
    const payload = {
        thread_id: currentThreadId,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        content: content,
        attachments: attachments,
        tool_request: isLibrarySearch ? search_tool_request : null,
        custom_instructions: getPref('customInstructions') || undefined,
        user_api_key: userApiKey,
        model: model
    } as ChatCompletionRequestBody;

    // request chat completion
    chatService.requestChatCompletion(
        payload,
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
            onToolcall: async (data: MessageModel) => {
                if (!data) return;

                const message = toMessageUI(data);
                // Add the message to the thread
                set(addOrUpdateMessageAtom, {message, beforeId: assistantMessageId});
                // Add the tool call sources to the thread sources
                if (message.status === 'completed') {
                    set(addToolCallSourcesToThreadSourcesAtom, {messages: [message]});
                }
            },
            onDone: () => {
                // Mark the assistant as completed
                set(setMessageStatusAtom, { id: assistantMessageId, status: 'completed' });
                // Clear the holder and the cancellable state
                cancellerHolder.current = null;
                set(isCancellableAtom, false);
            },
            onError: (errorType) => {
                const isCancelling = get(isCancellingAtom);
                if (isCancelling) {
                    // Cancel the message
                    set(cancelStreamingMessageAtom, { assistantMessageId });
                } else {
                    // Mark the assistant message as error
                    set(setMessageStatusAtom, {
                        id: assistantMessageId,
                    status: 'error',
                        errorType
                    });
                }
                // Clear the holder and the cancellable state
                cancellerHolder.current = null;
                set(isCancellableAtom, false);
            },
            onWarning: (type: string, data: any) => {
                // Warning
                const warning = {id: uuidv4(), type: type} as Warning;
                if (data && data.attachments) {
                    warning.attachments = data.attachments as SourceAttachment[];
                }
                // Add the warning message for the assistant message
                set(setMessageStatusAtom, {
                    id: assistantMessageId,
                    warnings: [warning]
                });
                console.log(type)
                console.log(data)
            }
        },
        // Store the canceller function directly in the holder
        // and update the boolean state atom (potentially async)
        (canceller) => {
            console.log('Received canceller, storing in holder:', canceller);
            cancellerHolder.current = canceller;
            // Update the boolean atom asynchronously to avoid sync interference
            setTimeout(() => {
                set(isCancellableAtom, true);
            }, 0);
        }
    );
}