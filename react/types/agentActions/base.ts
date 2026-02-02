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

// =============================================================================
// Edit Metadata Types
// =============================================================================

/**
 * A single metadata field edit with before/after values.
 * Matches backend MetadataEdit model.
 */
export interface MetadataEdit {
    /** The metadata field name being edited */
    field: string;
    /** The original value before the edit */
    old_value: any;
    /** The new value after the edit */
    new_value: any;
}

/**
 * A creator in Zotero's JSON API format.
 * Person creators use firstName + lastName.
 * Organization creators use name.
 */
export interface CreatorJSON {
    /** First name (for person creators) */
    firstName?: string;
    /** Last name (for person creators) */
    lastName?: string;
    /** Full name (for organization creators) */
    name?: string;
    /** Creator type (e.g., 'author', 'editor') */
    creatorType: string;
}

/**
 * Proposed data for editing metadata.
 * Matches backend EditMetadataProposedData model.
 * Inherits library_id and zotero_key (ZoteroItemReference).
 * At least one of edits (non-empty) or creators must be provided.
 */
export interface EditMetadataProposedData {
    /** Library ID of the item to edit */
    library_id: number;
    /** Zotero key of the item to edit */
    zotero_key: string;
    /** List of field edits to apply */
    edits: MetadataEdit[];
    /** New creators list (replaces all existing creators when provided) */
    creators?: CreatorJSON[] | null;
    /** Original creators before the edit (for undo display) */
    old_creators?: CreatorJSON[] | null;
}

/**
 * A single applied metadata field edit.
 */
export interface AppliedMetadataEdit {
    /** The field that was edited */
    field: string;
    /** The value that was applied */
    applied_value: any;
    /** The original value before the edit (for undo) */
    old_value?: any;
}

/**
 * A single failed metadata field edit.
 */
export interface FailedMetadataEdit {
    /** The field that failed to be edited */
    field: string;
    /** The error message explaining why the edit failed */
    error: string;
}

/**
 * Result data after applying an edit metadata action.
 * Extends ZoteroItemReference (library_id + zotero_key).
 */
export interface EditMetadataResultData {
    /** Library ID of the edited item */
    library_id: number;
    /** Zotero key of the edited item */
    zotero_key: string;
    /** List of field edits that were successfully applied */
    applied_edits: AppliedMetadataEdit[];
    /** List of field names that were rejected by the user */
    rejected_edits: string[];
    /** List of field edits that failed with errors */
    failed_edits: FailedMetadataEdit[];
    /** Original creators before the edit (for undo, present only when creators were modified) */
    old_creators?: CreatorJSON[] | null;
    /** New creators after the edit (present only when creators were modified) */
    new_creators?: CreatorJSON[] | null;
}

// =============================================================================
// Create Collection Types
// =============================================================================

/**
 * Proposed data for creating a collection
 */
export interface CreateCollectionProposedData {
    /** Library ID where the collection will be created */
    library_id: number;
    /** Name of the collection to create */
    name: string;
    /** Parent collection key (optional, for subcollections) */
    parent_key?: string | null;
    /** Item IDs to add to the collection after creation (optional) */
    item_ids?: string[];
}

/**
 * Result data after applying a create collection action.
 */
export interface CreateCollectionResultData {
    /** Library ID of the created collection */
    library_id: number;
    /** Zotero key of the created collection */
    collection_key: string;
    /** Number of items added to the collection (if any were requested) */
    items_added?: number;
}

// =============================================================================
// Organize Items Types
// =============================================================================

/**
 * Tag changes for organize_items
 */
export interface TagChanges {
    add?: string[];
    remove?: string[];
}

/**
 * Collection changes for organize_items
 */
export interface CollectionChanges {
    add?: string[];
    remove?: string[];
}

/**
 * Proposed data for organizing items (tags and collections)
 */
export interface OrganizeItemsProposedData {
    /** List of item IDs to organize (format: "library_id-zotero_key") */
    item_ids: string[];
    /** Tags to add/remove */
    tags?: TagChanges | null;
    /** Collections to add/remove */
    collections?: CollectionChanges | null;
    /** Current state of items for undo (item_id -> {tags: [...], collections: [...]}) */
    current_state?: Record<string, { tags: string[]; collections: string[] }>;
}

/**
 * Result data after applying an organize items action
 */
export interface OrganizeItemsResultData {
    /** Number of items that were successfully modified */
    items_modified: number;
    /** Tags that were added */
    tags_added?: string[];
    /** Tags that were removed */
    tags_removed?: string[];
    /** Collection keys that items were added to */
    collections_added?: string[];
    /** Collection keys that items were removed from */
    collections_removed?: string[];
    /** Items that failed (item_id -> error message) */
    failed_items?: Record<string, string>;
}

/**
 * Types of actions that can be proposed by the AI
 */
export type ActionType = 'highlight_annotation' | 'note_annotation' | 'zotero_note' | 'create_item' | 'edit_metadata' | 'create_collection' | 'organize_items';

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

export type ProposedData =
    AnnotationProposedData |
    NoteProposedData |
    CreateItemProposedData |
    EditMetadataProposedData |
    CreateCollectionProposedData |
    OrganizeItemsProposedData;

/**
 * Type of result data after applying an action
 */
export type ActionResultDataType =
    AnnotationResultData |
    NoteResultData |
    CreateItemResultData |
    CreateCollectionResultData |
    OrganizeItemsResultData |
    EditMetadataResultData;

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
