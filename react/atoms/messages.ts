import { atom } from "jotai";
import { Attachment } from "../types/attachments";
import { ChatMessage } from "../types/messages";


// Current user message and content parts
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

// Derive attachment keys from messages in conversation
export const threadAttachmentKeysAtom = atom((get) => {
    const userMessages = get(userMessagesFromThreadAtom);
    const attachments = userMessages.flatMap((message) => message.attachments || []);
    const keys = attachments
        .filter((attachment) => attachment.type == 'zotero_item')
        .map((attachment) => attachment.item.key);
    return keys;
});

export const threadAttachmentCountAtom = atom((get) => {
    const userMessages = get(userMessagesFromThreadAtom);
    const attachments = userMessages.flatMap((message) => message.attachments || []);
    return attachments.length;
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
    (get, set, { id, status }: { id: string; status: ChatMessage['status'] }) => {
        set(messagesAtom, get(messagesAtom).map(message =>
            message.id === id ? { ...message, status } : message
        ));
    }
);