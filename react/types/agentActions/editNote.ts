/**
 * Type definitions for the edit_note agent action.
 * Uses StrReplace pattern on Zotero note HTML via simplified HTML intermediate format.
 */

/**
 * Proposed data for editing a note via string replacement.
 * Strings use the simplified HTML format (with <citation/>, <annotation/>, etc. tags).
 */
export interface EditNoteProposedData {
    /** Library ID of the note item */
    library_id: number;
    /** Zotero key of the note item */
    zotero_key: string;
    /** The exact string to find (in simplified HTML format) */
    old_string: string;
    /** The replacement string (in simplified HTML format) */
    new_string: string;
    /** If true, replace all occurrences (default: false) */
    replace_all?: boolean;
}

/**
 * Result data after applying an edit_note action.
 * Captures full HTML snapshots for undo/redo.
 */
export interface EditNoteResultData {
    /** Library ID of the edited note */
    library_id: number;
    /** Zotero key of the edited note */
    zotero_key: string;
    /** Full raw note HTML before edit (for undo) */
    old_html: string;
    /** Full raw note HTML after edit (for redo) */
    new_html: string;
    /** Number of occurrences that were replaced */
    occurrences_replaced: number;
    /** Warnings (e.g., duplicate citation) */
    warnings?: string[];
}
