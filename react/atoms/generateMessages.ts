import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { ChatMessage, createAssistantMessage, createUserMessage, Warning } from '../types/chat/uiTypes';
import { MessageModel, ToolCall, ZoteroItemReference } from '../types/chat/apiTypes';
import { isAnnotationAttachment, MessageAttachment, ReaderState, SourceAttachment } from '../types/attachments/apiTypes';
import {
    threadMessagesAtom,
    setMessageStatusAtom,
    streamToMessageAtom,
    threadSourcesAtom,
    currentThreadIdAtom,
    addOrUpdateMessageAtom,
    addOrUpdateToolcallAtom,
    addToolCallSourcesToThreadSourcesAtom,
    cancellerHolder,
    isCancellableAtom,
    isCancellingAtom,
    cancelStreamingMessageAtom,
    isChatRequestPendingAtom,
    currentAssistantMessageIdAtom
} from './threads';
import { InputSource, ThreadSource } from '../types/sources';
import { createSourceFromAttachmentOrNote, getChildItems, isSourceValid } from '../utils/sourceUtils';
import { resetCurrentSourcesAtom, currentMessageContentAtom, currentReaderAttachmentAtom, currentSourcesAtom, readerTextSelectionAtom } from './input';
import { chatCompletion } from '../../src/services/chatCompletion';
import { ReaderContext, getCurrentPage } from '../utils/readerUtils';
import { chatService, search_tool_request, ChatCompletionRequestBody, DeltaType } from '../../src/services/chatService';
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


export function getCurrentReaderState(): ReaderState | null {
    // Get current reader attachment
    const readerSource = store.get(currentReaderAttachmentAtom);
    if (!readerSource || readerSource.type !== "reader") {
        return null;
    }

    // Text selection
    const currentTextSelection = store.get(readerTextSelectionAtom);
    
    // Return ReaderState
    return {
        library_id: readerSource.libraryID,
        zotero_key: readerSource.itemKey,
        current_page: getCurrentPage() || 0,
        ...(currentTextSelection && { text_selection: currentTextSelection })
    } as ReaderState;
}


export async function getCurrentMessageAttachments(sources?: InputSource[]): Promise<MessageAttachment[]> {
    // Get attachments
    sources = sources || store.get(currentSourcesAtom);
    
    // Message attachments
    const attachments: MessageAttachment[] = [];
    
    // Source attachments
    for(const source of sources) {
        if (source.type === "reader") continue;
        attachments.push(...await toMessageAttachment(source));
    }
    return attachments;
}

/**
 * Processes annotation attachments of type image to add base64 data.
 * 
 * @param attachments - Array of MessageAttachment objects to process
 * @returns Array of MessageAttachment objects with base64 data
 */
export async function processImageAnnotations(attachments: MessageAttachment[]): Promise<MessageAttachment[]> {
    // Process image annotations to add base64 data
    const processedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
            // Only process AnnotationAttachment of type image
            if (!isAnnotationAttachment(attachment)) return attachment;
            if (attachment.annotation_type !== 'image') return attachment;

            // Create a reference to the Zotero item
            const item = {
                libraryID: attachment.library_id,
                key: attachment.zotero_key
            };

            // Check if image exists in cache
            const hasCachedImage = await Zotero.Annotations.hasCacheImage(item);
            if (!hasCachedImage) {
                logger(`processImageAnnotations: No cached image found for attachment ${attachment.zotero_key}`);
                return attachment;
            }

            try {
                // Get image path
                const imagePath = Zotero.Annotations.getCacheImagePath(item);
                
                // Read the image file and convert to base64
                const imageData = await IOUtils.read(imagePath);
                const image_base64 = uint8ArrayToBase64(imageData);
                
                // Return attachment with image data
                return {
                    ...attachment,
                    image_base64: image_base64
                };
            } catch (error) {
                logger(`processImageAnnotations: Failed to process image for attachment ${attachment.zotero_key}: ${error}`);
                return attachment;
            }
        })
    );
    return processedAttachments;
}

/**
 * Generates a response from the assistant based on the user's message and sources.
 * 
 * This function:
 * 1. Creates user and assistant messages
 * 2. Adds them to the thread messages
 * 3. Processes input sources (flattens and validates them)
 * 4. Converts validated sources to message attachments
 * 5. Processes image annotations to include base64 data when available
 * 6. Updates thread sources with the new attachments
 * 7. Resets user input state (message content and sources)
 * 8. Initiates chat completion via the backend service
 * 
 * @returns The ID of the created assistant message
 */
export const generateResponseAtom = atom(
    null,
    async (get, set, payload: {
        content: string;
        sources: InputSource[];
        isLibrarySearch: boolean;
    }) => {
        set(isChatRequestPendingAtom, true);

        // Get current model
        const model = get(selectedModelAtom);

        // Create user and assistant messages
        const userMsg = createUserMessage(payload.content);
        const assistantMsg = createAssistantMessage({status: 'in_progress'});

        // Update thread messages atom
        const threadMessages = get(threadMessagesAtom);
        const newMessages = [...threadMessages, userMsg, assistantMsg];
        set(threadMessagesAtom, newMessages);
        set(currentAssistantMessageIdAtom, assistantMsg.id);

        // Prepare sources
        const flattenedSources = flattenSources(payload.sources);
        const validatedSources = await validateSources(flattenedSources);

        // Convert sources to MessageAttachments and process image annotations
        const messageAttachments = await Promise.all(validatedSources.map(async (s) => await toMessageAttachment(s)))
            .then(attachments => processImageAnnotations([...attachments.flat()]));

        // Get current reader state and add to message attachments if not already in the thread
        const readerState = getCurrentReaderState();
        const currentThreadAttachments = get(threadSourcesAtom).map(s => `${s.libraryID}-${s.itemKey}`);
        if(readerState && !currentThreadAttachments.includes(`${readerState.library_id}-${readerState.zotero_key}`)) {
            logger(`generateResponseAtom: Adding reader state to message attachments: ${readerState.library_id}-${readerState.zotero_key}`);
            // TODO: we could use SourceAttachment with include "page_images" here instead of including the page image via the reader state
            messageAttachments.push({
                library_id: readerState.library_id,
                zotero_key: readerState.zotero_key,
                type: "source",
                include: "fulltext"
            } as SourceAttachment);
        }

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
            assistantMsg.id,
            userMsg.content,
            messageAttachments,
            readerState,
            payload.isLibrarySearch,
            model,
            set,
            get
        );
        
        return;
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

        // Get current model
        const model = get(selectedModelAtom);
        
        // Get current thread ID
        const currentThreadId = get(currentThreadIdAtom);
        if (!currentThreadId) return null;
        
        // Find the index of the last user message
        const threadMessages = get(threadMessagesAtom);
        const messageIndex = threadMessages.findIndex(m => m.id === assistantMessageId);
        if (messageIndex < 0) return null; // Message not found
        const lastUserMessageIndex = findLastUserMessageIndexBefore(threadMessages, messageIndex);
        const userMessageId = threadMessages[lastUserMessageIndex].id;
        if (lastUserMessageIndex < 0) return null;
        
        // Truncate messages
        const truncatedMessages = threadMessages.slice(0, lastUserMessageIndex + 1);

        // create assistant message id
        const assistantMsg = createAssistantMessage({status: 'in_progress'});
        
        // Update messages atom
        set(threadMessagesAtom, [...truncatedMessages, assistantMsg]);
        set(currentAssistantMessageIdAtom, assistantMsg.id);

        // Update sources
        const threadSources = get(threadSourcesAtom);
        const messageIds = truncatedMessages.map(m => m.id);
        const newThreadSources = threadSources.filter(r => r.messageId && messageIds.includes(r.messageId));
        set(threadSourcesAtom, newThreadSources);
        
        // Execute chat completion
        set(isChatRequestPendingAtom, true);
        _processChatCompletionViaBackend(
            currentThreadId,
            userMessageId,         // existing user message ID
            assistantMsg.id,       // new assistant message ID
            "",                    // content remains unchanged
            [],                    // sources remain unchanged
            null,                  // readerState remains unchanged
            false,                 // isLibrarySearch remains unchanged
            model,
            set,
            get
        );
        
        return;
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
    readerState: ReaderState | null,
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
        reader_state: readerState,
        tool_request: isLibrarySearch ? search_tool_request : null,
        custom_instructions: getPref('customInstructions') || undefined,
        user_api_key: userApiKey,
        model: model
    } as ChatCompletionRequestBody;

    // request chat completion
    chatService.requestChatCompletion(
        payload,
        {
            onThread: (threadId: string) => {
                logger(`event 'onThread': ${threadId}`, 1);
                set(currentThreadIdAtom, threadId);
            },
            onDelta: (messageId: string, delta: string, type: DeltaType) => {
                // logger(`event 'onDelta': ${messageId} - ${delta} - ${type}`, 1);
                // SSE partial chunk → append to the assistant message
                if (type === "content") {
                    set(streamToMessageAtom, {
                        id: messageId,
                        chunk: delta
                    });
                }
                // if (type === "reasoning")
            },
            onMessage: (msg: MessageModel) => {
                logger(`event 'onMessage': ${JSON.stringify(msg)}`, 1);
                set(currentAssistantMessageIdAtom, msg.id);
                set(isChatRequestPendingAtom, false);
                if (!msg) return;
                const message = toMessageUI(msg);
                set(addOrUpdateMessageAtom, { message });
                // Add the tool call sources to the thread sources (if any)
                if (message.status === 'completed' && message.tool_calls) {
                    set(addToolCallSourcesToThreadSourcesAtom, {messages: [message]});
                }
            },
            onToolcall: (messageId: string, toolcallId: string, toolcall: ToolCall) => {
                logger(`event 'onToolcall': messageId: ${messageId}, toolcallId: ${toolcallId}, toolcall: ${toolcall}`, 1);
                set(addOrUpdateToolcallAtom, { messageId, toolcallId, toolcall });
            },
            onComplete: (messageId: string) => {
                logger(`event 'onComplete': ${messageId}`, 1);
                set(setMessageStatusAtom, { id: messageId, status: 'completed' });
            },
            onDone: (messageId: string | null) => {
                logger(`event 'onDone': ${messageId}`, 1);
                set(isChatRequestPendingAtom, false);
                // Mark the assistant as completed
                if (messageId) {
                    set(setMessageStatusAtom, { id: messageId, status: 'completed' });
                } else {
                    // Clear the holder and the cancellable state
                    cancellerHolder.current = null;
                    set(isCancellableAtom, false);
                }
            },
            onError: (messageId: string | null, errorType: string) => {
                logger(`event 'onError': ${messageId} - ${errorType}`, 1);
                set(isChatRequestPendingAtom, false);
                // If the message ID is not provided, use the current assistant message ID
                const currentMessageId = messageId || get(currentAssistantMessageIdAtom);
                if (!currentMessageId) return;
                const isCancelling = get(isCancellingAtom);
                if (isCancelling) {
                    // Cancel the message
                    set(cancelStreamingMessageAtom, { assistantMessageId: currentMessageId });
                } else {
                    // Mark the assistant message as error
                    set(setMessageStatusAtom, {
                        id: currentMessageId,
                        status: 'error',
                        errorType
                    });
                }
                // Clear the holder and the cancellable state
                cancellerHolder.current = null;
                set(isCancellableAtom, false);
            },
            onWarning: (messageId: string | null, type: string, data: any) => {
                logger(`event 'onWarning': ${messageId} - ${type} - ${JSON.stringify(data)}`, 1);
                // If the message ID is not provided, use the current assistant message ID
                const currentMessageId = messageId || get(currentAssistantMessageIdAtom);
                if (!currentMessageId) return;
                // Warning
                const warning = {id: uuidv4(), type: type} as Warning;
                if (data && data.attachments) {
                    warning.attachments = data.attachments as ZoteroItemReference[];
                }
                // Add the warning message for the assistant message
                set(setMessageStatusAtom, {
                    id: currentMessageId,
                    warnings: [warning]
                });
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