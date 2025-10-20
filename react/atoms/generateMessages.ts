import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { ChatMessage, createAssistantMessage, createUserMessage, WarningMessage } from '../types/chat/uiTypes';
import { MessageModel, toMessageData, ToolCall, toMessageModel } from '../types/chat/apiTypes';
import { ZoteroItemReference } from '../types/zotero';
import { isAnnotationAttachment, MessageAttachment, ReaderState, SourceAttachment } from '../types/attachments/apiTypes';
import {
    threadMessagesAtom,
    setMessageStatusAtom,
    streamToMessageAtom,
    currentThreadIdAtom,
    addOrUpdateMessageAtom,
    addOrUpdateToolcallAtom,
    addToolCallResponsesToToolAttachmentsAtom,
    cancellerHolder,
    isCancellableAtom,
    isCancellingAtom,
    cancelStreamingMessageAtom,
    isChatRequestPendingAtom,
    currentAssistantMessageIdAtom,
    userAttachmentsAtom,
    toolAttachmentsAtom,
    streamReasoningToMessageAtom
} from './threads';
import { upsertToolcallAnnotationAtom, allAnnotationsAtom } from './toolAnnotations';
import { InputSource } from '../types/sources';
import { createSourceFromAttachmentOrNoteOrAnnotation, getChildItems, isSourceValid } from '../utils/sourceUtils';
import { resetCurrentSourcesAtom, currentMessageContentAtom, currentReaderAttachmentAtom, currentSourcesAtom, readerTextSelectionAtom, currentLibraryIdsAtom, currentReaderAttachmentKeyAtom } from './input';
import { getCurrentPage } from '../utils/readerUtils';
import { chatService, ChatCompletionRequestBody, DeltaType } from '../../src/services/chatService';
import { MessageData } from '../types/chat/apiTypes';
import { FullModelConfig, selectedModelAtom } from './models';
import { getPref } from '../../src/utils/prefs';
import { getResultAttachmentsFromToolcall, toMessageUI } from '../types/chat/converters';
import { store } from '../store';
import { toMessageAttachment } from '../types/attachments/converters';
import { logger } from '../../src/utils/logger';
import { uint8ArrayToBase64 } from '../utils/fileUtils';
import { citationMetadataAtom, updateCitationDataAtom } from './citations';
import { getUniqueKey, MessageAttachmentWithId } from '../types/attachments/uiTypes';
import { CitationMetadata } from '../types/citations';
import { userIdAtom } from './auth';
import { sourceValidationManager, SourceValidationType } from '../../src/services/sourceValidationManager';
import { toToolAnnotation, ToolAnnotation } from '../types/chat/toolAnnotations';
import { toolAnnotationApplyBatcher } from '../utils/toolAnnotationApplyBatcher';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';

/**
 * Flattens sources from regular items, attachments, notes, and annotations.
 * 
 * @param inputSources - Array of InputSource objects to be flattened
 * @returns Array of InputSource objects
 */
function flattenSources(
    inputSources: InputSource[]
): InputSource[] {
    // Flatten regular item attachments
    const sourcesFromRegularItems = inputSources
        .filter((s) => s.type === "regularItem")
        .flatMap((s) => getChildItems(s).map((item) => {
            const source = createSourceFromAttachmentOrNoteOrAnnotation(item);
            return {...source, timestamp: s.timestamp};
        })) as InputSource[];
    
    // Source, note, and annotation attachments
    const otherSources = (inputSources
        .filter((s) => s.type === "attachment" || s.type === "note"  || s.type === "annotation")) as InputSource[];
    
    // Return flattened sources
    return [...sourcesFromRegularItems, ...otherSources];
}

/**
 * Validates sources using the validation manager and removes invalid ones.
 * Uses cached validation results when available to avoid redundant backend calls.
 * 
 * @param sources - Array of InputSource objects to be validated
 * @returns An object containing arrays of valid and invalid sources
 */
async function validateSources(
    sources: InputSource[]
): Promise<{ validSources: InputSource[], invalidSources: { source: InputSource, reason: string }[] }> {
    logger(`validateSources: Validating ${sources.length} sources before sending message`, 3);
    
    const validations = await Promise.all(sources.map(async (source) => {
        try {
            // Use cached validation to check if source is usable
            const result = await sourceValidationManager.validateSource(source, {
                validationType: SourceValidationType.CACHED,
                forceRefresh: false
            });

            // If still validating, we'll consider it valid to avoid delays
            const isValid = result.isValid || result.isValidating;
            
            if (!isValid && result.reason) {
                logger(`validateSources: Source ${source.itemKey} is invalid: ${result.reason}`, 2);
            }
            
            return { source, isValid, reason: result.reason };
        } catch (error: any) {
            logger(`validateSources: Error validating source ${source.itemKey}: ${error.message}`, 1);
            // Fall back to local validation if manager fails
            const fallbackResult = await isSourceValid(source);
            return { source, isValid: fallbackResult.valid, reason: fallbackResult.error };
        }
    }));

    const validSources = validations
        .filter(v => v.isValid)
        .map(v => v.source);
    
    const invalidSources = validations
        .filter(v => !v.isValid)
        .map(v => ({ source: v.source, reason: v.reason || 'Unknown reason' }));

    const invalidCount = invalidSources.length;
    if (invalidCount > 0) {
        logger(`validateSources: Filtered out ${invalidCount} invalid sources`, 2);
    }

    return { 
        validSources: validSources.sort((a, b) => a.timestamp - b.timestamp),
        invalidSources
    };
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
    }) => {
        set(isChatRequestPendingAtom, true);

        // Get current model
        const model = get(selectedModelAtom);
        if (!model) {
            // Create user and assistant messages so we can display a proper error in-thread
            const userMsg = createUserMessage(payload.content);
            const assistantMsg = createAssistantMessage({ status: 'in_progress' });

            const threadMessages = get(threadMessagesAtom);
            set(threadMessagesAtom, [...threadMessages, userMsg, assistantMsg]);
            set(currentAssistantMessageIdAtom, assistantMsg.id);

            // Stop spinner and surface an actionable error
            set(isChatRequestPendingAtom, false);
            set(setMessageStatusAtom, {
                id: assistantMsg.id,
                status: 'error',
                error: {
                    id: uuidv4(),
                    type: 'invalid_model'
                }
            });
            return;
        }

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
        
        // Get current reader source and include it in validation
        const readerSource = get(currentReaderAttachmentAtom);
        const sourcesToValidate = readerSource ? [...flattenedSources, readerSource] : flattenedSources;
        
        const { validSources: validatedSources, invalidSources } = await validateSources(sourcesToValidate);

        // Separate reader source from other validated sources
        const validReaderSource = validatedSources.find(s => s.type === "reader");
        const validNonReaderSources = validatedSources.filter(s => s.type !== "reader");

        // If some sources were removed, add a warning
        if (invalidSources.length > 0) {
            logger(`generateResponseAtom: Filtered out ${invalidSources.length} invalid sources`, 2);
            
            let message: string;
            if (invalidSources.length === 1) {
                message = `1 source was removed: ${invalidSources[0].reason}`;
            } else {
                const reasons = new Set(invalidSources.map(s => s.reason));
                if (reasons.size === 1) {
                    const reason = invalidSources[0].reason;
                    message = `${invalidSources.length} sources were removed: ${reason}`;
                } else {
                    message = `${invalidSources.length} sources were removed because they are invalid.`;
                }
            }
            
            const warning = {
                id: uuidv4(), 
                type: "missing_attachments", 
                message
            } as WarningMessage;
            
            // warning.attachments = invalidSources.map(s => ({
            //     library_id: s.source.libraryID, 
            //     zotero_key: s.source.itemKey
            // }) as ZoteroItemReference);
            
            // Add the warning message for the assistant message
            set(setMessageStatusAtom, {
                id: assistantMsg.id,
                warnings: [warning]
            });
        }

        // Convert sources to MessageAttachments and process image annotations
        const messageAttachments = await Promise.all(
            validNonReaderSources
                .map(async (s) => await toMessageAttachment(s)))
                .then(attachments => processImageAnnotations([...attachments.flat()])
        );

        // Get current reader state and add to message attachments if valid and not already in the thread
        let readerState: ReaderState | null = null;
        if (validReaderSource) {
            const currentUserAttachmentKeys = get(userAttachmentsAtom).map(getUniqueKey);
            if (!currentUserAttachmentKeys.includes(`${validReaderSource.libraryID}-${validReaderSource.itemKey}`)) {
                logger(`generateResponseAtom: Adding reader state to message attachments (library_id: ${validReaderSource.libraryID}, zotero_key: ${validReaderSource.itemKey})`);
                
                // Get reader state with page and text selection
                readerState = getCurrentReaderState();
                
                // Add as SourceAttachment
                // TODO: we could use SourceAttachment with include "page_images" here instead of including the page image via the reader state
                messageAttachments.push({
                    library_id: validReaderSource.libraryID,
                    zotero_key: validReaderSource.itemKey,
                    type: "source",
                    include: "fulltext"
                } as SourceAttachment);
            }
        }

        // Update user attachments
        set(userAttachmentsAtom, (prev) => {
            const newAttachments = messageAttachments.map(a => ({
                ...a,
                messageId: userMsg.id,
                image_base64: undefined
            }) as MessageAttachmentWithId);
            return [...prev, ...newAttachments];
        });
        
        // Reset user message and source after adding to message
        set(resetCurrentSourcesAtom);
        set(currentMessageContentAtom, '');
        
        // Execute chat completion
        await _processChatCompletionViaBackend(
            get(currentThreadIdAtom),
            userMsg.id,         // the ID from createUserMessage
            assistantMsg.id,
            userMsg.content,
            messageAttachments,
            get(currentLibraryIdsAtom),
            readerState,
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
        if (!model) {
            logger('regenerateFromMessageAtom: No model selected');
            set(isChatRequestPendingAtom, false);
            return;
        }
        
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

        // Delete annotations if user confirms
        const messageIdsToDelete = threadMessages.slice(lastUserMessageIndex + 1).map(m => m.id);
        const annotationsToDelete = get(allAnnotationsAtom)
            .filter(a => messageIdsToDelete.includes(a.message_id))
            .filter(a => a.status === 'applied' && a.zotero_key);
        if (annotationsToDelete.length > 0) {
            const buttonIndex = Zotero.Prompt.confirm({
                window: Zotero.getMainWindow(),
                title: 'Delete annotations?',
                text: 'Do you want to delete the annotations created by the assistant messages that will be regenerated?',
                button0: Zotero.Prompt.BUTTON_TITLE_YES,
                button1: Zotero.Prompt.BUTTON_TITLE_NO,
                defaultButton: 1,
            });
            if (buttonIndex === 0) {
                for (const annotation of annotationsToDelete) {
                    const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                        annotation.library_id,
                        annotation.zotero_key as string
                    );
                    if (annotationItem) {
                        await annotationItem.eraseTx();
                    }
                }
            }
        }
        
        // Truncate messages
        const truncatedMessages = threadMessages.slice(0, lastUserMessageIndex + 1);

        // create assistant message id
        const assistantMsg = createAssistantMessage({status: 'in_progress'});
        
        // Update messages atom
        set(threadMessagesAtom, [...truncatedMessages, assistantMsg]);
        set(currentAssistantMessageIdAtom, assistantMsg.id);

        // Update message attachments
        const messageIds = truncatedMessages.map(m => m.id);
        set(userAttachmentsAtom, (prev) =>
            prev.filter(a => a.messageId && messageIds.includes(a.messageId))
        );
        set(toolAttachmentsAtom, (prev) =>
            prev.filter(a => a.messageId && messageIds.includes(a.messageId))
        );

        // Update citation metadata
        // set(citationMetadataAtom, (prev: CitationMetadata[]) => {
        //     return prev.filter(a => a.messageId && messageIds.includes(a.messageId));
        // });
        
        // Execute chat completion
        set(isChatRequestPendingAtom, true);
        await _processChatCompletionViaBackend(
            currentThreadId,
            userMessageId,         // existing user message ID
            assistantMsg.id,       // new assistant message ID
            "",                    // content remains unchanged
            [],                    // sources remain unchanged
            get(currentLibraryIdsAtom),
            null,                  // readerState remains unchanged
            model,
            set,
            get
        );
        
        return;
    }
);

function getUserApiKey(model: FullModelConfig): string | undefined {
    // Only relevant for models that require a user API key
    if (model.use_app_key || model.is_custom) return undefined;

    if (model.provider === 'google') {
        return getPref('googleGenerativeAiApiKey') || undefined;
    } else if (model.provider === 'openai') {
        return getPref('openAiApiKey') || undefined;
    } else if (model.provider === 'anthropic') {
        return getPref('anthropicApiKey') || undefined;
    }
    return undefined;
}

async function _handleThreadMessages(userMessage: MessageData, threadId: string | null, set: any, get: any): Promise<{threadId: string, messages: MessageData[]}> {
    let messages: MessageData[] = [];

    const user_id = store.get(userIdAtom);
    if (!user_id) {
        throw new Error('User ID not found');
    }

    // Initialize thread
    if (!threadId) {
        const thread = await Zotero.Beaver.db.createThread(user_id);
        threadId = thread.id;
        set(currentThreadIdAtom, thread.id);
    }
    // Existing thread
    else {
        const messagesDB = await Zotero.Beaver.db.getMessagesFromThread(user_id,threadId);
        messages = messagesDB.map(m => toMessageData(m));
    }
    
    // Handle user message
    const existingMessage = messages.find(m => m.id === userMessage.id);

    // Case 1: Normal flow (new user message)
    if (!existingMessage) {
        messages = [...messages, userMessage];
        // Add user message to local DB
        await Zotero.Beaver.db.upsertMessage(user_id, toMessageModel(userMessage, threadId));
    }

    // Case 2: Retry flow (existing user message)
    else if (existingMessage) {
        const resetMessages = await Zotero.Beaver.db.resetFromMessage(user_id, threadId, existingMessage.id, messages.map(m => toMessageModel(m, threadId)), true);
        messages = resetMessages.map(m => toMessageData(m));
    }

    // Return current thread ID and messages
    return {threadId, messages};
}

async function _processChatCompletionViaBackend(
    currentThreadId: string | null,
    userMessageId: string,
    assistantMessageId: string,
    content: string,
    attachments: MessageAttachment[],
    libraryIds: number[] | null,
    readerState: ReaderState | null,
    model: FullModelConfig,
    set: any,
    get: any
) {
    // Set user API key (only for user-key models)
    const userApiKey = getUserApiKey(model);

    // If a user-key model is selected but no key is configured, surface UI error
    if (!model.use_app_key && !model.is_custom && !userApiKey) {
        set(isChatRequestPendingAtom, false);
        set(setMessageStatusAtom, {
            id: assistantMessageId,
            status: 'error',
            error: {
                id: uuidv4(),
                type: 'user_key_not_set'
            }
        });
        return;
    }

    // User message
    const userMessage = {
        id: userMessageId,
        role: "user",
        content: content,
        attachments: attachments,
        reader_state: readerState,
        tool_request: null,
        status: "completed"
    } as MessageData;

    // Stateful vs stateless chat
    let threadId: string | null = currentThreadId;
    let messages: MessageData[] = [];
    const statefulChat = getPref('statefulChat');
    if (!statefulChat) {
        const { threadId: newThreadId, messages: threadMessages } = await _handleThreadMessages(userMessage, currentThreadId, set, get);
        threadId = newThreadId;
        messages = threadMessages;
    } else {
        messages = [userMessage];
    }

    // Set payload
    const payload: ChatCompletionRequestBody = {
        mode: statefulChat ? "stateful" : "stateless",
        messages: messages,
        thread_id: threadId ?? undefined,
        library_ids: libraryIds,
        assistant_message_id: assistantMessageId,
        custom_instructions: getPref('customInstructions') || undefined,
        user_api_key: model.is_custom ? undefined : userApiKey,
        model_id: model.is_custom ? undefined : model.id,
        access_id: model.is_custom ? undefined : model.access_id,
        custom_model: model.is_custom ? model.custom_model : undefined,
        frontend_version: Zotero.Beaver.pluginVersion || ''
    };

    const payloadForLog = {
        ...payload,
        user_api_key: payload.user_api_key ? '***' : undefined,
        custom_model: payload.custom_model
            ? { ...payload.custom_model, api_key: '***' }
            : undefined
    };

    logger(`generateMessages: payload: ${JSON.stringify(payloadForLog)}`, 1);

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
                    set(setMessageStatusAtom, { id: messageId, status: 'in_progress' });
                    set(streamToMessageAtom, {
                        id: messageId,
                        chunk: delta
                    });
                }
                if (type === "reasoning") {
                    if (delta) {
                        set(setMessageStatusAtom, { id: messageId, status: 'thinking' });
                        set(streamReasoningToMessageAtom, {
                            id: messageId,
                            chunk: delta
                        });
                    }
                }
            },
            onMessage: async (msg: MessageModel) => {
                logger(`event 'onMessage': ${JSON.stringify(msg)}`, 1);
                set(currentAssistantMessageIdAtom, msg.id);
                set(isChatRequestPendingAtom, false);
                if (!msg) return;

                // Convert to MessageUI
                const message = toMessageUI(msg);

                // Load item data
                if (message.tool_calls) {
                    const messageAttachments = message.tool_calls.flatMap(getResultAttachmentsFromToolcall) || [];
                    const attachmentPromises = messageAttachments.map(att => Zotero.Items.getByLibraryAndKeyAsync(att.library_id, att.zotero_key));
                    const attachments = (await Promise.all(attachmentPromises)).filter(Boolean) as Zotero.Item[];
                    if (attachments.length > 0) {
                        await loadFullItemDataWithAllTypes(attachments);
                    }
                }

                // Add message to the thread messages
                set(addOrUpdateMessageAtom, { message });

                // Add the tool call sources to the thread sources (if any)
                if (message.status === 'completed' && message.tool_calls) {
                    set(addToolCallResponsesToToolAttachmentsAtom, {messages: [message]});
                }

                // Store message locally
                if (!getPref('statefulChat')) {
                    const user_id = store.get(userIdAtom);
                    if (!user_id) {
                        throw new Error('User ID not found');
                    }
                    Zotero.Beaver.db.upsertMessage(user_id, msg);
                }
            },
            onToolcall: async (messageId: string, toolcallId: string, toolcall: ToolCall) => {
                logger(`event 'onToolcall': messageId: ${messageId}, toolcallId: ${toolcallId}, toolcall: ${JSON.stringify(toolcall)}`, 1);

                // Load item data
                const toolcallAttachments = getResultAttachmentsFromToolcall(toolcall) || [];
                const attachmentPromises = toolcallAttachments.map(att => Zotero.Items.getByLibraryAndKeyAsync(att.library_id, att.zotero_key));
                const attachments = (await Promise.all(attachmentPromises)).filter(Boolean) as Zotero.Item[];
                if (attachments.length > 0) {
                    await loadFullItemDataWithAllTypes(attachments);
                }

                // Update state
                set(addOrUpdateToolcallAtom, { messageId, toolcallId, toolcall });
            },
            onAnnotation: (
                messageId: string,
                toolcallId: string,
                rawAnnotations: Record<string, any>[]
            ) => {
                logger(`event 'onAnnotation': messageId: ${messageId}, toolcallId: ${toolcallId}, annotationsCount: ${rawAnnotations.length}, annotationIds: ${rawAnnotations.map(a => a.id || 'unknown').join(', ')}`, 1);
                async function applyAnnotationsAndUpsert(rawAnnotations: Record<string, any>[]) {
                    try {
                        // Convert raw annotation to ToolAnnotation
                        const annotations = rawAnnotations.map((a: Record<string, any>) => {
                            try {
                                return toToolAnnotation(a);
                            } catch (error) {
                                logger(`event 'onAnnotation': Failed to convert annotation ${a.id}: ${error}`, 1);
                                return null;
                            }
                        }).filter((a): a is ToolAnnotation => a !== null);

                        if (annotations.length === 0) {
                            return;
                        }

                        // Validate that all annotations belong to the same toolcall
                        const uniqueToolcallIds = new Set(rawAnnotations.map(a => a.toolcall_id || a.toolcallId));
                        if (uniqueToolcallIds.size > 1) {
                            logger(`event 'onAnnotation': Warning - annotations from multiple toolcalls in single batch: ${Array.from(uniqueToolcallIds).join(', ')}`, 1);
                        }

                        // Load item data
                        const attachmentRefs= new Set<ZoteroItemReference>();
                        annotations.forEach(a => attachmentRefs.add({library_id: a.library_id, zotero_key: a.attachment_key}));
                        const attachmentPromises = Array.from(attachmentRefs).map(ref => Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key));
                        const attachments = (await Promise.all(attachmentPromises)).filter(Boolean) as Zotero.Item[];
                        if (attachments.length > 0) {
                            await loadFullItemDataWithAllTypes(attachments);
                        }

                        // Early return if autoApplyAnnotations is disabled
                        if (!getPref('autoApplyAnnotations')) {
                            set(upsertToolcallAnnotationAtom, { toolcallId, annotations });
                            return;
                        }

                        // Early return if no reader is open
                        const currentReaderKey = get(currentReaderAttachmentKeyAtom);
                        if (currentReaderKey === null) {
                            set(upsertToolcallAnnotationAtom, { toolcallId, annotations });
                            return;
                        }

                        toolAnnotationApplyBatcher.enqueue({
                            messageId,
                            toolcallId,
                            annotations,
                        });
                    } catch (error) {
                        logger(`event 'onAnnotation': failed to parse annotation for message ${messageId} toolcall ${toolcallId}: ${error}`, 1);
                    }
                }
                applyAnnotationsAndUpsert(rawAnnotations);
            },
            onCitationMetadata: async (messageId: string, citationMetadata: CitationMetadata) => {
                logger(`event 'onCitationMetadata': messageId: ${messageId}, citationMetadata: ${JSON.stringify(citationMetadata)}`, 1);
                // Load item data
                const item = await Zotero.Items.getByLibraryAndKeyAsync(citationMetadata.library_id, citationMetadata.zotero_key);
                if (item) {
                    await loadFullItemDataWithAllTypes([item]);
                }

                // Update state
                set(citationMetadataAtom, (prev: CitationMetadata[]) => {
                    const newCitation = { ...citationMetadata, message_id: messageId };
                    return [...prev, newCitation];
                });
                set(updateCitationDataAtom);
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
            onError: (messageId: string | null, errorType: string, errorMessage?: string) => {
                logger(`event 'onError': ${messageId} - ${errorType} - ${errorMessage}`, 1);
                set(isChatRequestPendingAtom, false);
                // If the message ID is not provided, use the current assistant message ID
                const currentMessageId = messageId || get(currentAssistantMessageIdAtom);
                if (!currentMessageId) return;
                const isCancelling = get(isCancellingAtom);
                if (isCancelling) {
                    // Cancel the message
                    set(cancelStreamingMessageAtom, { assistantMessageId: currentMessageId });
                    set(isCancellingAtom, false);
                } else {
                    // Mark the assistant message as error
                    set(setMessageStatusAtom, {
                        id: currentMessageId,
                        status: 'error',
                        error: {
                            id: uuidv4(),
                            type: errorType,
                            message: errorMessage
                        }
                    });
                }
                // Clear the holder and the cancellable state
                cancellerHolder.current = null;
                set(isCancellableAtom, false);
            },
            onWarning: async (messageId: string | null, type: string, message: string, data: any) => {
                logger(`event 'onWarning': ${messageId} - ${type} - ${message} - ${JSON.stringify(data)}`, 1);
                // If the message ID is not provided, use the current assistant message ID
                const currentMessageId = messageId || get(currentAssistantMessageIdAtom);
                if (!currentMessageId) return;
                // Warning
                const warning = {id: uuidv4(), type: type, message: message} as WarningMessage;
                if (data && data.attachments) {
                    warning.attachments = data.attachments as ZoteroItemReference[];
                    const attachmentPromises = warning.attachments.map(att => Zotero.Items.getByLibraryAndKeyAsync(att.library_id, att.zotero_key));
                    const attachments = (await Promise.all(attachmentPromises)).filter(Boolean) as Zotero.Item[];
                    if (attachments.length > 0) {
                        await loadFullItemDataWithAllTypes(attachments);
                    }
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
            // console.log('Received canceller, storing in holder:', canceller);
            cancellerHolder.current = canceller;
            // Update the boolean atom asynchronously to avoid sync interference
            setTimeout(() => {
                set(isCancellableAtom, true);
            }, 0);
        }
    );
}
