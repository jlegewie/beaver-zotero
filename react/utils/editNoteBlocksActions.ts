/**
 * Local (UI-initiated) apply and undo for `edit_note_blocks` agent actions.
 *
 * The sibling of `editNoteActions.ts`'s `executeEditNoteBatchAction` /
 * `undoEditNoteBatchAction`, and deliberately built the same way: the guard
 * sequence is mirrored line for line, and everything that decides WHAT the note
 * becomes is shared with the WS executor rather than re-implemented here.
 *
 *   - apply  → `planBlockEditsExecution` (the whole synchronous critical
 *              section: simplify → verify snapshot → select → apply → footer →
 *              citation rebuild → wrapper guard)
 *   - undo   → `applyBatchUndoRecord` (the batch replay chain; block undo
 *              records ARE batch undo records with a different discriminant)
 *
 * WHY RE-RESOLUTION IS NOT OPTIONAL. This path runs when the user clicks
 * Apply/Retry, which can be long after validation. The persisted edits carry
 * per-edit DISPLAY metadata (`skip_reason_code`, `old_string`, `new_string`,
 * `target_*_context`) written by validation for the card and the diff preview.
 * None of it is execution input: `planBlockEditsExecution` reads only the
 * addressing fields (`op`/`block`/`after`/`from_block`/`to_block`/`expect`/
 * `expect_end`/`content`) and re-resolves every edit against the note as it
 * stands now. An edit validation marked skipped is re-evaluated and may apply;
 * an edit validation accepted may now be skipped. Partial application, same as
 * the WS executor.
 */

import type { AgentAction } from '../agents/agentActions';
import type {
    EditNoteBlocksProposedData,
    EditNoteBlocksResultData,
    EditNoteBlocksAppliedEdit,
    EditNoteBlocksUndoRecord,
} from '@beaver/agent-core/types/agentActions/editNoteBlocks';
import type { EditNoteBatchUndoRecord } from '@beaver/agent-core/types/agentActions/editNoteBatch';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID, resolveItemReference } from '../../src/utils/libraryIdentity';
import { getOrSimplify, invalidateSimplificationCache } from '../../src/utils/noteHtmlSimplifier';
import { preloadNotePageLabels } from '../../src/utils/noteCitationExpand';
import {
    getLatestNoteHtml,
    waitForNoteSaveStabilization,
    flushLiveEditorToDB,
} from '../../src/utils/noteEditorIO';
import {
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
} from '../../src/utils/noteWrapper';
import { assertNoPreviewMarkers, containsPreviewMarkers, stripPreviewMarkers } from '../../src/utils/notePreviewGuard';
import { clearNoteEditorSelection } from './sourceUtils';
import { store } from '../store';
import { currentThreadIdAtom } from '../atoms/threads';
import {
    buildInlineNoteState,
    checkBlocksShape,
    editContents,
    planBlockEditsExecution,
    preloadBlockLabels,
    refreshBlockUndoRecords,
    resolveCitationDegrades,
} from '../../src/services/agentDataProvider/actions/editNoteBlocks';
import { getExternalRefContext } from '../../src/services/agentDataProvider/actions/editNote';
import { applyBatchUndoRecord, assertNoteLibraryNotExcluded } from './editNoteActions';

/**
 * Re-apply an `edit_note_blocks` action locally.
 *
 * Guard sequence, mirroring `executeEditNoteBatchAction`: shape gate →
 * exclusion assert (BEFORE any item lookup crosses the library boundary) →
 * resolve → isNote → library editable → load note → flush the live editor →
 * repair persisted preview markup → apply → save ONCE → stabilize → clear the
 * editor selection → invalidate the simplification cache.
 *
 * The provisional-read/authoritative-re-read split and the no-await critical
 * section are the block-addressing-specific part; see the header of
 * `src/services/agentDataProvider/actions/editNoteBlocks.ts`.
 */
export async function executeEditNoteBlocksAction(
    action: AgentAction,
): Promise<EditNoteBlocksResultData> {
    const {
        library_id: requestedLibraryId,
        library_ref,
        zotero_key,
        edits,
        snapshot,
        destructive_rewrite,
    } = action.proposed_data as EditNoteBlocksProposedData;

    const shapeError = checkBlocksShape(edits, snapshot);
    if (shapeError) {
        throw new Error(shapeError.error);
    }

    // Library exclusions can change after validation/action creation. Enforce
    // the boundary again before resolving or loading the note.
    assertNoteLibraryNotExcluded({
        library_id: requestedLibraryId,
        library_ref,
    });

    // 1. Load item. Resolve through library_ref (with legacy library_id
    //    fallback) so a note in a group library resolves to the right local
    //    library even when this device numbers that group differently.
    const resolved = await resolveItemReference({ library_id: requestedLibraryId, library_ref, zotero_key });
    if (resolved.status !== 'found') {
        throw new Error(resolved.status === 'library_unavailable'
            ? `Note library is not available on this computer: ${library_ref || requestedLibraryId}-${zotero_key}`
            : `Item not found: ${requestedLibraryId}-${zotero_key}`);
    }
    const item = resolved.item;
    const library_id = item.libraryID;

    if (!item.isNote()) {
        throw new Error(`Item ${library_id}-${zotero_key} is not a note`);
    }

    // Library editability can change after validation (TOCTOU): fail with a
    // clear message instead of a raw Zotero save error.
    const targetLibrary = Zotero.Libraries.get(library_id);
    if (targetLibrary && !targetLibrary.editable) {
        throw new Error(`Library '${targetLibrary.name}' is read-only and cannot be edited`);
    }

    // 2. Load note data
    await item.loadDataType('note');

    // 2b. Promote any unsaved editor content into the DB so this apply sees
    //     the same HTML validation saw. See flushLiveEditorToDB for rationale.
    await flushLiveEditorToDB(item);

    const noteId = `${library_id}-${zotero_key}`;

    // 2c. Repair notes that contain persisted diff-preview markup, mirroring
    //     the agent execute path.
    {
        const persistedHtml: string = item.getNote();
        if (containsPreviewMarkers(persistedHtml)) {
            const repaired = stripPreviewMarkers(persistedHtml);
            if (!containsPreviewMarkers(repaired)) {
                logger(`executeEditNoteBlocksAction: repairing persisted diff-preview markup in ${noteId}`, 1);
                item.setNote(repaired);
                await item.saveTx();
                await waitForNoteSaveStabilization(item, repaired);
            } else {
                logger(`executeEditNoteBlocksAction: diff-preview markup in ${noteId} could not be fully stripped; save will be refused by the preview guard`, 1);
            }
        }
    }

    // 3. PROVISIONAL read + every async preload. Block addressing verifies a
    //    digest of the note, so nothing may be awaited between the read the
    //    digest is taken over and the write — see the critical-section rule.
    const provisionalHtml: string = item.getNote();
    const pageLabelsByItemId = await preloadNotePageLabels(provisionalHtml, library_id, { extractOnCacheMiss: true });
    const labels = await preloadBlockLabels(edits);
    const externalRefContext = getExternalRefContext();
    const degrades = await resolveCitationDegrades(editContents(edits), externalRefContext);
    const threadId = store.get(currentThreadIdAtom);

    // 4. AUTHORITATIVE re-read.
    const oldHtml: string = item.getNote();

    // 5. NO AWAITS until after setNote(): one synchronous call by construction.
    const plan = planBlockEditsExecution({
        oldHtml,
        noteId,
        libraryId: library_id,
        edits,
        snapshot,
        destructiveRewrite: destructive_rewrite,
        pageLabelsByItemId,
        labels,
        externalRefContext,
        degrades,
        threadId,
    });
    if (!plan.ok) {
        throw new Error(plan.error);
    }

    // 6. Save ONCE.
    try {
        assertNoPreviewMarkers(plan.newHtml, 'editNoteBlocksActions:apply');
        item.setNote(plan.newHtml);
        await item.saveTx();
        logger(`executeEditNoteBlocksAction: Saved ${plan.appliedIdentities.length} block edit(s) to ${noteId}`, 1);
    } catch (error) {
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteBlocksActions:rollback');
            item.setNote(oldHtml);
        } catch (_) { /* best-effort */ }
        throw new Error(`Failed to save note: ${error}`);
    }

    await waitForNoteSaveStabilization(item, plan.newHtml);
    clearNoteEditorSelection(library_id, zotero_key);
    invalidateSimplificationCache(noteId);

    // 7. Refresh undo contexts against the final (post-footer, PM-normalized) HTML.
    const finalRawHtml = getLatestNoteHtml(item);
    const undo = refreshBlockUndoRecords(
        plan.undo, plan.undoDrafts, stripDataCitationItems(finalRawHtml), plan.newStrippedHtml,
    );

    // 8. Re-simplify for the post-edit numbering (the advisory `blocks` ranges
    //    and `address_post_snapshot`).
    const postPageLabels = await preloadNotePageLabels(finalRawHtml, library_id, { extractOnCacheMiss: true });
    const { simplified: postSimplified } = getOrSimplify(noteId, finalRawHtml, library_id, postPageLabels);
    const postState = buildInlineNoteState(postSimplified);

    const appliedBlocks = plan.resolveAppliedBlocks(postState.total_lines);
    const applied: EditNoteBlocksAppliedEdit[] = plan.appliedIdentities.map((identity) => ({
        ...identity,
        blocks: appliedBlocks.get(identity.index) ?? '',
    }));

    return {
        library_id,
        zotero_key,
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
        address_pre_snapshot: plan.addressPreSnapshot,
        address_post_snapshot: postState.snapshot,
        applied,
        skipped: plan.skipped,
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
        undo,
    };
}

/**
 * True for the one record shape that restores the WHOLE body: the undo of a
 * `block: 'all'` rewrite.
 *
 * Every other record comes from `applyResolvedEdits`, whose drafts always set
 * `undo_new_html` to a string (`''` for a pure deletion). A missing
 * `undo_new_html` therefore identifies the rewrite record unambiguously, and is
 * what `edit_note_blocks` writes for it — a whole-body rewrite has no bounded
 * region to diff against, so `undo_old_html` carries the entire pre-edit
 * stripped body instead of a fragment.
 */
function isWholeBodyRestore(record: EditNoteBlocksUndoRecord): boolean {
    if (record.undo_scope !== 'whole_body') return false;
    // Cross-check the two encodings rather than trusting either alone. They can
    // only disagree if a record was built wrong or mangled in transit, and on
    // this path "guess" means "replace the whole note with a fragment", so
    // refuse instead. The marker is what SELECTS this path; this is the assert.
    if (record.op !== 'replace' || record.undo_new_html !== undefined) {
        throw new Error(
            `Cannot undo edit ${record.index}: its undo record is marked as a whole-note `
            + 'restore but does not have the shape of one. Refusing rather than risking '
            + 'replacing the note with a fragment.'
        );
    }
    return true;
}

/**
 * Present a block undo record as the batch undo record it structurally is, so
 * the single replay chain in `editNoteActions.ts` serves both variants.
 *
 * THE MAPPING GAP THIS CLOSES. `applyBatchUndoRecord` dispatches on the BATCH
 * `operation` field and defaults a record without one to `str_replace`. A block
 * record has no `operation` at all — it has `op` — so a `block: 'all'` record
 * (`op: 'replace'`, no `undo_new_html`) would otherwise default to
 * `str_replace` with an empty `undo_new_html`, take the deletion-seam path, and
 * fail on its missing context anchors instead of restoring the full body. It is
 * mapped to `rewrite` explicitly here.
 *
 * Every other block op maps to `str_replace`, which is exactly what each block
 * splice is: replace one raw range with another, with `undo_new_html === ''`
 * (a `delete`, or a `replace` with empty content) selecting the deletion-seam
 * path inside the chain, the same way a batch `str_replace` to an empty string
 * does. `str_replace_all` has no block analogue, so no record ever carries
 * `undo_occurrence_contexts`.
 */
function toBatchUndoRecord(record: EditNoteBlocksUndoRecord): EditNoteBatchUndoRecord {
    if (isWholeBodyRestore(record)) {
        if (typeof record.undo_old_html !== 'string') {
            throw new Error(
                `Cannot undo edit ${record.index}: the whole-note rewrite recorded no pre-edit body to restore.`
            );
        }
        return {
            index: record.index,
            ...(record.client_item_id !== undefined ? { client_item_id: record.client_item_id } : {}),
            operation: 'rewrite',
            undo_old_html: record.undo_old_html,
        };
    }
    return {
        index: record.index,
        ...(record.client_item_id !== undefined ? { client_item_id: record.client_item_id } : {}),
        operation: 'str_replace',
        undo_old_html: record.undo_old_html,
        undo_new_html: record.undo_new_html,
        ...(record.undo_before_context !== undefined ? { undo_before_context: record.undo_before_context } : {}),
        ...(record.undo_after_context !== undefined ? { undo_after_context: record.undo_after_context } : {}),
    };
}

/**
 * Undo an applied `edit_note_blocks` action by replaying its per-edit undo
 * records in reverse order through the shared relocation machinery. An action
 * whose sole edit was a `block: 'all'` rewrite restores the full pre-edit body
 * from `undo_old_html`.
 *
 * The fully-restored HTML is built in memory first (replaying every record
 * against the evolving stripped HTML) and saved ONCE at the end — a record that
 * cannot be located throws before anything is written. A record that is already
 * undone is a no-op rather than an error, so a retried undo is idempotent.
 */
export async function undoEditNoteBlocksAction(action: AgentAction): Promise<void> {
    const {
        library_id: requestedLibraryId,
        library_ref,
        zotero_key,
    } = action.proposed_data as EditNoteBlocksProposedData;

    const resultData = action.result_data as EditNoteBlocksResultData | undefined;
    const undoRecords = resultData?.undo;
    if (!undoRecords || undoRecords.length === 0) {
        throw new Error('No undo data available: result_data.undo is empty or missing');
    }

    // Undo is a fresh mutation and must respect exclusions that changed after
    // the action was originally applied. Check before resolving/loading.
    assertNoteLibraryNotExcluded({
        library_id: requestedLibraryId,
        library_ref,
    });

    // Resolve the note through library_ref (with legacy library_id fallback) so
    // undo targets the right note even when this device numbers a group library
    // differently than the device that applied the edit.
    const resolved = await resolveItemReference({ library_id: requestedLibraryId, library_ref, zotero_key });
    if (resolved.status !== 'found') {
        throw new Error(resolved.status === 'library_unavailable'
            ? `Note library is not available on this computer: ${library_ref || requestedLibraryId}-${zotero_key}`
            : `Item not found: ${requestedLibraryId}-${zotero_key}`);
    }
    const item = resolved.item;
    const library_id = item.libraryID;

    await item.loadDataType('note');
    const noteId = `${library_id}-${zotero_key}`;

    const currentHtml = getLatestNoteHtml(item);
    const existingCitationCache = extractDataCitationItems(currentHtml);
    let strippedHtml = stripDataCitationItems(currentHtml);

    // Replay undo records in reverse request order against the evolving HTML.
    // Nothing is written until every record has been located.
    for (const record of [...undoRecords].reverse()) {
        strippedHtml = applyBatchUndoRecord(
            strippedHtml, toBatchUndoRecord(record), library_id, 'undoEditNoteBlocksAction',
        );
    }

    // Rebuild data-citation-items, preserving the pre-undo itemData so
    // citations to foreign/unresolved URIs don't lose their labels.
    const restoredHtml = rebuildDataCitationItems(strippedHtml, existingCitationCache);

    try {
        assertNoPreviewMarkers(restoredHtml, 'editNoteBlocksActions:undo');
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteBlocksAction: Reversed ${undoRecords.length} block edit(s) on note ${noteId}`, 1);
    } catch (error) {
        throw new Error(`Failed to save note after undo: ${error}`);
    }

    // Wait for PM's async save-back to settle before any subsequent undo
    await waitForNoteSaveStabilization(item, restoredHtml);

    // Clear editor selection so it doesn't shift to unrelated text
    clearNoteEditorSelection(library_id, zotero_key);

    // Invalidate simplification cache
    invalidateSimplificationCache(noteId);
}
