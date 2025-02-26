import { v4 as uuidv4 } from 'uuid';
import { Resource } from './resources';

// Message types
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    resources?: Resource[];
    status: 'searching' | 'thinking' | 'in_progress' | 'completed' | 'error';
    errorType?: string;
}

// Factory functions for creating messages
export const createUserMessage = (message: Partial<ChatMessage>): ChatMessage => {
    return {
        id: uuidv4(),
        role: 'user',
        content: '',
        status: 'completed',
        resources: [],
        ...message,
    };
};

export const createAssistantMessage = (message?: Partial<ChatMessage>): ChatMessage => {
    return {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        status: 'in_progress',
        resources: [],
        ...message,
    };
};