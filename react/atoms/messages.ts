import { atom } from "jotai";
import { ChatMessage, createAssistantMessage } from "../types/messages";
import { Source } from "../types/resources";
import { getPref } from "../../src/utils/prefs";
import { getAuthorYearCitation, ZoteroStyle } from "../../src/utils/citations";
import { getZoteroItem } from "../utils/resourceUtils";
import { threadResourcesAtom } from "./resources";

// Current user message and content
export const currentUserMessageAtom = atom<string>('');

// Thread messages atom
export const threadMessagesAtom = atom<ChatMessage[]>([]);

// Derived atoms
export const isStreamingAtom = atom((get) => {
    const messages = get(threadMessagesAtom);
    return messages.some((message) => ['searching', 'thinking', 'in_progress'].includes(message.status));
});

export const threadSourcesWithCitationsAtom = atom<Source[]>((get) => {
    const resources = get(threadResourcesAtom)
        .sort((a, b) => a.timestamp - b.timestamp);
    // Citation preferences
    const style = getPref("citationStyle") || 'http://www.zotero.org/styles/chicago-author-date';
    const locale = getPref("citationLocale") || 'en-US';
    // CSL engine for in-text citations
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const cslEngine = csl_style.getCiteProc(locale, 'text');
    // Define list of sources
    const sources = resources
        .map((resource, index) => {
            if (resource.type === 'zotero_item') {
                // Get item and parent item
                const item = getZoteroItem(resource);
                if(!item) return null;
                const parent = item.parentItem;
                // Format in-text citations
                const citation = getAuthorYearCitation(parent || item, cslEngine);
                // Format reference
                const reference = Zotero.Cite.makeFormattedBibliographyOrCitationList(cslEngine, [parent || item], "text").trim();
                // Return formatted source
                return {
                    ...resource,
                    citation: citation,
                    numericCitation: String(index + 1),
                    reference: reference,
                } as Source;
            }
            if (resource.type === 'file') {
                // Return formatted source
                return {
                    ...resource,
                    citation: 'File',
                    numericCitation: String(index + 1),
                    reference: resource.filePath,
                } as Source;
            }
            return null;
        })
        .filter(Boolean) as Source[];
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
        const threadResources = get(threadResourcesAtom);

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

        // Remove resources for messages after the specified message
        const newThreadResources = threadResources.filter(r => r.messageId && messageIds.includes(r.messageId));
        set(threadResourcesAtom, newThreadResources);

        // return new messages
        return newMessages;
    }
);