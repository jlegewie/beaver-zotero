import { Attachment } from "./attachments";
import { v4 as uuidv4 } from 'uuid';

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