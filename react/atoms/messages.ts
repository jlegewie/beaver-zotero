import { atom } from "jotai";
import { v4 as uuidv4 } from 'uuid';
import { Attachment } from "./attachments";

// Message types
export type ChatMessage = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    attachments?: Attachment[];
    status: 'searching' | 'thinking' | 'in_progress' | 'completed' | 'error';
}

export const createUserMessage = (message: Partial<ChatMessage>): ChatMessage => {
    return {
        id: uuidv4(),
        role: 'user',
        content: '',
        status: 'completed',
        attachments: [],
        ...message,
    };
};

export const createAssistantMessage = (message?: Partial<ChatMessage>): ChatMessage => {
    return {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        status: 'in_progress',
        attachments: [],
        ...message,
    };
};

// Current user message and content parts
export const userMessageAtom = atom<string>('');
export const userAttachmentsAtom = atom<Attachment[]>([]);

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
