/**
 * Utilities for executing and undoing edit_note agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import type { EditNoteResultData, EditNoteOperation } from '../types/agentActions/editNote';
import { logger } from '../../src/utils/logger';
import {
    getOrSimplify,
    countOccurrences,
    invalidateSimplificationCache,
} from '../../src/utils/noteHtmlSimplifier';
import { checkDuplicateCitations } from '../../src/utils/editNoteValidation';
import { findRangeByContexts } from '../../src/utils/editNoteRawPosition';
import {
    expandToRawHtml,
    preloadPageLabelsForNewCitations,
    type ExternalRefContext,
} from '../../src/utils/noteCitationExpand';
import {
    getLatestNoteHtml,
    waitForPMNormalization,
    waitForNoteSaveStabilization,
    flushLiveEditorToDB,
} from '../../src/utils/noteEditorIO';
import {
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
    hasSchemaVersionWrapper,
} from '../../src/utils/noteWrapper';
import {
    decodeHtmlEntities,
    encodeTextEntities,
    ENTITY_FORMS,
} from '../../src/utils/noteHtmlEntities';
import {
    resolveEditTargetAtRuntime,
    buildExecutionZeroMatchMessage,
    locateEditFragment,
    findWhitespaceTolerant,
    normalizeUndoComparisonHtml,
} from '../../src/utils/editNotePositionLookup';
import { clearNoteEditorSelection } from './sourceUtils';
import { store } from '../store';
import { currentThreadIdAtom } from '../atoms/threads';
import { addOrUpdateEditFooter } from '../../src/utils/noteEditFooter';
import {
    externalReferenceMappingAtom,
    externalReferenceItemMappingAtom,
} from '../atoms/externalReferences';

/**
 * Snapshot the thread's external-reference state from the Jotai store so
 * `expandToRawHtml('new', ...)` can resolve `<citation external_id="..."/>`
 * to either an in-library Zotero item or an inline `<a>` link.
 */
function getExternalRefContext(): ExternalRefContext {
    return {
        externalRefs: store.get(externalReferenceMappingAtom),
        externalItemMapping: store.get(externalReferenceItemMappingAtom),
    };
}

/**
 * Undo a str_replace_all edit by locating each occurrence via its stored context anchors.
 * Returns the restored HTML, or undefined if any occurrence cannot be found.
 */
function undoReplaceAllViaContexts(
    strippedHtml: string,
    undoOldHtml: string,
    undoNewHtml: string,
    occurrenceContexts: Array<{ before: string; after: string }>,
    libraryId: number
): string | undefined {
    // Collect all replacement ranges, working from last to first to avoid index shifting
    const ranges: Array<{ start: number; end: number }> = [];

    for (const ctx of occurrenceContexts) {
        const range = findRangeByContexts(strippedHtml, ctx.before, ctx.after, undoNewHtml.length);
        if (!range) return undefined; // Context not found — bail out

        // Verify the region is semantically equivalent to the expected new fragment
        const regionHtml = strippedHtml.substring(range.start, range.end);
        if (regionHtml !== undoNewHtml) {
            const normalizedRegion = normalizeUndoComparisonHtml(regionHtml, libraryId);
            const normalizedExpected = normalizeUndoComparisonHtml(undoNewHtml, libraryId);
            if (normalizedRegion !== normalizedExpected) return undefined;
        }

        ranges.push(range);
    }

    if (ranges.length === 0) return undefined;

    // Sort ranges from last to first so replacements don't shift earlier indices
    ranges.sort((a, b) => b.start - a.start);

    let result = strippedHtml;
    for (const range of ranges) {
        result = result.substring(0, range.start) + undoOldHtml + result.substring(range.end);
    }
    return result;
}

/**
 * Check if the edit appears already undone using context anchors when available.
 * Falls back to bare `includes()` when no context is stored.
 */
function isAlreadyUndone(
    strippedHtml: string,
    undoOldHtml: string,
    beforeCtx?: string,
    afterCtx?: string
): boolean {
    if (beforeCtx !== undefined || afterCtx !== undefined) {
        const range = findRangeByContexts(strippedHtml, beforeCtx, afterCtx, undoOldHtml.length);
        if (range) {
            return strippedHtml.substring(range.start, range.end) === undoOldHtml;
        }
        // Context anchors were expected but could not be found in the current
        // HTML (likely due to ProseMirror whitespace normalization drift).
        return false;
    }
    return strippedHtml.includes(undoOldHtml);
}

const UNDO_CONTEXT_LENGTH = 200;

/**
 * Execute an edit_note agent action by applying string replacement on the note.
 * @param action The agent action to execute
 * @returns Result data including the exact applied HTML fragment for undo
 */
export async function executeEditNoteAction(
    action: AgentAction
): Promise<EditNoteResultData> {
    const {
        library_id,
        zotero_key,
        old_string,
        new_string,
        operation: rawOp,
    } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        old_string?: string;
        new_string: string;
        operation?: EditNoteOperation;
        target_before_context?: string;
        target_after_context?: string;
    };
    // For insert_after / insert_before, new_string is already normalized by
    // validation to merge old_string with new_string (via normalized_action_data):
    //   - insert_after:  new_string = old_string + new_string
    //   - insert_before: new_string = new_string + old_string
    // so the rest of the function treats it as a regular str_replace.
    const operation: EditNoteOperation = rawOp ?? 'str_replace';
    let {
        target_before_context,
        target_after_context,
    } = action.proposed_data as {
        target_before_context?: string;
        target_after_context?: string;
    };

    // 1. Load item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    // 2. Load note data
    await item.loadDataType('note');

    // 2b. Promote any unsaved editor content into the DB so this apply sees
    //     the same HTML validation saw. See flushLiveEditorToDB for rationale.
    await flushLiveEditorToDB(item);

    // 3. Get current note HTML
    const oldHtml: string = item.getNote();

    // 4. Get metadata from cache or re-simplify
    const noteId = `${library_id}-${zotero_key}`;
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id);

    // 5. Pre-load page labels so new citations resolve page indices to labels
    await preloadPageLabelsForNewCitations(new_string);

    // Snapshot external-reference state once so every expandToRawHtml('new', ...)
    // below can resolve `<citation external_id="..."/>` consistently.
    const externalRefContext = getExternalRefContext();

    // ── rewrite mode: replace entire note body ──
    if (operation === 'rewrite') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext);
        } catch (e: any) {
            throw new Error(e.message || String(e));
        }

        const existingCitationCache = extractDataCitationItems(oldHtml);
        const strippedHtml = stripDataCitationItems(oldHtml);

        // Preserve wrapper div
        const trimmed = strippedHtml.trim();
        let wrapperOpen = '';
        let wrapperClose = '';
        if (trimmed.startsWith('<div') && trimmed.endsWith('</div>')) {
            const closeAngle = trimmed.indexOf('>');
            wrapperOpen = trimmed.substring(0, closeAngle + 1);
            wrapperClose = '</div>';
        }

        let newHtml = wrapperOpen + expandedNew + wrapperClose;

        const threadId = store.get(currentThreadIdAtom);
        if (threadId) {
            newHtml = addOrUpdateEditFooter(newHtml, threadId);
        }

        // Preserve pre-edit itemData so citations to foreign/unresolved URIs
        // don't lose their labels after the round-trip through ProseMirror.
        newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

        const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
        if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
            throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
        }

        try {
            item.setNote(newHtml);
            await item.saveTx();
            logger(`executeEditNoteAction: Saved rewrite edit to ${noteId}`, 1);
        } catch (error) {
            try { item.setNote(oldHtml); } catch (_) { /* best-effort */ }
            throw new Error(`Failed to save note: ${error}`);
        }

        await waitForNoteSaveStabilization(item, newHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);

        const duplicateWarning = checkDuplicateCitations(new_string, metadata);
        const warnings = duplicateWarning ? [duplicateWarning] : undefined;

        return {
            library_id,
            zotero_key,
            occurrences_replaced: 1,
            warnings,
            undo_full_html: strippedHtml,
        };
    }

    // ── String replacement mode (default) ──

    // 6. Expand old_string and new_string to raw HTML
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext);
    } catch (e: any) {
        throw new Error(e.message || String(e));
    }

    // 6b. Strip data-citation-items from raw HTML for matching.
    //     Snapshot the cache first so rebuild can preserve itemData for
    //     URIs that don't resolve in the current library.
    const existingCitationCache = extractDataCitationItems(oldHtml);
    const strippedHtml = stripDataCitationItems(oldHtml);

    // 7. Count occurrences — if zero, retry with entity-decoded or entity-encoded
    // strings. PM may have decoded entities (&#x27; → ') since the model read the
    // note, or the model may have used literal chars while the note has entities.
    let matchCount = countOccurrences(strippedHtml, expandedOld);
    if (matchCount === 0) {
        // Forward: model used &#x27; but note has ' (PM decoded)
        const decodedOld = decodeHtmlEntities(expandedOld);
        if (decodedOld !== expandedOld && countOccurrences(strippedHtml, decodedOld) > 0) {
            expandedOld = decodedOld;
            expandedNew = decodeHtmlEntities(expandedNew);
            if (target_before_context != null) target_before_context = decodeHtmlEntities(target_before_context);
            if (target_after_context != null) target_after_context = decodeHtmlEntities(target_after_context);
            matchCount = countOccurrences(strippedHtml, expandedOld);
        }
    }
    if (matchCount === 0) {
        // Reverse: model used ' but note has entity-encoded form (pre-PM).
        // Try all common entity spellings (&#x27;, &#39;, &apos;).
        for (const form of ENTITY_FORMS) {
            const encodedOld = encodeTextEntities(expandedOld, form);
            if (encodedOld !== expandedOld && countOccurrences(strippedHtml, encodedOld) > 0) {
                expandedOld = encodedOld;
                expandedNew = encodeTextEntities(expandedNew, form);
                if (target_before_context != null) target_before_context = encodeTextEntities(target_before_context, form);
                if (target_after_context != null) target_after_context = encodeTextEntities(target_after_context, form);
                matchCount = countOccurrences(strippedHtml, expandedOld);
                break;
            }
        }
    }

    // 8. Zero matches
    if (matchCount === 0) {
        throw new Error(buildExecutionZeroMatchMessage(simplified, old_string ?? ''));
    }

    // 9. Perform replacement and capture context
    let newHtml: string;
    let undoBeforeContext: string | undefined;
    let undoAfterContext: string | undefined;
    let undoOccurrenceContexts: Array<{ before: string; after: string }> | undefined;
    let replacementCount: number;
    let editPos = -1; // Position of the edit in strippedHtml (single-occurrence only)

    if (operation === 'str_replace_all') {
        replacementCount = matchCount;

        // Capture per-occurrence context anchors before replacing
        undoOccurrenceContexts = [];
        let searchFrom = 0;
        while (true) {
            const idx = strippedHtml.indexOf(expandedOld, searchFrom);
            if (idx === -1) break;
            undoOccurrenceContexts.push({
                before: strippedHtml.substring(Math.max(0, idx - UNDO_CONTEXT_LENGTH), idx),
                after: strippedHtml.substring(
                    idx + expandedOld.length,
                    idx + expandedOld.length + UNDO_CONTEXT_LENGTH
                ),
            });
            searchFrom = idx + expandedOld.length;
        }
        newHtml = strippedHtml.split(expandedOld).join(expandedNew);
    } else {
        replacementCount = 1;
        let rawPos = -1;

        // When expandedOld matches multiple times in raw HTML (e.g. duplicate citations),
        // first use the conservative matcher, then fall back to the exact target
        // context captured during validation.
        if (matchCount > 1) {
            rawPos = resolveEditTargetAtRuntime({
                strippedHtml, simplified,
                oldString: old_string ?? '',
                expandedOld,
                metadata,
                targetBeforeContext: target_before_context,
                targetAfterContext: target_after_context,
            }).rawPosition;
        }

        if (rawPos === -1) {
            if (matchCount > 1) {
                throw new Error(
                    `The string to replace was found ${matchCount} times in the note. `
                    + 'Use operation str_replace_all to replace all occurrences, or include more context.'
                );
            }
            rawPos = strippedHtml.indexOf(expandedOld);
        }

        // Capture surrounding context for robust undo of single-occurrence edits.
        undoBeforeContext = strippedHtml.substring(Math.max(0, rawPos - UNDO_CONTEXT_LENGTH), rawPos);
        const afterStart = rawPos + expandedOld.length;
        undoAfterContext = strippedHtml.substring(afterStart, afterStart + UNDO_CONTEXT_LENGTH);

        newHtml = strippedHtml.substring(0, rawPos) + expandedNew
            + strippedHtml.substring(afterStart);
        editPos = rawPos;
    }

    // 10b. Add/update "Edited by Beaver" footer
    const threadId = store.get(currentThreadIdAtom);
    if (threadId) {
        newHtml = addOrUpdateEditFooter(newHtml, threadId);
    }

    // 11. Rebuild data-citation-items, preserving pre-edit itemData so
    //     citations to foreign/unresolved URIs don't lose their labels.
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    // 12. Wrapper div protection — only error if the edit removed it
    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
    }

    // 12b. Recapture undo contexts from the post-edit, post-footer stripped HTML.
    // The initial capture (from pre-edit strippedHtml at step 9) may be stale
    // because addOrUpdateEditFooter inserts/moves content before </div>, causing
    // the after-context to diverge from what the note actually contains after saving.
    // The edit position is unchanged since the footer is appended at the end.
    if (editPos !== -1 && undoBeforeContext !== undefined) {
        const postEditStripped = stripDataCitationItems(newHtml);
        const posInNew = editPos + expandedNew.length;
        undoBeforeContext = postEditStripped.substring(
            Math.max(0, editPos - UNDO_CONTEXT_LENGTH), editPos);
        undoAfterContext = postEditStripped.substring(
            posInNew, posInNew + UNDO_CONTEXT_LENGTH);
    }

    // 13. Save
    try {
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteAction: Saved note edit to ${noteId} (${replacementCount} occurrence(s) replaced)`, 1);
    } catch (error) {
        // Restore in-memory state on save failure
        try {
            item.setNote(oldHtml);
        } catch (_) {
            // Best-effort restoration
        }
        throw new Error(`Failed to save note: ${error}`);
    }

    // 13b. Wait for PM's async save-back to settle before any subsequent edit
    await waitForNoteSaveStabilization(item, newHtml);

    // 13c. Clear editor selection so it doesn't shift to unrelated text
    clearNoteEditorSelection(library_id, zotero_key);

    // 14. Invalidate cache
    invalidateSimplificationCache(noteId);

    // 15. Check for duplicate citation warnings
    const duplicateWarning = checkDuplicateCitations(new_string, metadata);
    const warnings = duplicateWarning ? [duplicateWarning] : undefined;

    const result: EditNoteResultData = {
        library_id,
        zotero_key,
        occurrences_replaced: replacementCount,
        warnings,
        undo_old_html: expandedOld,
        undo_new_html: expandedNew,
        undo_before_context: undoBeforeContext,
        undo_after_context: undoAfterContext,
        undo_occurrence_contexts: undoOccurrenceContexts,
    };

    // 16. Wait for ProseMirror to normalize the note and update undo data.
    // When the note is open in the editor, PM re-normalizes after saveTx().
    // We poll until PM processes or timeout, then update undo_new_html in-place
    // so the returned result already has correct undo data.
    const savedStrippedHtml = stripDataCitationItems(newHtml);
    await waitForPMNormalization(item, savedStrippedHtml, result, strippedHtml);

    return result;
}

/**
 * Undo an edit_note agent action using the exact applied HTML fragment when available.
 * Falls back to reverse expansion of proposed_data for older actions.
 *
 * 3-way detection (analogous to edit_metadata undo):
 * - new_string found → undo succeeds (replace with old_string)
 * - old_string found instead → already undone, no-op
 * - neither found → note was modified externally, error
 *
 * For deletions (new_string is empty), uses surrounding context stored in
 * result_data (undo_before_context / undo_after_context) to locate the
 * insertion point.
 *
 * @param action The agent action to undo (must have proposed_data with old_string/new_string)
 */
export async function undoEditNoteAction(
    action: AgentAction
): Promise<void> {
    const { library_id, zotero_key, old_string, new_string, operation: rawOp } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        old_string?: string;
        new_string: string;
        operation?: EditNoteOperation;
    };
    const operation: EditNoteOperation = rawOp ?? 'str_replace';

    const resultData = action.result_data as EditNoteResultData | undefined;

    // ── rewrite undo: restore full note from undo_full_html ──
    if (resultData?.undo_full_html) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
        if (!item) {
            throw new Error(`Item not found: ${library_id}-${zotero_key}`);
        }
        await item.loadDataType('note');
        const noteId = `${library_id}-${zotero_key}`;

        // Seed the rebuild with the current note's cache so itemData for
        // foreign/unresolved URIs survives the undo round-trip.
        const currentHtml = getLatestNoteHtml(item);
        const existingCitationCache = extractDataCitationItems(currentHtml);
        const restoredHtml = rebuildDataCitationItems(resultData.undo_full_html, existingCitationCache);
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteAction: Restored full note content for ${noteId}`, 1);
        await waitForNoteSaveStabilization(item, restoredHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);
        return;
    }

    // ── String replacement undo ──

    if (!old_string) {
        throw new Error('No undo data available: proposed_data.old_string is required');
    }

    const isDeletion = !new_string;

    // 1. Load item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    // 2. Load note data
    await item.loadDataType('note');
    const noteId = `${library_id}-${zotero_key}`;

    // 3. Get current HTML
    const currentHtml = getLatestNoteHtml(item);

    // 4. Strip data-citation-items for matching. Snapshot the cache first so
    //    rebuild can preserve itemData for URIs that don't resolve.
    const existingCitationCache = extractDataCitationItems(currentHtml);
    const strippedHtml = stripDataCitationItems(currentHtml);
    const storedUndoOldHtml = resultData?.undo_old_html;
    const storedUndoNewHtml = resultData?.undo_new_html;

    let expandedOld = storedUndoOldHtml;
    let expandedNew = storedUndoNewHtml;

    if (!expandedOld || (!isDeletion && expandedNew === undefined)) {
        const { metadata } = getOrSimplify(noteId, currentHtml, library_id);
        const externalRefContext = getExternalRefContext();

        try {
            if (!expandedOld) {
                expandedOld = expandToRawHtml(old_string, metadata, 'old');
            }
            if (!isDeletion && expandedNew === undefined) {
                expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext);
            }
        } catch (e: any) {
            throw new Error(`Failed to expand strings for undo: ${e.message || String(e)}`);
        }
    }

    let restoredHtml: string | undefined;

    if (isDeletion) {
        // --- Deletion undo: use surrounding context to find insertion point ---
        let beforeCtx = resultData?.undo_before_context;
        let afterCtx = resultData?.undo_after_context;
        let undoOldHtml = expandedOld!;

        if (beforeCtx === undefined && afterCtx === undefined) {
            throw new Error(
                'Cannot undo deletion: no surrounding context stored in result_data. '
                + 'This action was applied before deletion-undo support was added.'
            );
        }

        // PM may have decoded HTML entities (e.g. &#x27; → ') in the note.
        // If context anchors aren't found as-is, try entity-decoded versions.
        const seamRaw = (beforeCtx || '') + (afterCtx || '');
        if (seamRaw && !strippedHtml.includes(seamRaw)) {
            const decodedBefore = beforeCtx != null ? decodeHtmlEntities(beforeCtx) : undefined;
            const decodedAfter = afterCtx != null ? decodeHtmlEntities(afterCtx) : undefined;
            const seamDecoded = (decodedBefore || '') + (decodedAfter || '');
            if (seamDecoded !== seamRaw && strippedHtml.includes(seamDecoded)) {
                beforeCtx = decodedBefore;
                afterCtx = decodedAfter;
                undoOldHtml = decodeHtmlEntities(undoOldHtml);
            }
        }

        // PM may have changed inter-tag whitespace (indentation, newlines).
        const seamAfterDecode = (beforeCtx || '') + (afterCtx || '');
        if (seamAfterDecode && !strippedHtml.includes(seamAfterDecode)) {
            const beforeWs = beforeCtx ? findWhitespaceTolerant(strippedHtml, beforeCtx) : null;
            const afterWs = afterCtx ? findWhitespaceTolerant(strippedHtml, afterCtx) : null;
            if (beforeWs || afterWs) {
                logger(`undoEditNoteAction: whitespace-tolerant context match for deletion undo on note ${noteId}`, 1);
                if (beforeWs) beforeCtx = strippedHtml.substring(beforeWs.start, beforeWs.end);
                if (afterWs) afterCtx = strippedHtml.substring(afterWs.start, afterWs.end);
                // Also update undoOldHtml whitespace if needed
                const oldWs = findWhitespaceTolerant(strippedHtml, undoOldHtml);
                if (oldWs) undoOldHtml = strippedHtml.substring(oldWs.start, oldWs.end);
            }
        }

        // Check if already undone (old_string is back in the note) — context-aware
        if (isAlreadyUndone(strippedHtml, undoOldHtml, beforeCtx, afterCtx)) {
            logger(`undoEditNoteAction: Note ${noteId} already contains old_string, skipping`, 1);
            return;
        }

        // Locate the deletion seam, tolerating editor-inserted whitespace.
        const seamLoc = locateEditFragment({
            strippedHtml,
            intent: { kind: 'undo-seam', beforeContext: beforeCtx, afterContext: afterCtx },
        });
        if (seamLoc.kind !== 'seam') {
            throw new Error(
                'Cannot undo deletion: the note has been modified around the deletion point. '
                + 'The surrounding context could not be found.'
            );
        }
        logger(`undoEditNoteAction: deletion seam at ${seamLoc.insertionPoint}` +
            (seamLoc.gapEnd !== undefined ? ` (gap=${seamLoc.gapEnd - seamLoc.insertionPoint})` : ''), 1);
        // When the editor inserted whitespace between the two contexts, span
        // the gap so the undo replaces it (gapEnd marks the start of afterCtx).
        const sliceEnd = seamLoc.gapEnd ?? seamLoc.insertionPoint;
        restoredHtml = strippedHtml.substring(0, seamLoc.insertionPoint)
            + undoOldHtml
            + strippedHtml.substring(sliceEnd);
    } else {
        // --- Non-deletion undo: reverse str-replace (new fragment → old fragment) ---
        let undoOldHtml = expandedOld!;
        let undoNewHtml = expandedNew!;

        let beforeCtx = resultData?.undo_before_context;
        let afterCtx = resultData?.undo_after_context;

        // PM may have decoded HTML entities (e.g. &#x27; → ') in the note
        // since the undo data was stored. If the stored new_html isn't found,
        // try entity-decoded versions so all subsequent matching works.
        if (!strippedHtml.includes(undoNewHtml)) {
            const decodedNew = decodeHtmlEntities(undoNewHtml);
            if (decodedNew !== undoNewHtml && strippedHtml.includes(decodedNew)) {
                undoNewHtml = decodedNew;
                undoOldHtml = decodeHtmlEntities(undoOldHtml);
                if (beforeCtx != null) beforeCtx = decodeHtmlEntities(beforeCtx);
                if (afterCtx != null) afterCtx = decodeHtmlEntities(afterCtx);
            }
        }

        // PM may have changed inter-tag whitespace (indentation, newlines)
        // since the undo data was stored. If the exact string still isn't
        // found, try whitespace-tolerant matching and update the undo strings
        // + contexts to use the actual PM-normalized versions.
        if (!strippedHtml.includes(undoNewHtml)) {
            const wsMatch = findWhitespaceTolerant(strippedHtml, undoNewHtml);
            if (wsMatch) {
                logger(`undoEditNoteAction: whitespace-tolerant match for undo_new_html on note ${noteId}`, 1);
                undoNewHtml = strippedHtml.substring(wsMatch.start, wsMatch.end);
                // Also update undoOldHtml if its whitespace differs
                if (!strippedHtml.includes(undoOldHtml)) {
                    const oldWsMatch = findWhitespaceTolerant(strippedHtml, undoOldHtml);
                    if (oldWsMatch) {
                        undoOldHtml = strippedHtml.substring(oldWsMatch.start, oldWsMatch.end);
                    }
                }
                // Refresh context anchors from current HTML
                beforeCtx = strippedHtml.substring(
                    Math.max(0, wsMatch.start - UNDO_CONTEXT_LENGTH),
                    wsMatch.start,
                );
                afterCtx = strippedHtml.substring(
                    wsMatch.end,
                    Math.min(strippedHtml.length, wsMatch.end + UNDO_CONTEXT_LENGTH),
                );
            }
        }

        // 3-way detection — context-aware "already undone" check
        const newStringFound = strippedHtml.includes(undoNewHtml);

        if (!newStringFound && isAlreadyUndone(strippedHtml, undoOldHtml, beforeCtx, afterCtx)) {
            logger(`undoEditNoteAction: Note ${noteId} already contains old_string, skipping`, 1);
            return;
        }

        if (operation === 'str_replace_all') {
            if (!newStringFound) {
                // str_replace_all fuzzy recovery: per-occurrence context anchors
                const occCtxs = resultData?.undo_occurrence_contexts;
                if (occCtxs && occCtxs.length > 0) {
                    restoredHtml = undoReplaceAllViaContexts(
                        strippedHtml, undoOldHtml, undoNewHtml, occCtxs, library_id
                    );
                    if (restoredHtml) {
                        logger(`undoEditNoteAction: restored ${occCtxs.length} replace_all occurrences via contexts on note ${noteId}`, 1);
                    }
                }
                if (!restoredHtml) {
                    throw new Error(
                        'Cannot undo: the note has been modified since this edit was applied. '
                        + 'Neither the applied text nor the original text could be found.'
                    );
                }
            } else {
                // Exact match path — undoNewHtml found verbatim
                restoredHtml = strippedHtml.split(undoNewHtml).join(undoOldHtml);
            }
        } else {
            // Single-occurrence: one orchestrator call handles exact +
            // duplicate disambiguation + fuzzy recovery.
            const fragment = locateEditFragment({
                strippedHtml,
                intent: {
                    kind: 'undo-fragment',
                    expectedHtml: undoNewHtml,
                    beforeContext: beforeCtx,
                    afterContext: afterCtx,
                    libraryId: library_id,
                    allowFuzzy: true,
                },
            });
            if (fragment.kind !== 'range') {
                throw new Error(
                    'Cannot undo: the note has been modified since this edit was applied. '
                    + 'Neither the applied text nor the original text could be found.'
                );
            }
            if (fragment.via !== 'exact') {
                logger(`undoEditNoteAction: restored via ${fragment.via} on note ${noteId}`, 1);
            }
            restoredHtml = strippedHtml.substring(0, fragment.start) + undoOldHtml
                + strippedHtml.substring(fragment.end);
        }
    }

    // Rebuild data-citation-items, preserving the pre-undo itemData so
    // citations to foreign/unresolved URIs don't lose their labels.
    restoredHtml = rebuildDataCitationItems(restoredHtml!, existingCitationCache);

    // Save
    try {
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteAction: Reversed edit on note ${noteId}`, 1);
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
