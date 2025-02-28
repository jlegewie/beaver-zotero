import { atom } from "jotai";
import { ChatMessage, createAssistantMessage } from "../types/messages";
import { ZoteroResource, Resource } from "../types/resources";
import { getPref } from "../../src/utils/prefs";
import { getAuthorYearCitation, ZoteroStyle } from "../../src/utils/citations";
import { getZoteroItem } from "../utils/resourceUtils";

// Current user message and content
export const userMessageAtom = atom<string>('');

// Thread messages atom
export const messagesAtom = atom<ChatMessage[]>([]);

// Derived atoms
export const isStreamingAtom = atom((get) => {
    const messages = get(messagesAtom);
    return messages.some((message) => ['searching', 'thinking', 'in_progress'].includes(message.status));
});

export const systemMessageAtom = atom((get) => {
    const messages = get(messagesAtom);
    return messages.find((message) => message.role === 'system')?.content;
});

export const sourcesAtom = atom<Resource[]>((get) => {
    const messages = get(messagesAtom);
    // Citation preferences
    const citationFormat = getPref("citationFormat") || "author-year";
    const style = getPref("citationStyle") || 'http://www.zotero.org/styles/chicago-author-date';
    const locale = getPref("citationLocale") || 'en-US';
    // CSL engine for in-text citations
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const cslEngine = csl_style.getCiteProc(locale, 'text');
    // Define list of sources
    const sources = messages
        .flatMap((message) => message.resources || [])
        .sort((a, b) => a.timestamp - b.timestamp)
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
                };
            }
            if (resource.type === 'file') {
                // Return formatted source
                return {
                    ...resource,
                    citation: 'File',
                    numericCitation: String(index + 1),
                    reference: resource.filePath,
                };
            }
            return null;
        })
        .filter(Boolean) as Resource[];
    cslEngine.free();
    return sources;
});

// Derived atom for user messages only
export const userMessagesFromThreadAtom = atom((get) => {
    const messages = get(messagesAtom);
    return messages.filter(message => message.role === 'user');
});

// Derive resource keys from messages in conversation
export const threadResourceKeysAtom = atom((get) => {
    const userMessages = get(userMessagesFromThreadAtom);
    const resources = userMessages.flatMap((message) => message.resources || []);
    const keys = resources
    .filter((resource): resource is ZoteroResource => resource.type === 'zotero_item')
    .map((resource) => resource.itemKey);
    return keys;
});

export const threadResourceCountAtom = atom((get) => {
    const userMessages = get(userMessagesFromThreadAtom);
    const resources = userMessages.flatMap((message) => message.resources || []);
    return resources.length;
});

// Setter atoms
export const setMessageContentAtom = atom(
    null,
    (get, set, { id, content }: { id: string; content: string }) => {
        set(messagesAtom, get(messagesAtom).map(message => 
            message.id === id ? { ...message, content } : message
        ));
    }
);

export const streamToMessageAtom = atom(
    null,
    (get, set, { id, chunk }: { id: string; chunk: string }) => {
        set(messagesAtom, get(messagesAtom).map(message =>
            message.id === id ? { ...message, content: message.content + chunk } : message
        ));
    }
);

export const setMessageStatusAtom = atom(
    null,
    (get, set, { id, status, errorType }: { id: string; status: ChatMessage['status']; errorType?: string }) => {
        set(messagesAtom, get(messagesAtom).map(message =>
            message.id === id ? { ...message, status, ...(errorType && { errorType }) } : message
        ));
    }
);

export const rollbackChatToMessageIdAtom = atom(
    null,
    (get, set, id: string) => {
        const messages = get(messagesAtom);
        const messageIndex = messages.findIndex(message => message.id === id);

        if (messageIndex > 0) {
            // Create a new assistant message
            const assistantMsg = createAssistantMessage();
            // Keep only the message before the specified ID
            const truncatedMessages = messages.slice(0, messageIndex);
            // Add the assistant message to the new messages
            const newMessages = [...truncatedMessages, assistantMsg];
            set(messagesAtom, newMessages);
            return newMessages;
        }
        // If message not found or is already the first message, do nothing
    }
);