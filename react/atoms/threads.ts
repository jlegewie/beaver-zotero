import { atom } from "jotai";
import { ChatMessage, createAssistantMessage } from "../types/messages";
import { Source, ZoteroSource } from "../types/sources";
import { getZoteroItem, getCitationFromItem, getNameFromItem, getReferenceFromItem } from "../utils/sourceUtils";
import { createZoteroURI } from "../utils/zoteroURI";

// Thread messages and sources
export const threadMessagesAtom = atom<ChatMessage[]>([]);
export const threadSourcesAtom = atom<Source[]>([]);

// Derived atom for thread source keys
export const threadSourceKeysAtom = atom((get) => {
    const sources = get(threadSourcesAtom);
    const keys = sources
        .filter((source): source is ZoteroSource => source.type === 'zotero_item')
        .map((source) => source.itemKey);
    const childrenKeys = sources
        .filter((source) => source.type === 'zotero_item' && source.childItemKeys)
        .flatMap((source) => (source as ZoteroSource).childItemKeys);
    return [...keys, ...childrenKeys];
});

// Derived atom for thread source count
export const threadSourceCountAtom = atom((get) => {
    const sources = get(flattenedThreadSourcesAtom);
    return sources.length;
});

// Derived atoms for thread status
export const isStreamingAtom = atom((get) => {
    const messages = get(threadMessagesAtom);
    return messages.some((message) => ['searching', 'thinking', 'in_progress'].includes(message.status));
});

export const flattenedThreadSourcesAtom = atom<Source[]>((get) => {
    // Flatten sources
    const flatThreadSources = get(threadSourcesAtom)
        .sort((a, b) => a.timestamp - b.timestamp)
        .flatMap((source) => {
            if (source.type === 'zotero_item' && source.childItemKeys && source.childItemKeys.length > 0) {
                return source.childItemKeys.map(key => ({...source, itemKey: key}));
            }
            return [source];
        });

    // Update sources with item details
    const updatedFlatThreadSources = flatThreadSources
        .map((source, index) => {
            if (source.type !== 'zotero_item') return source;
            const item = getZoteroItem(source);
            if (!item) return null;
            return {
                ...source,
                numericCitation: String(index + 1),
                url: createZoteroURI(item),
                name: item.isNote() ? getNameFromItem(item) : source.name,
                citation: item.isNote() ? getCitationFromItem(item) : source.citation,
                reference: item.isNote() ? getReferenceFromItem(item) : source.reference,
                icon: item.isNote() ? item.getItemTypeIconName() : source.icon,
                parentKey: item.parentKey || null,
            };
        })
        .filter(Boolean) as Source[];
    
    return updatedFlatThreadSources;
});


// Setter atoms
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