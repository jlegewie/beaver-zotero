
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
 * MessageAttachment represents an attachment in a message.
 * Mirrors the pydantic models SourceAttachment, AnnotationAttachment, NoteAttachment
 */

export type MessageAttachment =
  | SourceAttachment
  | AnnotationAttachment
  | NoteAttachment;

interface BaseMessageAttachment {
  library_id: number;
  zotero_key: string;
}

// "source" type attachment
export interface SourceAttachment extends BaseMessageAttachment {
  type: "source";
  chunk_ids?: string[]; // UUIDs as strings
}

// "annotation" type attachment
export interface AnnotationAttachment extends BaseMessageAttachment {
  type: "annotation";
  parent_key: string;
  annotation_type: string;
  text?: string;
  comment?: string;
  color?: string;
  page_label?: string;
  position?: Record<string, any>;
  // position?: { x: number; y: number; page?: number };
  date_modified?: string; // ISO string
}

// "note" type attachment
export interface NoteAttachment extends BaseMessageAttachment {
  type: "note";
  parent_key?: string;
  note_content: string;
  date_modified?: string; // ISO string
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