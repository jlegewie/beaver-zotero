import { v4 as uuidv4 } from 'uuid';
import { ToolCall } from './apiTypes';
import { ZoteroItemReference } from '../zotero';


// WarningMessage messages
export type WarningType = "user_key_failed_unexpected" | "user_key_rate_limit_exceeded" | "user_key_failed" | "missing_attachments" | "low_credits";
export interface WarningMessage {
    id: string;
    type: WarningType;
    message: string;
    attachments?: ZoteroItemReference[];
}

// ErrorMessage messages
export interface ErrorMessage {
    id: string;
    type: string;
    message?: string;
}

// Thread types
export interface ThreadData {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

// Message types
export type MessageStatus = "searching" | "thinking" | "in_progress" | "completed" | "error" | "canceled";
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
    status: MessageStatus;
    errorType?: string;
    error?: ErrorMessage;
    warnings?: WarningMessage[];
}

export interface MessageGroup {
    role: 'user' | 'assistant' | 'system';
    messages: ChatMessage[];
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