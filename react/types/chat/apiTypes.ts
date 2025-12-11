import { MessageSearchFilters, ToolRequest } from "src/services/chatService";
import { MessageAttachment, ReaderState, SourceAttachment } from "../attachments/apiTypes";
import { CitationMetadata } from "../citations";

export interface ThreadModel {
    id: string;
    user_id: string;
    name?: string;
    created_at: string;
    updated_at: string;
}

export interface ToolFunction {
    name: string;
    arguments: Record<string, string> | string;
}

export interface ToolCallResponse {
    content: string;
    attachments: SourceAttachment[];
    error?: string;
    metadata?: Record<string, any>;
}

export { SearchExternalReferencesResult, ExternalReferenceResult } from "../../agents/toolResultTypes";
export type ToolResultUnion = SearchExternalReferencesResult;

export interface ToolCall {
    id: string;
    type: "function";
    function: ToolFunction;
    response?: ToolCallResponse;
    result?: ToolResultUnion;
    label?: string;
    status?: 'in_progress' | 'completed' | 'error';
    progress_message?: string;
}

export interface UsageModel {
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
    total_token: number;
}

export interface MessageModelMetadata {
    model?: string;
    cost?: number;
    usage?: UsageModel;
    citations?: CitationMetadata[];
}

// Input messagemodel for chat completions requests
export interface MessageData {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    reader_state: ReaderState | null;
    attachments: MessageAttachment[] | null;
    filters: MessageSearchFilters | null;
    tool_request: ToolRequest | null;
    tool_calls: ToolCall[] | null;
    status: 'in_progress' | 'completed' | 'error' | 'canceled';
}

export interface MessageModel {
    id: string; // UUID
    user_id?: string; // Set in DB
    thread_id: string; // UUID
    
    // OpenAI-message fields
    role: 'user' | 'assistant' | 'system';
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];

    // reader state and attachments
    reader_state?: ReaderState;
    attachments?: MessageAttachment[];
    filters?: MessageSearchFilters;

    // User-initiated tool requests
    tool_request?: ToolRequest;

    // Message metadata
    status: 'in_progress' | 'completed' | 'error' | 'canceled';
    created_at?: string; // Set in DB
    metadata?: MessageModelMetadata;
    error?: string;
}

export function toMessageData(message: MessageModel): MessageData {
    return {
        id: message.id,
        role: message.role,
        content: message.content,
        reader_state: message.reader_state,
        attachments: message.attachments,
        tool_request: message.tool_request,
        tool_calls: message.tool_calls,
        status: message.status
    } as MessageData;
}

export function toMessageModel(message: MessageData, threadId: string): MessageModel {
    return {
        ...message,
        thread_id: threadId,
    } as MessageModel;
}
