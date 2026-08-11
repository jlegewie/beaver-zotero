/**
 * Type definitions for the edit_note_blocks agent action.
 *
 * A third note-editing variant alongside `edit_note` (single string match) and
 * `edit_note_batch` (multiple string matches). Instead of addressing the note
 * by matching text, edits address it by BLOCK NUMBER: the 1-based line numbers
 * of the simplified note projection that `read_note` renders. Payload strings
 * (`expect`, `content`, `expect_end`) are still in the same simplified HTML
 * format as the other two variants (with <citation/>, <annotation/>, etc.).
 *
 * Addressing by number requires an agreed-upon numbering, so any edit that
 * addresses by number carries a `snapshot` token issued by `read_note`
 * (see `EditNoteBlocksProposedData.snapshot`).
 */

import type { ProposedAction } from './base';

/**
 * One block edit. `op` discriminates which of the field groups on
 * {@link EditNoteBlocksEditItem} apply.
 *
 * - replace: overwrite the addressed block
 * - insert: splice new content after an addressed block
 * - prepend: splice new content at the very start of the note body
 * - append: splice new content at the very end of the note body
 * - delete: remove a block, or an inclusive range of blocks
 * - rewrite: replace the whole note body (must be the sole edit)
 *
 * `prepend` and `append` address NO block. The start and end of a note are
 * absolute positions: they cannot be off by one, they do not move when the
 * numbering shifts, and there is nothing at them to confirm. So they take
 * `content` and nothing else — no `block`, no `after`, no `expect`. That is
 * also why `insert` has no `after: 0` and no `after: 'end'` sentinel: every
 * spelling of "at the start" or "at the end" is one of these two ops.
 */
export type EditNoteBlocksOp =
    | 'replace'
    | 'insert'
    | 'prepend'
    | 'append'
    | 'delete'
    | 'rewrite';

/**
 * Machine-readable reason an edit was skipped during validation.
 *
 * - `expect_mismatch`: `expect` did not match the block at the addressed number
 * - `expect_end_mismatch`: `expect_end` did not match the block at `to`
 * - `block_out_of_range`: the addressed block number does not exist in the note
 * - `unbalanced_range`: the addressed range is not tag-balanced — it contains a
 *   container opener with no matching closer inside the range, or a closer whose
 *   opener is outside it (e.g. a lone `</ul>`, a delete crossing a `</li>`+`<li>`
 *   seam, a lone replace of a structural `<td>` line). ProseMirror repairs such
 *   edits by RESTRUCTURING the document, so they are refused.
 * - `structural_seam`: an `insert` whose seam falls between a container's own
 *   structural lines (e.g. between `<tr>` and `<td>`, or between `<ul>` and its
 *   first `<li>`). Seams at container boundaries are fine.
 * - `span_partial_edit`: the edit touches a line of a MULTILINE opaque span
 *   (display math, `<pre>`), or an insert seam falls strictly inside one. In v1
 *   no line of a multiline span is individually editable — replace the whole
 *   span or use a sole `op: 'rewrite'` edit.
 * - `annotation_immutable`: the edit would change annotation text — either it
 *   addresses a line of a multiline `<annotation>`, or the expansion layer found
 *   the annotation's inner text altered. Annotations may be moved or deleted
 *   whole, never text-edited.
 * - `unaddressable_range`: the range crosses a line that is not part of the
 *   addressable body — a hidden Beaver footer sitting mid-document. The fix is
 *   to issue one range per side of the skipped line.
 * - `invalid_edit`: the edit is structurally invalid (missing required field for
 *   its `op`, contradictory fields, a delete of the trailing empty line, …)
 * - `expansion_failed`: the edit's `content` could not be expanded from
 *   simplified format back into raw HTML
 * - `overlapping_edits`: two edits in the same request address overlapping blocks
 */
export type EditNoteBlocksSkipReasonCode =
    | 'expect_mismatch'
    | 'expect_end_mismatch'
    | 'block_out_of_range'
    | 'unbalanced_range'
    | 'structural_seam'
    | 'span_partial_edit'
    | 'annotation_immutable'
    | 'unaddressable_range'
    | 'invalid_edit'
    | 'expansion_failed'
    | 'overlapping_edits';

/**
 * A single edit within an edit_note_blocks request.
 *
 * Block numbers are 1-based line numbers of the simplified note projection —
 * the same numbering `read_note` displays. All payload strings use the
 * simplified HTML format.
 *
 * SKIPPED-NESS IS DERIVED, NOT STORED: an edit is skipped if and only if
 * `skip_reason_code` is present. There is deliberately no `validation_status`
 * field to fall out of sync with it — every consumer asks the same question the
 * same way (`!!edit.skip_reason_code`).
 */
export interface EditNoteBlocksEditItem {
    /** Position of this edit in the request's edits[] array */
    index: number;
    /** Client-assigned identifier for correlating this edit across validate/execute/undo */
    client_item_id?: string;
    /** Which kind of edit this is; discriminates the field groups below */
    op: EditNoteBlocksOp;

    // -------------------------------------------------------------------------
    // Addressing, by op:
    //   replace  → `block`
    //   insert   → `after`
    //   prepend  → (none)
    //   append   → (none)
    //   delete   → `block` [.. `to`]
    //   rewrite  → (none)
    // -------------------------------------------------------------------------
    /**
     * `replace` and `delete`. The addressed block (1-based): the block to
     * replace, or the first block of a deletion.
     */
    block?: number;
    /**
     * The text the sender believes is currently at the address it is
     * confirming, in simplified format. A mismatch skips the edit with
     * `expect_mismatch`. Which address it confirms, and whether it is required,
     * depends on `op`:
     *
     * - `replace`: confirms `block`. REQUIRED.
     * - `delete`: confirms `block`. REQUIRED. A multi-line delete also
     *   confirms its far end via `expect_end`.
     * - `insert`: confirms the anchor block `after`. REQUIRED. Uniquely for
     *   insert, matching accepts the END of the anchor's visible text as well
     *   as its start.
     * - `prepend` / `append` / `rewrite`: not used — they address no block.
     *
     * Matching is prefix-with-floor against the addressed line's visible-text
     * projection (prefix-or-suffix for insert anchors); lines with no visible
     * text are confirmed by their outermost attribute-stripped tag (`<ul>`,
     * `</li>`, `<p>`, …), and blank lines by an empty string.
     */
    expect?: string;
    /**
     * Payload for `replace`, `insert`, `prepend` and `append` (may be multiple
     * lines; the engine expands it back into raw HTML), or the ENTIRE new note
     * body for `rewrite`. Not used by `delete`.
     */
    content?: string;

    // -------------------------------------------------------------------------
    // insert
    // -------------------------------------------------------------------------
    /**
     * `insert` only. The block `content` is spliced in after (1-based, >= 1).
     *
     * There is no `0` and no `'end'`: the start and end of the note are
     * addressed by `op: 'prepend'` / `op: 'append'`, which take no address at
     * all. Every `after` value therefore names a real block that `expect`
     * confirms.
     */
    after?: number;

    // -------------------------------------------------------------------------
    // delete
    // -------------------------------------------------------------------------
    /**
     * `delete` only. Last block of the deletion (1-based, inclusive). Absent
     * means a single-line delete of `block`.
     */
    to?: number;
    /**
     * The text the sender believes is currently at `to`, in simplified format.
     * Required if and only if `to > block`: a multi-line delete confirms both
     * ends of the range, a single-line delete only needs `expect`. A mismatch
     * skips the edit with `expect_end_mismatch`.
     */
    expect_end?: string;

    // -------------------------------------------------------------------------
    // Persisted per-edit display metadata, added by validation
    // -------------------------------------------------------------------------
    // Everything below is written by validation onto the persisted edit purely
    // so the card and the diff preview have something to render. It is DISPLAY
    // METADATA ONLY: execute always re-resolves the edit against the live note
    // and never trusts these values.
    /** Present if and only if this edit was skipped; see {@link EditNoteBlocksSkipReasonCode} */
    skip_reason_code?: EditNoteBlocksSkipReasonCode;
    /** Human-readable explanation matching `skip_reason_code` */
    skip_reason?: string;
    /** Diff-preview operation label for this edit */
    operation?: string;
    /**
     * Presentational "before" text for the diff preview.
     *
     * For `insert` edits this is ANCHOR-MERGED rather than the literal splice:
     * it holds the anchor line alone (the block named by `after`), and
     * `new_string` holds the anchor line plus the inserted content. This makes
     * an insert render as a normal before/after diff. It is NOT the raw region
     * the engine actually splices.
     */
    old_string?: string;
    /**
     * Presentational "after" text for the diff preview. For `insert` edits this
     * is the anchor line plus the inserted content — see `old_string`.
     */
    new_string?: string;
    /** Raw-note context immediately before the target region, for preview anchoring */
    target_before_context?: string;
    /** Raw-note context immediately after the target region, for preview anchoring */
    target_after_context?: string;
}

/**
 * Proposed data for editing a note by block number.
 */
export interface EditNoteBlocksProposedData {
    /** Library ID of the note item */
    library_id: number;
    /** Zotero key of the note item */
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /**
     * Address snapshot token issued by `read_note`; required whenever any edit
     * addresses by number. It pins the numbering the edits were written
     * against, so a note that changed underneath the model fails loudly instead
     * of editing the wrong line. The token also binds the note's identity, so
     * one issued for a different note never verifies here.
     */
    snapshot?: string;
    /** Ordered list of block edits to apply to the note */
    edits: EditNoteBlocksEditItem[];
    /**
     * Set by validation when an `op: 'rewrite'` edit would discard or replace
     * most of the note. The wire action type stays `edit_note_blocks`, so this
     * flag is what lets the approval layer treat the rewrite as its own
     * authorization group instead of an ordinary note edit.
     */
    destructive_rewrite?: boolean;
}

/**
 * A single edit that was successfully applied within an edit_note_blocks action.
 */
export interface EditNoteBlocksAppliedEdit {
    /** Position of this edit in the request's edits[] array */
    index: number;
    /** Client-assigned identifier for the applied edit, echoed back from the request */
    client_item_id?: string;
    /**
     * Advisory post-edit block address of what this edit produced, e.g. "12" or
     * "12-14". Advisory only: it describes the note as of the moment the action
     * finished, and is meant for display and for orienting the model, not for
     * re-addressing without a fresh snapshot.
     */
    blocks: string;
}

/**
 * A single edit that was skipped instead of applied.
 * An edit appears here exactly when its `skip_reason_code` is set.
 */
export interface EditNoteBlocksSkippedEdit {
    /** Position of this edit in the request's edits[] array */
    index: number;
    /** Client-assigned identifier for the skipped edit, echoed back from the request */
    client_item_id?: string;
    /** Machine-readable skip reason */
    reason_code: EditNoteBlocksSkipReasonCode;
    /** Human-readable explanation matching `reason_code` */
    reason: string;
    /**
     * Whitespace-collapsed text of the block actually found at the addressed
     * position, pre-truncated by the sender. Lets the model see what it hit
     * without another read_note round trip.
     */
    actual?: string;
    /** Advisory hint about where the intended content seems to live now, e.g. "17" or "17-19" */
    block_hint?: string;
}

/**
 * Per-edit undo record for an applied edit_note_blocks action.
 *
 * This reuses the batch engine's undo record shape — the raw HTML fragment plus
 * its surrounding context — with `{ index, client_item_id?, op }` identifying
 * the edit. Undo therefore stores the changed region rather than a full-note
 * snapshot, except for an `op: 'rewrite'` edit, which stores the FULL pre-edit
 * stripped note body in `undo_old_html` (a whole-body rewrite has no bounded
 * region to diff against).
 */
export interface EditNoteBlocksUndoRecord {
    /** Position of this edit in the request's edits[] array */
    index: number;
    /** Client-assigned identifier for the edit, echoed back from the request */
    client_item_id?: string;
    /** Operation that was applied for this edit */
    op: EditNoteBlocksOp;
    /**
     * Present, and set to `'whole_body'`, ONLY on the record for a
     * whole-body `op: 'rewrite'` edit — the one record whose `undo_old_html` is the
     * entire pre-edit body rather than a bounded fragment, and which undo must
     * therefore restore wholesale instead of relocating.
     *
     * This is a POSITIVE marker on purpose. The obvious alternative — infer the
     * whole-body case from `undo_new_html` being absent — is a negative test on
     * an optional field that round-trips through the backend verbatim, so any
     * schema drift or omitting dump that dropped `undo_new_html` would silently
     * promote an ordinary fragment record to a whole-body restore and replace
     * the entire note with that fragment. A marker that must be present to
     * trigger the destructive path fails the safe way instead.
     */
    undo_scope?: 'whole_body';
    /**
     * Exact raw HTML fragment that was removed by the applied edit
     * (data-citation-items already stripped). For an `op: 'rewrite'` edit this
     * carries the FULL pre-edit stripped note body rather than a fragment.
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
     * data-citation-items). Supports robust undo when Zotero normalizes the
     * edited fragment.
     */
    undo_before_context?: string;
    /**
     * Surrounding context after the edited region (raw HTML, stripped of
     * data-citation-items). Supports robust undo when Zotero normalizes the
     * edited fragment.
     */
    undo_after_context?: string;
}

/**
 * Result data after applying an edit_note_blocks action.
 */
export interface EditNoteBlocksResultData {
    /** Library ID of the edited note */
    library_id: number;
    /** Zotero key of the edited note */
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /** Address snapshot token for the note as it stood immediately before this action */
    address_pre_snapshot?: string;
    /**
     * Address snapshot token for the note as it stands after this action.
     *
     * Emitted whether or not the response also shipped the post-edit note: the
     * token identifies the note version, which is true either way.
     */
    address_post_snapshot?: string;
    /** Edits that were successfully applied, in request order */
    applied: EditNoteBlocksAppliedEdit[];
    /** Edits that were skipped, in request order */
    skipped: EditNoteBlocksSkippedEdit[];
    /** Warnings (e.g., duplicate citation) */
    warnings?: string[];
    /** Per-applied-edit undo records, in request order */
    undo: EditNoteBlocksUndoRecord[];
}

/** Typed proposed action for edit_note_blocks */
export type EditNoteBlocksProposedAction = ProposedAction & {
    action_type: 'edit_note_blocks';
    proposed_data: EditNoteBlocksProposedData;
    result_data?: EditNoteBlocksResultData;
};
