import { atom } from "jotai";
import { ChatMessage, ErrorMessage, ThreadData, WarningMessage } from "../types/chat/uiTypes";
import { currentMessageItemsAtom, currentMessageContentAtom, updateMessageItemsFromZoteroSelectionAtom, updateReaderAttachmentAtom } from "./messageComposition";
import { isLibraryTabAtom, isPreferencePageVisibleAtom, removePopupMessagesByTypeAtom, userScrolledAtom } from "./ui";
import { getResultAttachmentsFromToolcall } from "../types/chat/converters";
import { chatService } from "../../src/services/chatService";
import { ToolCall } from "../types/chat/apiTypes";
import { citationMetadataAtom, citationDataMapAtom, updateCitationDataAtom } from "./citations";
import { isExternalCitation } from "../types/citations";
import { threadProposedActionsAtom, undoProposedActionAtom } from "./proposedActions";
import { MessageAttachmentWithId } from "../types/attachments/uiTypes";
import { threadService } from "../../src/services/threadService";
import { getPref } from "../../src/utils/prefs";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { validateAppliedAction } from "../utils/proposedActions";
import { logger } from "../../src/utils/logger";
import { resetMessageUIStateAtom, clearMessageUIStateAtom } from "./messageUIState";
import { checkExternalReferencesAtom, clearExternalReferenceCacheAtom, addExternalReferencesToMappingAtom } from "./externalReferences";
import { ExternalReference } from "../types/externalReferences";
import { CreateItemProposedAction, isCreateItemAction, isSearchExternalReferencesTool } from "../types/proposedActions/items";

function normalizeToolCallWithExisting(toolcall: ToolCall, existing?: ToolCall): ToolCall {
    const mergedResponse = toolcall.response
        ? {
              ...existing?.response,
              ...toolcall.response,
              metadata: toolcall.response.metadata ?? existing?.response?.metadata,
          }
        : existing?.response;

    const normalized: ToolCall = {
        ...existing,
        ...toolcall,
        response: mergedResponse,
    };

    return normalized;
}

function normalizeToolCalls(
    incoming: ToolCall[] | undefined | null,
    existing?: ToolCall[]
): ToolCall[] | undefined {
    if (!incoming) return existing;
    return incoming.map((toolcall) => {
        const current = existing?.find((tc) => tc.id === toolcall.id);
        return normalizeToolCallWithExisting(toolcall, current);
    });
}

// Thread messages and attachments
export const currentThreadIdAtom = atom<string | null>(null);
export const currentAssistantMessageIdAtom = atom<string | null>(null);
export const threadMessagesAtom = atom<ChatMessage[]>([]);

export const threadScrollPositionsAtom = atom<Record<string, number>>({});
export const currentThreadScrollPositionAtom = atom(
    (get) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            return undefined;
        }
        const positions = get(threadScrollPositionsAtom);
        return positions[threadId];
    },
    (get, set, scrollTop: number | null) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            return;
        }
        set(threadScrollPositionsAtom, (prevPositions) => {
            const nextPositions = { ...prevPositions };
            if (scrollTop === null) {
                delete nextPositions[threadId];
            } else {
                nextPositions[threadId] = scrollTop;
            }
            return nextPositions;
        });
    }
);

/*
 * User added sources are sources added by the user to the 
 * thread. Either from existing messages with role "user"
 * Or when the user submits a completion request.
 */
export const userAttachmentsAtom = atom<MessageAttachmentWithId[]>([]);
export const toolAttachmentsAtom = atom<MessageAttachmentWithId[]>([]);
export const userAttachmentKeysAtom = atom((get) => {
    return get(userAttachmentsAtom).map((a) => a.zotero_key);
});


export const threadAttachmentCountAtom = atom<number>((get) => {
    const userAttachmentKeys = get(userAttachmentKeysAtom);
    return [...new Set(userAttachmentKeys)].length;
});

export const threadAttachmentCountWithoutAnnotationsAtom = atom<number>((get) => {    
    const keys = get(userAttachmentsAtom).filter((a) => a.type != "annotation").map((a) => a.zotero_key);
    return [...new Set(keys)].length;
});




// True after a chat request is sent and before the first assistant response arrives.
// Used to show a spinner during initial LLM response loading.
export const isChatRequestPendingAtom = atom<boolean>(false);

// Indicates if the thread is currently streaming a response
export const isStreamingAtom = atom((get) => {
    // If a chat request is pending, set streaming to true
    const isChatRequestPending = get(isChatRequestPendingAtom);
    if (isChatRequestPending) return true;
    // Otherwise, use status of last message
    const messages = get(threadMessagesAtom);
    if(messages.length === 0) return false;
    const lastMessage = messages[messages.length - 1];
    return ['searching', 'thinking', 'in_progress'].includes(lastMessage.status);
});

// Atom for the current canceller
export const cancellerHolder = {
    current: null as (() => void) | null
};
export const isCancellableAtom = atom<boolean>(false);
export const isCancellingAtom = atom<boolean>(false);

// Atom to store recent threads
export const recentThreadsAtom = atom<ThreadData[]>([]);

export const cancelStreamingMessageAtom = atom(
    null,
    async (get, set, { assistantMessageId }: { assistantMessageId: string }) => {
        const currentThreadId = get(currentThreadIdAtom);
        if (!currentThreadId) return;
        const messages = get(threadMessagesAtom);
        const streamingMessage = messages.find((message) => message.id === assistantMessageId);
        if (streamingMessage) {
            await chatService.cancelChatCompletion(
                streamingMessage.id,
                currentThreadId,
                streamingMessage.content || ''
            );
            const toolcalls = streamingMessage.tool_calls?.map((toolcall) => {
                return {
                    ...toolcall,
                    status: 'error'
                }
            }) as ToolCall[];
            set(updateMessageAtom, { id: streamingMessage.id, updates: {status: 'canceled', ...(toolcalls && { tool_calls: toolcalls }) } });
        }
    }
);

// Setter atoms
export const newThreadAtom = atom(
    null,
    async (get, set) => {
        const isLibraryTab = get(isLibraryTabAtom);
        set(currentThreadIdAtom, null);
        set(threadMessagesAtom, []);
        set(userAttachmentsAtom, []);
        set(toolAttachmentsAtom, []);
        set(currentMessageItemsAtom, []);
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(citationMetadataAtom, []);
        set(threadProposedActionsAtom, []);
        set(citationDataMapAtom, {});
        set(currentMessageContentAtom, '');
        set(resetMessageUIStateAtom);
        set(isPreferencePageVisibleAtom, false);
        set(clearExternalReferenceCacheAtom);
        // Update message items from Zotero selection or reader
        const addSelectedItemsOnNewThread = getPref('addSelectedItemsOnNewThread');
        if (isLibraryTab && addSelectedItemsOnNewThread) {
            const maxAddAttachmentToMessage = getPref('maxAddAttachmentToMessage');
            set(updateMessageItemsFromZoteroSelectionAtom, maxAddAttachmentToMessage);
        }
        if (!isLibraryTab) {
            await set(updateReaderAttachmentAtom);
        }
        set(userScrolledAtom, false);
    }
);

export const isLoadingThreadAtom = atom<boolean>(false);

export const loadThreadAtom = atom(
    null,
    async (get, set, { user_id, threadId }: { user_id: string; threadId: string }) => {
        set(isLoadingThreadAtom, true);
        try {
            set(userScrolledAtom, false);
            // Set the current thread ID
            set(currentThreadIdAtom, threadId);
            set(isPreferencePageVisibleAtom, false);
            set(clearExternalReferenceCacheAtom);
            
            // Use remote API
            const { messages, userAttachments, toolAttachments, citationMetadata, proposedActions } = await threadService.getThreadMessages(threadId);
            
            if (messages.length > 0) {
                // Extract external references from tool calls and populate cache
                const externalReferences: ExternalReference[] = [];
                for (const message of messages) {
                    if (message.tool_calls) {
                        for (const toolCall of message.tool_calls) {
                            if (isSearchExternalReferencesTool(toolCall.function?.name)) {
                                externalReferences.push(...(toolCall.result?.references || [] as ExternalReference[]));
                            }
                        }
                    }
                }
                
                if (externalReferences.length > 0) {
                    logger(`loadThreadAtom: Adding ${externalReferences.length} external references to mapping`, 1);
                    // Add to external reference mapping for UI display
                    set(addExternalReferencesToMappingAtom, externalReferences);
                    // Check if references exist in Zotero
                    set(checkExternalReferencesAtom, externalReferences);
                }
                
                // Load item data
                const allItemReferences = new Set<string>();
                
                // Filter out external citations before trying to load item data
                const zoteroCitations = citationMetadata.filter(citation => !isExternalCitation(citation));
                
                [...userAttachments, ...zoteroCitations, ...toolAttachments]
                    .filter(att => att.library_id && att.zotero_key) // Extra safety check
                    .map(att => `${att.library_id}-${att.zotero_key}`)
                    .forEach(ref => allItemReferences.add(ref));

                const itemsPromises = Array.from(allItemReferences).map(ref => {
                    const [libraryId, key] = ref.split('-');
                    return Zotero.Items.getByLibraryAndKeyAsync(parseInt(libraryId), key);
                })
                const itemsToLoad = (await Promise.all(itemsPromises)).filter(Boolean) as Zotero.Item[];

                if (itemsToLoad.length > 0) {
                    await loadFullItemDataWithAllTypes(itemsToLoad);

                    if (!Zotero.Styles.initialized()) {
                        await Zotero.Styles.init();
                    }
                }

                // Update the thread messages and attachments state
                set(threadMessagesAtom, messages);
                set(userAttachmentsAtom, userAttachments);
                set(citationMetadataAtom, citationMetadata);
                await set(updateCitationDataAtom);
                // set(toolAttachmentsAtom, toolAttachments);
                set(addToolCallResponsesToToolAttachmentsAtom, {messages: messages});
                
                // Set proposed actions
                set(threadProposedActionsAtom, proposedActions);

                // Validate proposed actions and undo if not valid
                await Promise.all(proposedActions.map(async action => {
                    const isValid = await validateAppliedAction(action);
                    if (!isValid) {
                        logger(`loadThreadAtom: undoing proposedAction ${action.id} because it is not valid`, 1);
                        set(undoProposedActionAtom, action.id);
                    }
                    return isValid;
                }));

                // Check for external references and populate cache
                const createItemActions = proposedActions.filter(isCreateItemAction) as CreateItemProposedAction[];
                if (createItemActions.length > 0) {
                    logger(`loadThreadAtom: Adding external references from proposed actions to mapping`, 1);
                    const references = createItemActions.map((action) => action.proposed_data?.item).filter(Boolean) as ExternalReference[];
                    // Add to external reference mapping for UI display
                    set(addExternalReferencesToMappingAtom, references);
                    // Check if references exist in Zotero
                    set(checkExternalReferencesAtom, references);
                }
                
            }
        } catch (error) {
            console.error('Error loading thread:', error);
        } finally {
            set(isLoadingThreadAtom, false);
        }
        // Clear sources for now
        set(currentMessageItemsAtom, []);
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(currentMessageContentAtom, '');
    }
);


export const setMessageContentAtom = atom(
    null,
    (get, set, { id, content }: { id: string; content: string }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message => 
            message.id === id ? { ...message, content } : message
        ));
    }
);

export const streamToMessageAtom = atom(
    null,
    (get, set, { id, chunk }: { id: string; chunk: string }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
            message.id === id ? { ...message, content: message.content + chunk } : message
        ));
    }
);

export const streamReasoningToMessageAtom = atom(
    null,
    (get, set, { id, chunk }: { id: string; chunk: string }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
            message.id === id ? { ...message, reasoning_content: message.reasoning_content + chunk } : message
        ));
    }
);

export const setMessageStatusAtom = atom(
    null,
    (get, set, { id, status, error, warnings }: { id: string; status?: ChatMessage['status']; error?: ErrorMessage; warnings?: WarningMessage[] }) => {
        const messages = get(threadMessagesAtom);
        const message = messages.find(message => message.id === id);
        if (!message) return;
        const toolcalls = message.tool_calls?.map((toolcall) => {
            return {
                ...toolcall,
                status: status === 'error' || status === 'canceled' ? 'error' : toolcall.status
            }
        }) as ToolCall[];

        set(threadMessagesAtom, messages.map(message =>
            message.id === id
                ? {
                    ...message,
                    ...(status && { status }),
                    ...(error && { error }),
                    ...(warnings && { 
                        warnings: [
                            ...(message.warnings || []), // Spread existing warnings or empty array if undefined
                            ...warnings                  // Spread new warnings
                        ]
                    }),
                    ...(toolcalls && { tool_calls: toolcalls })
                }
                : message
        ));
    }
);

export const updateMessageAtom = atom(
    null,
    (get, set, { id, updates }: { id: string; updates: Partial<ChatMessage> }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
            message.id === id
                ? { ...message, ...updates }
                : message
        ));
    }
);

export const addWarningToMessageAtom = atom(
    null,
    (get, set, { id, warning }: { id: string; warning: WarningMessage }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
            message.id === id ? { ...message, warnings: [...(message.warnings || []), warning] } : message
        ));
    }
);

export const removeWarningFromMessageAtom = atom(
    null,
    (get, set, { id, warningId }: { id: string; warningId: string }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
            message.id === id ? { ...message, warnings: message.warnings?.filter(w => w.id !== warningId) } : message
        ));
    }
);

export const removeMessageAtom = atom(
    null,
    (get, set, { id }: { id: string }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).filter(message => message.id !== id));
        set(citationMetadataAtom, (prev) => 
            prev.filter(a => a.message_id !== id)
        );
        set(updateCitationDataAtom);
        set(clearMessageUIStateAtom, id);
    }
);


export const addToolCallResponsesToToolAttachmentsAtom = atom(
    null,
    async (get, set, { messages }: { messages: ChatMessage[] }) => {
        const attachments: MessageAttachmentWithId[] = [];
        const itemsToLoad = new Set<Zotero.Item>();
        const messagesWithToolCalls = messages.filter(message => message.tool_calls && message.tool_calls.length > 0);

        for (const message of messagesWithToolCalls) {
            const messageAttachments = message.tool_calls!.flatMap(getResultAttachmentsFromToolcall);
            for (const attachment of messageAttachments || []) {
                const validAttachment = await Zotero.Items.getByLibraryAndKeyAsync(attachment.library_id, attachment.zotero_key);
                if (validAttachment) {
                    itemsToLoad.add(validAttachment);
                    attachments.push({...attachment, messageId: message.id});
                }
            }
        }
        await loadFullItemDataWithAllTypes([...itemsToLoad]);
        set(toolAttachmentsAtom, (prevAttachments: MessageAttachmentWithId[]) => [...prevAttachments, ...attachments]);
    }
);

export const addOrUpdateMessageAtom = atom(
    null,
    (get, set, { message, beforeId }: { message: ChatMessage; beforeId?: string }) => {
        const existingMessage = get(threadMessagesAtom).find(m => m.id === message.id);
        if (existingMessage) {
            set(threadMessagesAtom, get(threadMessagesAtom).map(m =>
                m.id === message.id
                    ? {
                        ...m,
                        ...(message.content && { content: message.content }),
                        ...(message.status && { status: message.status }),
                        ...(message.tool_calls && {
                            tool_calls: normalizeToolCalls(message.tool_calls, m.tool_calls) || m.tool_calls
                        })
                    }
                    : m
            ));
        } else {
            if (beforeId) {
                const currentMessages = get(threadMessagesAtom);
                const insertIndex = currentMessages.findIndex(m => m.id === beforeId);
                
                if (insertIndex !== -1) {
                    // Insert before the specified message
                    set(threadMessagesAtom, [
                        ...currentMessages.slice(0, insertIndex),
                        {
                            ...message,
                            ...(message.tool_calls && {
                                tool_calls: normalizeToolCalls(message.tool_calls)
                            })
                        },
                        ...currentMessages.slice(insertIndex)
                    ]);
                } else {
                    set(threadMessagesAtom, [
                        ...currentMessages,
                        {
                            ...message,
                            ...(message.tool_calls && {
                                tool_calls: normalizeToolCalls(message.tool_calls)
                            })
                        }
                    ]);
                }
            } else {
                set(threadMessagesAtom, [
                    ...get(threadMessagesAtom),
                    {
                        ...message,
                        ...(message.tool_calls && {
                            tool_calls: normalizeToolCalls(message.tool_calls)
                        })
                    }
                ]);
            }
        }
    }
);

export const addOrUpdateToolcallAtom = atom(
    null,
    (get, set, { messageId, toolcallId, toolcall }: { messageId: string; toolcallId: string; toolcall: ToolCall }) => {
        set(threadMessagesAtom, (prevMessages) =>
            prevMessages.map((message) => {
                if (message.id === messageId) {
                    const toolCalls = message.tool_calls ? [...message.tool_calls] : [];
                    const existingToolCallIndex = toolCalls.findIndex(tc => tc.id === toolcallId);

                    if (existingToolCallIndex !== -1) {
                        const existingToolCall = toolCalls[existingToolCallIndex];
                        toolCalls[existingToolCallIndex] = normalizeToolCallWithExisting(
                            toolcall,
                            existingToolCall
                        );
                    } else {
                        toolCalls.push(normalizeToolCallWithExisting(toolcall));
                    }
                    return { ...message, tool_calls: toolCalls };
                }
                return message;
            })
        );
    }
);
