import { atom } from "jotai";
import { ChatMessage, createAssistantMessage, Thread, Warning } from "../types/chat/uiTypes";
import { ThreadSource, SourceCitation, InputSource } from "../types/sources";
import { getZoteroItem, getCitationFromItem, getReferenceFromItem, getParentItem, getIdentifierFromSource, getDisplayNameFromItem, createSourceFromItem, createThreadSourceFromItem } from "../utils/sourceUtils";
import { createZoteroURI } from "../utils/zoteroURI";
import { currentMessageContentAtom, resetCurrentSourcesAtom, updateReaderAttachmentAtom, updateSourcesFromZoteroSelectionAtom } from "./input";
import { isLibraryTabAtom, isPreferencePageVisibleAtom, userScrolledAtom } from "./ui";
import { getResultAttachmentsFromToolcall, toMessageUI } from "../types/chat/converters";
import { chatService } from "../../src/services/chatService";
import { ToolCall } from "../types/chat/apiTypes";
import { createZoteroItemReference } from "../types/chat/apiTypes";

// Thread messages and sources
export const currentThreadIdAtom = atom<string | null>(null);
export const currentAssistantMessageIdAtom = atom<string | null>(null);
export const threadMessagesAtom = atom<ChatMessage[]>([]);

/*
 * Thread sources and source keys by source
 *
 * Thread sources are added from three sources:
 * 1. User message attachments
 * 2. Responses from tool calls
 * 3. Cited sources
 */
export const userAddedSourcesAtom = atom<ThreadSource[]>([]);
export const toolCallSourcesAtom = atom<ThreadSource[]>([]);
// Cited sources derived from message content
export const citedSourcesAtom = atom<ThreadSource[]>((get) => {
    const messages = get(threadMessagesAtom);
    // Extract all citation IDs from the message content
    const citationIds: string[] = [];
    const citationRegex = /<citation\s+(?:[^>]*?)id="([^"]+)"(?:[^>]*?)\s*(?:\/>|><\/citation>)/g;
    for (const message of messages) {
        if (message.role === 'assistant' && message.content !== null) {
            let match;
            while ((match = citationRegex.exec(message.content)) !== null) {
                if (match[1] && !citationIds.includes(match[1])) {
                    citationIds.push(match[1]);
                }
            }
        }
    }
    // Derive cited sources from citation IDs
    const citedSources: ThreadSource[] = citationIds
        .map(createZoteroItemReference)
        .filter(itemRef => itemRef !== null)
        .map(itemRef => Zotero.Items.getByLibraryAndKey(itemRef.library_id, itemRef.zotero_key))
        .filter(item => item !== null)
        .map(item => createThreadSourceFromItem(item as Zotero.Item));

    return citedSources;
});

// User added source keys
export const userAddedSourceKeysAtom = atom((get) => {
    return get(userAddedSourcesAtom).map((source) => source.itemKey);
});

// Combined thread sources and keys
// export const threadSourcesAtom = atom<ThreadSource[]>((get) => {
//     return [...get(userAddedSourcesAtom), ...get(toolCallSourcesAtom), ...get(citedSourcesAtom)];
// });

// True after a chat request is sent and before the first assistant response arrives.
// Used to show a spinner during initial LLM response loading.
export const isChatRequestPendingAtom = atom<boolean>(false);

// Derived atom for source citations
export const sourceCitationsAtom = atom<Record<string, SourceCitation>>((get) => {
    const sources = get(citedSourcesAtom);
    return sources.reduce((acc, source) => {
        const identifier = getIdentifierFromSource(source);
        const item = getZoteroItem(source);
        const parentItem = getParentItem(source);
        const itemToCite = item && item.isNote() ? item : parentItem || item;
        if(!item || !itemToCite) return acc;
        acc[identifier] = {
            ...source,
            citation: getCitationFromItem(itemToCite),
            name: getDisplayNameFromItem(itemToCite),
            reference: getReferenceFromItem(itemToCite),
            url: createZoteroURI(item),
            icon: item.getItemTypeIconName(),
            numericCitation: Object.keys(acc).length > 0 ? (Object.keys(acc).length + 1).toString() : '1',
        };
        return acc;
    }, {} as Record<string, SourceCitation>);
});

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
export const recentThreadsAtom = atom<Thread[]>([]);

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
        set(userAddedSourcesAtom, []);
        set(toolCallSourcesAtom, []);
        set(currentMessageContentAtom, '');
        set(resetCurrentSourcesAtom);
        set(isPreferencePageVisibleAtom, false);
        // Update sources from Zotero selection or reader
        if (isLibraryTab) {
            set(updateSourcesFromZoteroSelectionAtom);
        } else {
            set(updateReaderAttachmentAtom);
        }
        set(userScrolledAtom, false);
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

export const setMessageStatusAtom = atom(
    null,
    (get, set, { id, status, errorType, warnings }: { id: string; status?: ChatMessage['status']; errorType?: string; warnings?: Warning[] }) => {
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
    (get, set, { id, warning }: { id: string; warning: Warning }) => {
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


export const addToolCallSourcesToThreadSourcesAtom = atom(
    null,
    async (get, set, { messages }: { messages: ChatMessage[] }) => {
        const sources: ThreadSource[] = [];
        for (const message of messages) {
            if (message.tool_calls && message.tool_calls.length > 0) {
                const attachments = message.tool_calls.flatMap(getResultAttachmentsFromToolcall);
                if (attachments.length > 0) {
                    const items = await Promise.all(attachments.map(async (att) => await Zotero.Items.getByLibraryAndKeyAsync(att!.library_id, att!.zotero_key)));
                    const messageSources = await Promise.all(items
                        .filter(item => item && (item.isNote() || item.isAttachment()))
                        .map(async (item) => await createSourceFromItem(item as Zotero.Item))
                    );
                    sources.push(...messageSources as ThreadSource[]);
                }
            }
        }
        set(toolCallSourcesAtom, (prevSources: ThreadSource[]) => [...prevSources, ...sources]);
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
                        ...(message.tool_calls && { tool_calls: message.tool_calls }),
                        ...(message.status && { status: message.status })
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
                        message,
                        ...currentMessages.slice(insertIndex)
                    ]);
                } else {
                    set(threadMessagesAtom, [...currentMessages, message]);
                }
            } else {
                set(threadMessagesAtom, [...get(threadMessagesAtom), message]);
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
                        // Replace existing tool call
                        toolCalls[existingToolCallIndex] = toolcall;
                    } else {
                        // Append new tool call
                        toolCalls.push(toolcall);
                    }
                    return { ...message, tool_calls: toolCalls };
                }
                return message;
            })
        );
    }
);

export const rollbackChatToMessageIdAtom = atom(
    null,
    (get, set, messageId: string) => {
        const threadMessages = get(threadMessagesAtom);

        // Find the index of the message to continue from
        const messageIndex = threadMessages.findIndex(m => m.id === messageId);
        if (messageIndex < 0) return null;
        
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
        const newUserAddedSources = get(userAddedSourcesAtom).filter(r => r.messageId && messageIds.includes(r.messageId));
        set(userAddedSourcesAtom, newUserAddedSources);
        const newToolCallSources = get(toolCallSourcesAtom).filter(r => r.messageId && messageIds.includes(r.messageId));
        set(toolCallSourcesAtom, newToolCallSources);

        // return new messages
        return newMessages;
    }
);