import type {
    AnnotationProposedData,
    AnnotationResultData
} from './annotations';
import type {
    CreateItemProposedData,
    CreateItemResultData
} from './items';


/**
 * Status of a proposed action in its lifecycle
 */
export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

/**
 * Types of actions that can be proposed by the AI
 */
export type ActionType = 'highlight_annotation' | 'note_annotation' | 'zotero_note' | 'create_item' | 'edit_metadata';

/**
 * Union type for all proposed data types
 */
export interface NoteProposedData {
    title: string;
    content?: string | null;
    library_id?: number | null;
    zotero_key?: string | null;
    /** Raw tag from LLM output - used for matching during streaming */
    raw_tag?: string;
}

export interface NoteResultData {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
}

export type ProposedData = AnnotationProposedData | NoteProposedData | CreateItemProposedData;

/**
 * Type of result data after applying an action
 */
export type ActionResultDataType = AnnotationResultData | NoteResultData | CreateItemResultData;

/**
 * Core proposed action model matching the backend schema
 */
export interface ProposedAction {
    // Identity
    id: string;
    message_id: string;
    toolcall_id?: string;
    user_id: string;

    // Action type
    action_type: ActionType;

    // Status
    status: ActionStatus;
    error_message?: string;
    error_details?: Record<string, any>;

    // Action-specific proposed data and result data
    proposed_data: Record<string, any>; // Will be cast to specific types based on action_type
    result_data?: Record<string, any>; // Populated after application
    // proposed_data: ProposedData;
    // result_data?: ActionResultDataType; // Populated after application

    // Timestamps
    created_at: string;
    updated_at: string;
}

// Re-export annotation types for convenience
export type {
    AnnotationProposedAction,
    AnnotationProposedData,
    AnnotationResultData,
    HighlightAnnotationProposedData,
    NoteAnnotationProposedData,
    NotePosition,
    ToolAnnotationColor
} from './annotations';


// Re-export annotation type guards and utilities for convenience
export {
    isHighlightAnnotationAction,
    isNoteAnnotationAction,
    isAnnotationAction,
    isAnnotationTool
} from './annotations';
