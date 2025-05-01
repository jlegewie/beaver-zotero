import { MessageAttachment } from "../attachments/apiTypes";

export interface ThreadModel {
    id: string;
    user_id: string;
    created_at: string;
    updated_at: string;
}

export interface ToolCall {
    id: string;
    type: "function";
    function: Record<string, string>;
    response?: Record<string, any> | null;
}

/**
 * AppState represents the state of the app
 */
export interface AppState {
    view: 'library' | 'reader';
    reader_type: string | null;
    library_id: number | null;
    item_keys: string[];
    selection: string | null;
    page: number | null;
}

export interface MessageModel {
    id: string;
    user_id?: string; // Set in DB
    thread_id: string;
    role: 'user' | 'assistant' | 'system';
    content?: string;
    attachments?: MessageAttachment[];
    tool_calls?: ToolCall[];
    app_state?: AppState;
    status: 'in_progress' | 'completed' | 'error' | 'canceled';
    created_at?: string;
    metadata?: Record<string, any>;
    error?: string;
}


export interface ZoteroItemIdentifier {
    zotero_key: string;
    library_id: number;
}