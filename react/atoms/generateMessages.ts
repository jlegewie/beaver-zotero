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
import { addProposedActionsAtom, threadProposedActionsAtom } from './proposedActions';
import { currentMessageItemsAtom, currentMessageContentAtom, readerTextSelectionAtom, currentMessageFiltersAtom, MessageFiltersState, currentReaderAttachmentKeyAtom } from './messageComposition';
import { currentReaderAttachmentAtom } from './messageComposition';
import { getCurrentPage } from '../utils/readerUtils';
import { chatService, ChatCompletionRequestBody, DeltaType, MessageSearchFilters } from '../../src/services/chatService';
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
import { CitationMetadata, isExternalCitation } from '../types/citations';
import { userIdAtom } from './auth';
import { toProposedAction, ProposedAction, isAnnotationAction, AnnotationProposedAction } from '../types/proposedActions/base';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { removePopupMessagesByTypeAtom } from './ui';
import { serializeCollection, serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import { toolAnnotationApplyBatcher } from '../utils/toolAnnotationApplyBatcher';
import { checkExternalReferencesAtom, addExternalReferencesToMappingAtom } from './externalReferences';
import { isSearchExternalReferencesTool, isCreateItemAction, CreateItemProposedAction } from '../types/proposedActions/items';
import { ExternalReference } from '../types/externalReferences';

export function getCurrentReaderState(): ReaderState | null {
    // Get current reader attachment
    const readerAttachment = store.get(currentReaderAttachmentAtom);
    if (!readerAttachment) return null;

    // Text selection
    const currentTextSelection = store.get(readerTextSelectionAtom);
    
    // Return ReaderState
    return {
        library_id: readerAttachment.libraryID,
        zotero_key: readerAttachment.key,
        current_page: getCurrentPage() || null,
        ...(currentTextSelection && { text_selection: currentTextSelection })
    } as ReaderState;
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
        items: Zotero.Item[];
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

        // Convert sources to MessageAttachments and process image annotations
        let messageAttachments: MessageAttachment[] =
            payload.items
                .map(item => toMessageAttachment(item))
                .filter(attachment => attachment !== null);
        messageAttachments = await processImageAnnotations(messageAttachments);

        // Get current reader state and add to message attachments if valid and not already in the thread
        const readerAttachment = get(currentReaderAttachmentAtom);
        let readerState: ReaderState | null = null;
        if (readerAttachment) {
            // Always get reader state with page and text selection when reader source is valid
            readerState = getCurrentReaderState();
            if (readerState) {
                const currentUserAttachmentKeys = get(userAttachmentsAtom).map(getUniqueKey);
                if (!currentUserAttachmentKeys.includes(`${readerAttachment.libraryID}-${readerAttachment.key}`)) {
                    logger(`generateResponseAtom: Adding reader state to message attachments (library_id: ${readerAttachment.libraryID}, zotero_key: ${readerAttachment.key})`);
                    
                    // Add as SourceAttachment (only if not already in thread)
                    // TODO: we could use SourceAttachment with include "page_images" here instead of including the page image via the reader state
                    messageAttachments.push({
                        library_id: readerAttachment.libraryID,
                        zotero_key: readerAttachment.key,
                        type: "source",
                        include: "fulltext"
                    } as SourceAttachment);
                }
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
        set(currentMessageContentAtom, '');
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(currentMessageItemsAtom, []);
        
        // Execute chat completion
        await _processChatCompletionViaBackend(
            get(currentThreadIdAtom),
            userMsg.id,         // the ID from createUserMessage
            assistantMsg.id,
            userMsg.content,
            messageAttachments,
            get(currentMessageFiltersAtom),
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
        const proposedActionsToDelete = get(threadProposedActionsAtom)
            .filter(isAnnotationAction)
            .filter(a => messageIdsToDelete.includes(a.message_id))
            .filter(a => a.status === 'applied' && a.result_data);
        if (proposedActionsToDelete.length > 0) {
            const actionsAreAnnotations = proposedActionsToDelete.every(isAnnotationAction);
            const title = actionsAreAnnotations
                ? 'Delete annotations?'
                : 'Undo changes?';
            const message = actionsAreAnnotations
                ? 'Do you want to delete the annotations created by the assistant messages that will be regenerated?'
                : 'Do you want to undo the changes created by the assistant messages that will be regenerated?';
            const buttonIndex = Zotero.Prompt.confirm({
                window: Zotero.getMainWindow(),
                title: title,
                text: message,
                button0: Zotero.Prompt.BUTTON_TITLE_YES,
                button1: Zotero.Prompt.BUTTON_TITLE_NO,
                defaultButton: 1,
            });
            if (buttonIndex === 0) {
                for (const proposedAction of proposedActionsToDelete) {
                    if (isAnnotationAction(proposedAction) && proposedAction.result_data?.zotero_key) {
                        const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                            proposedAction.result_data.library_id,
                            proposedAction.result_data.zotero_key
                        );
                        if (annotationItem) {
                            await annotationItem.eraseTx();
                        }
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
        set(citationMetadataAtom, (prev: CitationMetadata[]) => {
            return prev.filter(a => a.message_id && messageIds.includes(a.message_id));
        });
        set(updateCitationDataAtom);
        
        // Execute chat completion
        set(isChatRequestPendingAtom, true);
        await _processChatCompletionViaBackend(
            currentThreadId,
            userMessageId,         // existing user message ID
            assistantMsg.id,       // new assistant message ID
            "",                    // content remains unchanged
            [],                    // sources remain unchanged
            get(currentMessageFiltersAtom),
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
    filters: MessageFiltersState,
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

    // Set filters
    const filterLibraries = filters.libraryIds.length > 0
        ? filters.libraryIds
            .map(id => Zotero.Libraries.get(id))
            .filter((l): l is Zotero.Library => !!l)
            .map(serializeZoteroLibrary)
        : null;
    const filterCollections = filters.collectionIds.length > 0
        ? await Promise.all(filters.collectionIds.map(id => serializeCollection(Zotero.Collections.get(id))))
        : null;
    const filterTags = filters.tagSelections.length > 0
        ? filters.tagSelections.map(tag => ({ ...tag }))
        : null;
    const filtersPayload = {
        libraries: filterLibraries,
        collections: filterCollections,
        tags: filterTags
    } as MessageSearchFilters;

    // User message
    const userMessage = {
        id: userMessageId,
        role: "user",
        content: content,
        attachments: attachments,
        reader_state: readerState,
        filters: filtersPayload,
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

                // Check for external references and populate cache
                if (isSearchExternalReferencesTool(toolcall.function?.name)) {
                    logger(`onToolcall: Checking external references for caching`, 1);
                    if (toolcall.result?.references) {
                        // Add to external reference mapping for UI display
                        set(addExternalReferencesToMappingAtom, toolcall.result?.references as ExternalReference[]);
                        // Check if references exist in Zotero
                        set(checkExternalReferencesAtom, toolcall.result?.references);
                    }
                }

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
            onProposedAction: (
                messageId: string,
                toolcallId: string | null,
                rawAction: Record<string, any> | Record<string, any>[]
            ) => {
                const asArray = Array.isArray(rawAction) ? rawAction : [rawAction];
                logger(`event 'onProposedAction': messageId: ${messageId}, toolcallId: ${toolcallId}, actionsCount: ${asArray.length}`, 1);
                async function processActions(rawActions: Record<string, any>[]) {
                    try {
                        // Convert raw actions to ProposedAction
                        const actions = rawActions
                            .map((raw) => {
                                try {
                                    return toProposedAction(raw);
                                } catch (error) {
                                    logger(`event 'onProposedAction': Failed to convert action ${raw.id}: ${error}`, 1);
                                    return null;
                                }
                            })
                            .filter((action): action is ProposedAction => action !== null);

                        // If no actions, return
                        if (actions.length === 0) {
                            return;
                        }

                        // Add proposed actions to the thread proposed actions
                        set(addProposedActionsAtom, actions);

                        const createItemActions = actions.filter(isCreateItemAction) as CreateItemProposedAction[];
                        if (createItemActions.length > 0) {
                            logger(`onProposedAction: Checking external references for caching`, 1);
                            const references = createItemActions.map((action) => action.proposed_data?.item).filter(Boolean) as ExternalReference[];
                            // Add to external reference mapping for UI display
                            set(addExternalReferencesToMappingAtom, references);
                            // Check if references exist in Zotero
                            set(checkExternalReferencesAtom, references);
                        }

                        // Separate annotation actions from other actions
                        const annotationActions = actions.filter(isAnnotationAction) as AnnotationProposedAction[];

                        // If no annotation actions, return
                        if (annotationActions.length === 0) {
                            return;
                        }

                        // Load attachment item data for annotation actions
                        const attachmentRefs = new Set<ZoteroItemReference>();
                        annotationActions.forEach((action) => {
                            attachmentRefs.add({
                                library_id: action.proposed_data.library_id,
                                zotero_key: action.proposed_data.attachment_key,
                            });
                        });
                        const attachmentPromises = Array.from(attachmentRefs).map((ref) =>
                            Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key)
                        );
                        const attachments = (await Promise.all(attachmentPromises)).filter(
                            Boolean
                        ) as Zotero.Item[];
                        if (attachments.length > 0) {
                            await loadFullItemDataWithAllTypes(attachments);
                        }

                        // Check if auto-apply is enabled
                        if (!getPref('autoApplyAnnotations')) {
                            return;
                        }

                        // Check if there's a current reader with matching attachment
                        const currentReaderKey = get(currentReaderAttachmentKeyAtom);
                        if (currentReaderKey === null) {
                            return;
                        }

                        // Only auto-apply annotations for the current reader
                        const actionsForCurrentReader = annotationActions.filter(
                            (action) => action.proposed_data.attachment_key === currentReaderKey
                        );

                        if (actionsForCurrentReader.length === 0) {
                            return;
                        }

                        // Enqueue for batch application
                        if (toolcallId) {
                            toolAnnotationApplyBatcher.enqueue({
                                messageId,
                                toolcallId,
                                actions: actionsForCurrentReader,
                            });
                        }
                    } catch (error) {
                        logger(
                            `event 'onProposedAction': failed to parse action for message ${messageId} toolcall ${toolcallId}: ${error}`,
                            1
                        );
                    }
                }
                processActions(asArray);
            },
            onCitationMetadata: async (messageId: string, citationMetadata: CitationMetadata) => {
                logger(`event 'onCitationMetadata': messageId: ${messageId}, citationMetadata: ${JSON.stringify(citationMetadata)}`, 1);
                
                // Only load item data for Zotero citations (not external citations)
                if (!isExternalCitation(citationMetadata)) {
                    if (citationMetadata.library_id && citationMetadata.zotero_key) {
                        const item = await Zotero.Items.getByLibraryAndKeyAsync(
                            citationMetadata.library_id, 
                            citationMetadata.zotero_key
                        );
                        if (item) {
                            await loadFullItemDataWithAllTypes([item]);
                        }
                    }
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
