import { v4 as uuidv4 } from 'uuid';

// Message types
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    status: 'searching' | 'thinking' | 'in_progress' | 'completed' | 'error';
    errorType?: string;
}

// Factory functions for creating messages
export const createUserMessage = (content: string): ChatMessage => {
    return {
        id: uuidv4(),
        role: 'user',
        content: content,
        status: 'completed',
    };
};

export const createAssistantMessage = (message?: Partial<ChatMessage>): ChatMessage => {
    return {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        status: 'in_progress',
        ...message,
    };
};