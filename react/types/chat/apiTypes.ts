import { MessageAttachment, SourceAttachment } from "../attachments/apiTypes";

export interface ThreadModel {
    id: string;
    user_id: string;
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

export interface ToolCall {
    id: string;
    type: "function";
    function: ToolFunction;
    response?: ToolCallResponse;
    label?: string;
    status?: 'in_progress' | 'completed' | 'error';
}

export interface MessageModel {
    id: string;
    user_id?: string; // Set in DB
    thread_id: string;
    role: 'user' | 'assistant' | 'system';
    content?: string;
    attachments?: MessageAttachment[];
    tool_calls?: ToolCall[];
    status: 'in_progress' | 'completed' | 'error' | 'canceled';
    created_at?: string;
    metadata?: Record<string, any>;
    error?: string;
}


export interface ZoteroItemReference {
    zotero_key: string;
    library_id: number;
}

export function createZoteroItemReference(id: string): ZoteroItemReference | null {
    const [libraryId, zoteroKey] = id.split('-');
    if (!libraryId || !zoteroKey) {
        return null;
    }
    return {
        zotero_key: zoteroKey,
        library_id: parseInt(libraryId)
    };
}
