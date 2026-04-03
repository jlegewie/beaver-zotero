/**
 * Type definitions for the edit_note agent action.
 * Uses StrReplace pattern on Zotero note HTML via simplified HTML intermediate format.
 */

import type { ProposedAction } from './base';

/**
 * Proposed data for editing a note via string replacement.
 * Strings use the simplified HTML format (with <citation/>, <annotation/>, etc. tags).
 */
export interface EditNoteProposedData {
    /** Library ID of the note item */
    library_id: number;
    /** Zotero key of the note item */
    zotero_key: string;
    /** The exact string to find (in simplified HTML format). Not needed when replace_content is true. */
    old_string?: string;
    /** The replacement string (in simplified HTML format). When replace_content is true, the full new note body. */
    new_string: string;
    /** If true, replace all occurrences (default: false) */
    replace_all?: boolean;
    /** If true, replace the entire note body with new_string. old_string is ignored. */
    replace_content?: boolean;
    /**
     * Raw-note context immediately before the target fragment, taken from the
     * stripped raw HTML (`stripDataCitationItems(rawHtml)`).
     * Used to disambiguate duplicate raw matches during execution.
     */
    target_before_context?: string;
    /**
     * Raw-note context immediately after the target fragment, taken from the
     * stripped raw HTML (`stripDataCitationItems(rawHtml)`).
     * Used to disambiguate duplicate raw matches during execution.
     */
    target_after_context?: string;
}

/**
 * Result data after applying an edit_note action.
 * Undo stores the exact applied raw HTML fragment for the changed region
 * rather than a full-note snapshot.
 */
export interface EditNoteResultData {
    /** Library ID of the edited note */
    library_id: number;
    /** Zotero key of the edited note */
    zotero_key: string;
    /** Number of occurrences that were replaced */
    occurrences_replaced: number;
    /** Warnings (e.g., duplicate citation) */
    warnings?: string[];
    /**
     * Exact raw HTML fragment that was removed by the applied edit
     * (data-citation-items already stripped; fragment only, not full note HTML).
     * Used for reliable undo when proposed_data no longer expands to the
     * exact current fragment.
     */
    undo_old_html?: string;
    /**
     * Exact raw HTML fragment that was inserted by the applied edit
     * (data-citation-items already stripped; fragment only, not full note HTML).
     * Used for reliable undo without storing the entire note.
     */
    undo_new_html?: string;
    /**
     * Surrounding context before the edited region (raw HTML, stripped of
     * data-citation-items). Stored for single-occurrence edits to support
     * robust undo when Zotero normalizes the edited fragment.
     */
    undo_before_context?: string;
    /**
     * Surrounding context after the edited region (raw HTML, stripped of
     * data-citation-items). Stored for single-occurrence edits to support
     * robust undo when Zotero normalizes the edited fragment.
     */
    undo_after_context?: string;
    /**
     * Per-occurrence context anchors for replace_all edits.
     * Each entry has before/after context for one occurrence, enabling
     * individual-occurrence undo even when ProseMirror normalizes the HTML.
     */
    undo_occurrence_contexts?: Array<{ before: string; after: string }>;
    /**
     * Complete raw HTML of the note before a replace_content edit
     * (data-citation-items stripped). Stored only for replace_content edits
     * to enable full undo by restoring the entire previous note body.
     */
    undo_full_html?: string;
}

/** Typed proposed action for edit_note */
export type EditNoteProposedAction = ProposedAction & {
    action_type: 'edit_note';
    proposed_data: EditNoteProposedData;
    result_data?: EditNoteResultData;
};
