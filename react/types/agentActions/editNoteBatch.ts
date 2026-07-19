/**
 * Type definitions for the edit_note_batch agent action.
 * Applies multiple StrReplace-style edits to a single Zotero note in one
 * action, using the same simplified HTML intermediate format as edit_note.
 */

import type { ProposedAction } from './base';
import type { EditNoteOperation } from './editNote';

/**
 * A single edit within an edit_note_batch request.
 * Strings use the simplified HTML format (with <citation/>, <annotation/>, etc. tags).
 */
export interface EditNoteBatchEditItem {
    /** Position of this edit in the batch's edits[] array */
    index: number;
    /** Client-assigned identifier for correlating this edit across validate/execute/undo */
    client_item_id?: string;
    /**
     * Operation mode. Defaults to 'str_replace' if not set.
     * - str_replace: Replace one unique match of old_string with new_string
     * - str_replace_all: Replace ALL occurrences of old_string with new_string
     * - insert_after: Insert new_string immediately after old_string (old_string kept unchanged)
     * - insert_before: Insert new_string immediately before old_string (old_string kept unchanged)
     * - rewrite: Replace the entire note body with new_string (old_string ignored)
     * - append: Add new_string to the end of the note body (old_string ignored)
     */
    operation?: EditNoteOperation;
    /** The exact string to find (in simplified HTML format). Not needed when operation is 'rewrite'. */
    old_string?: string;
    /** The replacement string (in simplified HTML format). When operation is 'rewrite', the full new note body. */
    new_string: string;
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
 * Proposed data for editing a note via a batch of string replacements,
 * applied together as a single action.
 */
export interface EditNoteBatchProposedData {
    /** Library ID of the note item */
    library_id: number;
    /** Zotero key of the note item */
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /** Ordered list of edits to apply to the note */
    edits: EditNoteBatchEditItem[];
}

/**
 * A single edit that was successfully applied within an edit_note_batch action.
 */
export interface EditNoteBatchAppliedEdit {
    /** Position of this edit in the batch's edits[] array */
    index: number;
    /** Client-assigned identifier for the applied edit, echoed back from the request */
    client_item_id?: string;
    /** Number of occurrences that were replaced by this edit */
    occurrences_replaced: number;
}

/**
 * Per-edit undo record for an applied edit_note_batch action.
 * Undo stores the exact applied raw HTML fragment for the changed region
 * rather than a full-note snapshot, except for `rewrite` edits (see
 * `undo_old_html` below).
 */
export interface EditNoteBatchUndoRecord {
    /** Position of this edit in the batch's edits[] array */
    index: number;
    /** Client-assigned identifier for the edit, echoed back from the request */
    client_item_id?: string;
    /** Operation mode that was applied for this edit */
    operation?: EditNoteOperation;
    /**
     * Exact raw HTML fragment that was removed by the applied edit
     * (data-citation-items already stripped). For a `rewrite` edit, this
     * carries the FULL pre-edit stripped note body rather than a fragment,
     * since a rewrite has no bounded region to diff against.
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
}

/**
 * Result data after applying an edit_note_batch action.
 */
export interface EditNoteBatchResultData {
    /** Library ID of the edited note */
    library_id: number;
    /** Zotero key of the edited note */
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /** Edits that were successfully applied, in request order */
    applied: EditNoteBatchAppliedEdit[];
    /** Warnings (e.g., duplicate citation) */
    warnings?: string[];
    /** Per-edit undo records, in request order */
    undo: EditNoteBatchUndoRecord[];
}

/** Typed proposed action for edit_note_batch */
export type EditNoteBatchProposedAction = ProposedAction & {
    action_type: 'edit_note_batch';
    proposed_data: EditNoteBatchProposedData;
    result_data?: EditNoteBatchResultData;
};
