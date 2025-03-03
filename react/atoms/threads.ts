import { atom } from "jotai";
import { ChatMessage, createAssistantMessage } from "../types/messages";
import { Source, ZoteroSource, SourceWithCitations } from "../types/sources";
import { getPref } from "../../src/utils/prefs";
import { citationDataFromSource, getCslEngine } from "../utils/citationFormatting";

// Thread messages and sources
export const threadMessagesAtom = atom<ChatMessage[]>([]);
export const threadSourcesAtom = atom<Source[]>([]);

// Derived atom for thread source keys
export const threadSourceKeysAtom = atom((get) => {
    const sources = get(threadSourcesAtom);
    const keys = sources
        .filter((source): source is ZoteroSource => source.type === 'zotero_item')
        .map((source) => source.itemKey);
    return keys;
});

// Derived atom for thread source count
export const threadSourceCountAtom = atom((get) => {
    const sources = get(threadSourcesAtom);
    return sources.length;
});

// Derived atoms for thread status
export const isStreamingAtom = atom((get) => {
    const messages = get(threadMessagesAtom);
    return messages.some((message) => ['searching', 'thinking', 'in_progress'].includes(message.status));
});

// Derived atom for thread sources with citations
export const threadSourcesWithCitationsAtom = atom<SourceWithCitations[]>((get) => {
    const threadSources = get(threadSourcesAtom)
        .sort((a, b) => a.timestamp - b.timestamp);
    // Citation preferences
    const style = getPref("citationStyle") || 'http://www.zotero.org/styles/chicago-author-date';
    const locale = getPref("citationLocale") || 'en-US';
    // CSL engine for in-text citations
    const cslEngine = getCslEngine(style, locale);
    // Define list of sources
    const sources = threadSources
        .map((source, index) => {
            const citationData = citationDataFromSource(source, cslEngine);
            if (!citationData) return null;
            return {
                ...source,
                ...citationData,
                numericCitation: String(index + 1)
            } as SourceWithCitations;
        })
        .filter(Boolean) as SourceWithCitations[];
    cslEngine.free();
    return sources;
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