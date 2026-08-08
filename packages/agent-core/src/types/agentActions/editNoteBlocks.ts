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
 * - replace: overwrite the addressed block (or, with `block: 'all'`, the whole body)
 * - insert: splice new content after an addressed position
 * - delete: remove a block, or an inclusive range of blocks
 */
export type EditNoteBlocksOp = 'replace' | 'insert' | 'delete';

/**
 * Machine-readable reason an edit was skipped during validation.
 *
 * - `expect_mismatch`: `expect` did not match the block at the addressed number
 * - `expect_end_mismatch`: `expect_end` did not match the block at `to_block`
 * - `block_out_of_range`: the addressed block number does not exist in the note
 * - `address_outside_read_window`: the address is outside the window the
 *   snapshot token records as actually shown to the model
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
 *   span or use `block: 'all'`.
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
    | 'address_outside_read_window'
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
    //   replace  → `block` (or `block: 'all'`)
    //   insert   → `after`
    //   delete   → `from_block` [.. `to_block`]
    // -------------------------------------------------------------------------
    /**
     * `replace` only. Block to replace (1-based). The literal `'all'` means a
     * whole-body rewrite; an `'all'` edit must be the sole edit in the request.
     */
    block?: number | 'all';
    /**
     * The text the sender believes is currently at the address it is
     * confirming, in simplified format. A mismatch skips the edit with
     * `expect_mismatch`. Which address it confirms, and whether it is required,
     * depends on `op`:
     *
     * - `replace`: confirms `block`. REQUIRED, except for `block: 'all'` (a
     *   whole-body rewrite has no single block to confirm).
     * - `delete`: confirms `from_block`. REQUIRED. A multi-line delete also
     *   confirms its far end via `expect_end`.
     * - `insert`: NOT USED and never required — an insert has no line it is
     *   overwriting, and `after: 0` / `after: 'end'` name a seam rather than a
     *   block at all. Requiring it here would make appending impossible.
     *
     * Matching is prefix-with-floor against the addressed line's visible-text
     * projection; lines with no visible text are confirmed by their outermost
     * attribute-stripped tag (`<ul>`, `</li>`, `<p>`, …).
     */
    expect?: string;
    /**
     * Payload for `replace` and `insert`, in the simplified format. May be
     * multiple lines; the engine expands it back into raw HTML. Not used by
     * `delete`.
     */
    content?: string;

    // -------------------------------------------------------------------------
    // insert
    // -------------------------------------------------------------------------
    /**
     * `insert` only. Position to insert `content` after (1-based). `0` means the
     * very start of the note; the literal `'end'` means the end of the body.
     * An insert carries no `expect` (see `expect`).
     */
    after?: number | 'end';

    // -------------------------------------------------------------------------
    // delete
    // -------------------------------------------------------------------------
    /**
     * First block of the deletion (1-based, inclusive).
     *
     * NOTE: the wire/persisted field is plain `from_block` — it is never
     * aliased to `from`. The model-facing tool argument alias `from` exists
     * only on the backend tool layer and is normalized away before an action is
     * emitted, so nothing on this side has to know about it.
     */
    from_block?: number;
    /**
     * Last block of the deletion (1-based, inclusive). Absent means a
     * single-line delete of `from_block`. Never aliased to `to` (see
     * `from_block`).
     */
    to_block?: number;
    /**
     * The text the sender believes is currently at `to_block`, in simplified
     * format. Required if and only if `to_block > from_block`: a multi-line
     * delete confirms both ends of the range, a single-line delete only needs
     * `expect`. A mismatch skips the edit with `expect_end_mismatch`.
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
     * of editing the wrong line. The read window rides INSIDE the token — there
     * is no separate window field to keep in sync with it.
     */
    snapshot?: string;
    /** Ordered list of block edits to apply to the note */
    edits: EditNoteBlocksEditItem[];
    /**
     * Set by validation when a `block: 'all'` rewrite would discard or replace
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
 * snapshot, except for a `block: 'all'` rewrite, which stores the FULL pre-edit
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
     * Exact raw HTML fragment that was removed by the applied edit
     * (data-citation-items already stripped). For a `block: 'all'` rewrite this
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
     * Its read window follows the same rule as everywhere else: it records what
     * was actually SHOWN. It therefore carries the whole-note window only when
     * the action's response also shipped the post-edit note; otherwise it
     * carries the canonical empty window `0-0`, and numeric addressing against
     * it fails closed until the model re-reads.
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
