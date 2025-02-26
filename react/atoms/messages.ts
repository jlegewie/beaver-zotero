import { atom } from "jotai";
import { ChatMessage, createAssistantMessage } from "../types/messages";
import { ZoteroResource } from "../types/resources";

// Current user message and content
export const userMessageAtom = atom<string>('');

// Messages atom
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