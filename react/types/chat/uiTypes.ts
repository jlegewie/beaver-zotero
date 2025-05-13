import { v4 as uuidv4 } from 'uuid';
import { ToolCall, ZoteroItemReference } from './apiTypes';


// Warning messages
export type WarningType = "user_key_failed_unexpected" | "user_key_rate_limit_exceeded" | "user_key_failed" | "missing_attachments";
export interface Warning {
    id: string;
    type: WarningType;
    attachments?: ZoteroItemReference[];
}


// Thread types
export interface Thread {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

// Message types
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    tool_calls?: ToolCall[];
    status: 'searching' | 'thinking' | 'in_progress' | 'completed' | 'error' | 'canceled';
    errorType?: string;
    warnings?: Warning[];
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