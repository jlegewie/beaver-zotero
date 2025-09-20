import { atom } from "jotai";
import { ChatMessage, ThreadData, WarningMessage } from "../types/chat/uiTypes";
import { currentMessageContentAtom, currentSourcesAtom, resetCurrentSourcesAtom, updateReaderAttachmentAtom, updateSourcesFromZoteroSelectionAtom } from "./input";
import { isLibraryTabAtom, isPreferencePageVisibleAtom, userScrolledAtom } from "./ui";
import { getResultAttachmentsFromToolcall, toMessageUI } from "../types/chat/converters";
import { chatService } from "../../src/services/chatService";
import { ToolCall } from "../types/chat/apiTypes";
import { citationMetadataAtom, citationDataAtom, updateCitationDataAtom } from "./citations";
import { MessageAttachmentWithId } from "../types/attachments/uiTypes";
import { threadService } from "../../src/services/threadService";
import { getPref } from "../../src/utils/prefs";
import { logger } from "../../src/utils/logger";
import {
    ToolAnnotation,
    annotationsFromMetadata,
    isAnnotationTool,
    mergeAnnotations,
} from '../types/chat/toolAnnotations';

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

    if (isAnnotationTool(toolcall.function?.name)) {
        const rawMetadata = toolcall.response?.metadata ?? existing?.response?.metadata;
        const metadataAnnotations = annotationsFromMetadata(rawMetadata);
        const baseAnnotations = existing?.annotations as ToolAnnotation[] | undefined;
        if (metadataAnnotations.length > 0) {
            normalized.annotations = mergeAnnotations(baseAnnotations, metadataAnnotations);
        } else if (baseAnnotations && baseAnnotations.length > 0) {
            normalized.annotations = [...baseAnnotations];
        }
    }

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
        set(citationMetadataAtom, []);
        set(citationDataAtom, []);
        set(currentMessageContentAtom, '');
        set(resetCurrentSourcesAtom);
        set(isPreferencePageVisibleAtom, false);
        // Update sources from Zotero selection or reader
        const addSelectedItemsOnNewThread = getPref('addSelectedItemsOnNewThread');
        if (isLibraryTab && addSelectedItemsOnNewThread) {
            set(updateSourcesFromZoteroSelectionAtom);
        }
        if (!isLibraryTab) {
            set(updateReaderAttachmentAtom);
        }
        set(userScrolledAtom, false);
    }
);

export const loadThreadAtom = atom(
    null,
    async (get, set, { user_id, threadId }: { user_id: string; threadId: string }) => {
        set(userScrolledAtom, false);
        // Set the current thread ID
        set(currentThreadIdAtom, threadId);
        set(isPreferencePageVisibleAtom, false);

        const statefulChat = getPref('statefulChat');
        
        if (!statefulChat) {
            const messagesDB = await Zotero.Beaver.db.getMessagesFromThread(user_id, threadId);
            logger(`messagesDB from db ${threadId} ${messagesDB.length}`);
            const messages = messagesDB.map(toMessageUI);
            
            // Extract user attachments from messages
            const userAttachments: MessageAttachmentWithId[] = [];
            for (const messageDB of messagesDB) {
                if (messageDB.role === 'user') {
                    for (const attachment of messageDB.attachments || []) {
                        userAttachments.push({ ...attachment, messageId: messageDB.id } as MessageAttachmentWithId);
                    }
                }
            }

            // Get citation metadata from messages
            const citationMetadata = messagesDB.flatMap(message => {
                const messageCitations = (message.metadata?.citations || []);
                return messageCitations.map(citation => ({ ...citation, message_id: message.id }));
            });
            
            // Update the thread messages and attachments state
            if (messages.length > 0) {
                set(threadMessagesAtom, messages);
                set(citationMetadataAtom, citationMetadata);
                set(userAttachmentsAtom, userAttachments);
                set(addToolCallResponsesToToolAttachmentsAtom, {messages: messages});
                set(updateCitationDataAtom);
            }
        } else {
            // Use remote API
            const { messages, userAttachments, toolAttachments, citationMetadata } = await threadService.getThreadMessages(threadId);
            
            if (messages.length > 0) {
                // Update the thread messages and attachments state
                set(threadMessagesAtom, messages);
                set(userAttachmentsAtom, userAttachments);
                set(citationMetadataAtom, citationMetadata);
                set(updateCitationDataAtom);
                // set(toolAttachmentsAtom, toolAttachments);
                set(addToolCallResponsesToToolAttachmentsAtom, {messages: messages});
            }
        }
        
        // Clear sources for now
        set(currentSourcesAtom, []);
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
    (get, set, { id, status, errorType, warnings }: { id: string; status?: ChatMessage['status']; errorType?: string; warnings?: WarningMessage[] }) => {
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
                    ...(errorType && { errorType }),
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
    }
);


export const addToolCallResponsesToToolAttachmentsAtom = atom(
    null,
    async (get, set, { messages }: { messages: ChatMessage[] }) => {
        const attachments: MessageAttachmentWithId[] = [];
        const messagesWithToolCalls = messages.filter(message => message.tool_calls && message.tool_calls.length > 0);

        for (const message of messagesWithToolCalls) {
            const messageAttachments = message.tool_calls!.flatMap(getResultAttachmentsFromToolcall);
            for (const attachment of messageAttachments || []) {
                const validAttachment = await Zotero.Items.getByLibraryAndKeyAsync(attachment.library_id, attachment.zotero_key);
                if (validAttachment) {
                    attachments.push({...attachment, messageId: message.id});
                }
            }
        }
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

export const upsertToolcallAnnotationAtom = atom(
    null,
    (get, set, {messageId, toolcallId, annotation} : { messageId: string; toolcallId: string; annotation: ToolAnnotation }) => {
        set(threadMessagesAtom, (prevMessages) =>
            prevMessages.map((message) => {
                // Find message and toolcall
                if (message.id !== messageId) return message;
                const toolCalls = message.tool_calls ? [...message.tool_calls] : [];
                const toolCallIndex = toolCalls.findIndex((tc) => tc.id === toolcallId);
                if (toolCallIndex === -1) return message;
                const existingToolcall = toolCalls[toolCallIndex];
                
                // Update toolcall with new annotation
                const existingAnnotations = (existingToolcall.annotations as ToolAnnotation[]) || [];
                const mergedAnnotations = mergeAnnotations(existingAnnotations, [annotation]);

                toolCalls[toolCallIndex] = {
                    ...existingToolcall,
                    annotations: mergedAnnotations,
                };

                return {
                    ...message,
                    tool_calls: toolCalls,
                };
            })
        );
    }
);

export const updateToolcallAnnotationAtom = atom(
    null,
    (get, set, { messageId, toolcallId, annotationId, updates }: { messageId: string; toolcallId: string; annotationId?: string; updates: Partial<ToolAnnotation> }) => {
        set(threadMessagesAtom, (prevMessages) =>
            prevMessages.map((message) => {
                // Find message and toolcall
                if (message.id !== messageId) return message;
                const toolCalls = message.tool_calls ? [...message.tool_calls] : [];
                const toolCallIndex = toolCalls.findIndex((tc) => tc.id === toolcallId);
                if (toolCallIndex === -1) return message;
                const existingToolcall = toolCalls[toolCallIndex];
                
                // Update toolcall annotations with new updates
                if (!existingToolcall.annotations) return message;
                const updatedAnnotations = (
                    existingToolcall.annotations as ToolAnnotation[]
                ).map((annotation) =>
                    annotationId === undefined || annotation.id === annotationId
                        ? {...annotation, ...updates }
                        : annotation
                );

                // Update toolcall with new annotations
                toolCalls[toolCallIndex] = {
                    ...existingToolcall,
                    annotations: updatedAnnotations,
                };

                return {
                    ...message,
                    tool_calls: toolCalls,
                };
            })
        );
    }
);
