import { atom } from "jotai";
import { ChatMessage, createAssistantMessage, Thread, Warning } from "../types/messages";
import { ThreadSource, SourceCitation, InputSource } from "../types/sources";
import { getZoteroItem, getCitationFromItem, getReferenceFromItem, getParentItem, getIdentifierFromSource, getDisplayNameFromItem, createSourceFromItem } from "../utils/sourceUtils";
import { createZoteroURI } from "../utils/zoteroURI";
import { currentUserMessageAtom, resetCurrentSourcesAtom, updateSourcesFromReaderAtom, updateSourcesFromZoteroSelectionAtom } from "./input";
import { isLibraryTabAtom, isPreferencePageVisibleAtom, userScrolledAtom } from "./ui";
import { getResultAttachments } from "../types/chat/converters";
import { chatService } from "../../src/services/chatService";

// Thread messages and sources
export const currentThreadIdAtom = atom<string | null>(null);
export const threadMessagesAtom = atom<ChatMessage[]>([]);
export const threadSourcesAtom = atom<ThreadSource[]>([]);

// Derived atom for thread source keys
export const threadSourceKeysAtom = atom((get) => {
    const sources = get(threadSourcesAtom);
    return sources.map((source) => source.itemKey);
});

// Derived atom for source citations
export const sourceCitationsAtom = atom<Record<string, SourceCitation>>((get) => {
    const sources = get(threadSourcesAtom);
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

// Derived atom for thread source count
export const threadSourceCountAtom = atom((get) => {
    return get(threadSourcesAtom).length;
});

// Derived atoms for thread status
export const isStreamingAtom = atom((get) => {
    const messages = get(threadMessagesAtom);
    return messages.some((message) => ['searching', 'thinking', 'in_progress'].includes(message.status));
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
            set(setMessageStatusAtom, { id: streamingMessage.id, status: 'canceled' });
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
        set(threadSourcesAtom, []);
        set(currentUserMessageAtom, '');
        set(resetCurrentSourcesAtom);
        set(isPreferencePageVisibleAtom, false);
        // READER VIEW
        if (!isLibraryTab) {
            set(updateSourcesFromZoteroSelectionAtom);
        } else {
            set(updateSourcesFromReaderAtom);
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
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
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
                    })
                }
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
export const addToolCallSourcesToThreadSourcesAtom = atom(
    null,
    async (get, set, { messages }: { messages: ChatMessage[] }) => {
        const sources: ThreadSource[] = [];
        for (const message of messages) {
            if (message.tool_calls && message.tool_calls.length > 0) {
                const attachments = message.tool_calls.flatMap(getResultAttachments);
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
        set(threadSourcesAtom, (prevSources: ThreadSource[]) => [...prevSources, ...sources]);
    }
);

export const addOrUpdateMessageAtom = atom(
    null,
    (get, set, { message, beforeId }: { message: ChatMessage; beforeId?: string }) => {
        const existingMessage = get(threadMessagesAtom).find(m => m.id === message.id);
        if (existingMessage) {
            set(threadMessagesAtom, get(threadMessagesAtom).map(m =>
                m.id === message.id ? { ...message } : m
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

export const rollbackChatToMessageIdAtom = atom(
    null,
    (get, set, messageId: string) => {
        const threadMessages = get(threadMessagesAtom);
        const threadSources = get(threadSourcesAtom);

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
        const newThreadSources = threadSources.filter(r => r.messageId && messageIds.includes(r.messageId));
        set(threadSourcesAtom, newThreadSources);

        // return new messages
        return newMessages;
    }
);