import { atom } from "jotai";
import { ChatMessage, createAssistantMessage, Thread } from "../types/messages";
import { ThreadSource, SourceCitation } from "../types/sources";
import { getZoteroItem, getCitationFromItem, getReferenceFromItem, getParentItem, getIdentifierFromSource, getDisplayNameFromItem } from "../utils/sourceUtils";
import { createZoteroURI } from "../utils/zoteroURI";
import { currentUserMessageAtom, resetCurrentSourcesAtom, updateSourcesFromZoteroSelectionAtom } from "./input";

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

// Atom to store recent threads
export const recentThreadsAtom = atom<Thread[]>([]);

// Setter atoms
export const newThreadAtom = atom(
    null,
    async (_, set) => {
        set(currentThreadIdAtom, null);
        set(threadMessagesAtom, []);
        set(threadSourcesAtom, []);
        set(currentUserMessageAtom, '');
        set(resetCurrentSourcesAtom);
        set(updateSourcesFromZoteroSelectionAtom);
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
    (get, set, { id, status, errorType }: { id: string; status: ChatMessage['status']; errorType?: string }) => {
        set(threadMessagesAtom, get(threadMessagesAtom).map(message =>
            message.id === id ? { ...message, status, ...(errorType && { errorType }) } : message
        ));
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