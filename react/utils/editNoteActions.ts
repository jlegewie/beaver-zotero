/**
 * Utilities for executing and undoing edit_note agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import type { EditNoteResultData, EditNoteOperation } from '../types/agentActions/editNote';
import type {
    EditNoteBatchProposedData,
    EditNoteBatchResultData,
    EditNoteBatchUndoRecord,
    EditNoteBatchEditItem,
} from '../types/agentActions/editNoteBatch';
import { logger } from '../../src/utils/logger';
import {
    libraryRefForLibraryID,
    resolveItemReference,
    resolveLibraryRef,
} from '../../src/utils/libraryIdentity';
import {
    getOrSimplify,
    invalidateSimplificationCache,
    type SimplificationMetadata,
} from '../../src/utils/noteHtmlSimplifier';
import {
    checkDuplicateCitations,
    detectPartialSimplifiedTag,
    buildPartialSimplifiedTagMessage,
} from '../../src/utils/editNoteValidation';
import { findRangeByContexts } from '../../src/utils/editNoteRawPosition';
import {
    preloadPageLabelsForNewCitations,
    preloadNotePageLabels,
    preloadStructuralLocatorPages,
    buildUnresolvedLocatorWarning,
    expandToRawHtml,
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
import { decodeHtmlEntities } from '../../src/utils/noteHtmlEntities';
import {
    expandBase,
    findBestMatch,
    type BaseExpansion,
    type MatchInput,
} from '../../src/utils/editNoteMatcher';
import {
    resolveEditTargetAtRuntime,
    buildExecutionZeroMatchHint,
    locateEditFragment,
    findWhitespaceTolerant,
    normalizeUndoComparisonHtml,
} from '../../src/utils/editNotePositionLookup';
import { clearNoteEditorSelection } from './sourceUtils';
import { store } from '../store';
import { currentThreadIdAtom } from '../atoms/threads';
import { addOrUpdateEditFooter, getBeaverFooterAppendPoint } from '../../src/utils/noteEditFooter';
import { assertNoPreviewMarkers, containsPreviewMarkers, stripPreviewMarkers } from '../../src/utils/notePreviewGuard';
import {
    externalReferenceMappingAtom,
    externalReferenceItemMappingAtom,
} from '../atoms/externalReferences';
import {
    resolveBatchEdits,
    detectOverlaps,
    applyResolvedEdits,
    captureUndoContexts,
    type ResolveBatchContext,
    type ResolvedBatchEdit,
    type BatchEditFailure,
} from '../../src/utils/editNoteBatchCore';
import {
    preloadBatchLabels,
    prepareSpecs,
    checkBatchShape,
    buildAppliedList,
    buildUndoList,
} from '../../src/services/agentDataProvider/actions/editNoteBatch';
import { checkLibraryExcluded } from '../../src/services/agentDataProvider/utils';

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
    // Collect only the ranges identified by this action's recorded contexts.
    // The note may contain the same replacement HTML outside those ranges.
    const ranges: Array<{ start: number; end: number }> = [];
    const rangeKeys = new Set<string>();

    for (const ctx of occurrenceContexts) {
        const range = findRangeByContexts(strippedHtml, ctx.before, ctx.after, undoNewHtml.length);
        if (!range) return undefined; // Context not found — bail out

        // Verify the region is either the applied fragment or the already-
        // restored original fragment. This keeps retry idempotency scoped to
        // the same recorded occurrence instead of a bare document-wide match.
        const regionHtml = strippedHtml.substring(range.start, range.end);
        const normalizedRegion = normalizeUndoComparisonHtml(regionHtml, libraryId);
        const normalizedNew = normalizeUndoComparisonHtml(undoNewHtml, libraryId);
        const normalizedOld = normalizeUndoComparisonHtml(undoOldHtml, libraryId);
        const rangeKey = `${range.start}:${range.end}`;
        if (rangeKeys.has(rangeKey)) return undefined;
        rangeKeys.add(rangeKey);
        if (regionHtml === undoOldHtml || normalizedRegion === normalizedOld) {
            continue;
        }
        if (regionHtml !== undoNewHtml && normalizedRegion !== normalizedNew) return undefined;

        ranges.push(range);
    }

    // Every recorded occurrence was already restored.
    if (ranges.length === 0) return strippedHtml;

    // Sort ranges from last to first so replacements don't shift earlier indices
    ranges.sort((a, b) => b.start - a.start);

    let result = strippedHtml;
    for (const range of ranges) {
        result = result.substring(0, range.start) + undoOldHtml + result.substring(range.end);
    }
    return result;
}

/** Reject a local batch mutation before any item lookup crosses the boundary. */
function assertBatchLibraryNotExcluded(
    ref: { library_id?: number | null; library_ref?: string | null },
): void {
    const libraryId = resolveLibraryRef(ref);
    if (libraryId === null) return;
    const exclusion = checkLibraryExcluded(libraryId);
    if (exclusion) throw new Error(exclusion.message);
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

/** Combine optional warning strings into a `warnings` array, or undefined when empty. */
function collectWarnings(...warnings: Array<string | null | undefined>): string[] | undefined {
    const filtered = warnings.filter((w): w is string => !!w);
    return filtered.length > 0 ? filtered : undefined;
}

/**
 * Execute an edit_note agent action by applying string replacement on the note.
 * @param action The agent action to execute
 * @returns Result data including the exact applied HTML fragment for undo
 */
export async function executeEditNoteAction(
    action: AgentAction
): Promise<EditNoteResultData> {
    const {
        library_id: requestedLibraryId,
        library_ref,
        zotero_key,
        old_string,
        new_string,
        operation: rawOp,
    } = action.proposed_data as {
        library_id: number;
        library_ref?: string;
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

    // 2. Load note data
    await item.loadDataType('note');

    // 2b. Promote any unsaved editor content into the DB so this apply sees
    //     the same HTML validation saw. See flushLiveEditorToDB for rationale.
    await flushLiveEditorToDB(item);

    // 2c. Repair notes that contain persisted diff-preview markup, mirroring
    //     the agent execute path.
    {
        const persistedHtml: string = item.getNote();
        if (containsPreviewMarkers(persistedHtml)) {
            const repaired = stripPreviewMarkers(persistedHtml);
            if (!containsPreviewMarkers(repaired)) {
                logger(`executeEditNoteAction: repairing persisted diff-preview markup in ${library_id}-${zotero_key}`, 1);
                item.setNote(repaired);
                await item.saveTx();
                await waitForNoteSaveStabilization(item, repaired);
            } else {
                logger(`executeEditNoteAction: diff-preview markup in ${library_id}-${zotero_key} could not be fully stripped; save will be refused by the preview guard`, 1);
            }
        }
    }

    // 3. Get current note HTML
    const oldHtml: string = item.getNote();

    // 4. Get metadata from cache or re-simplify
    const noteId = `${library_id}-${zotero_key}`;
    const pageLabelsByItemId = await preloadNotePageLabels(oldHtml, library_id);
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id, pageLabelsByItemId);

    // 5. Pre-load page labels so new citations resolve page indices to labels.
    //    The resolved map is threaded explicitly into every expandToRawHtml
    //    call below so expansion stays synchronous.
    const newPageLabels = await preloadPageLabelsForNewCitations(new_string);
    // 5b. Resolve structural (non-page) locators in new_string to their page so
    //     citations keep a page locator instead of dropping it on save.
    const structuralLocators = await preloadStructuralLocatorPages(new_string);
    const resolvedLocatorPages = structuralLocators.pages;
    const locatorWarning = buildUnresolvedLocatorWarning(structuralLocators.unresolved);

    // Snapshot external-reference state once so every expandToRawHtml('new', ...)
    // below can resolve `<citation external_id="..."/>` consistently.
    const externalRefContext = getExternalRefContext();

    // ── rewrite mode: replace entire note body ──
    if (operation === 'rewrite') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext, newPageLabels, resolvedLocatorPages);
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
            assertNoPreviewMarkers(newHtml, 'editNoteActions:rewrite:apply');
            item.setNote(newHtml);
            await item.saveTx();
            logger(`executeEditNoteAction: Saved rewrite edit to ${noteId}`, 1);
        } catch (error) {
            try {
                assertNoPreviewMarkers(oldHtml, 'editNoteActions:rewrite:rollback');
                item.setNote(oldHtml);
            } catch (_) { /* best-effort */ }
            throw new Error(`Failed to save note: ${error}`);
        }

        await waitForNoteSaveStabilization(item, newHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);

        const duplicateWarning = checkDuplicateCitations(new_string, metadata);
        const warnings = collectWarnings(duplicateWarning, locatorWarning);

        return {
            library_id,
            zotero_key,
            library_ref: libraryRefForLibraryID(library_id) ?? undefined,
            occurrences_replaced: 1,
            warnings,
            undo_full_html: strippedHtml,
        };
    }

    // ── append mode: add new_string to the end of the note body ──
    if (operation === 'append') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext, newPageLabels, resolvedLocatorPages);
        } catch (e: any) {
            throw new Error(e.message || String(e));
        }

        const existingCitationCache = extractDataCitationItems(oldHtml);
        const strippedHtml = stripDataCitationItems(oldHtml);

        const insertAt = getBeaverFooterAppendPoint(strippedHtml);
        let undoBeforeContext = strippedHtml.substring(Math.max(0, insertAt - UNDO_CONTEXT_LENGTH), insertAt);
        let undoAfterContext = strippedHtml.substring(insertAt, insertAt + UNDO_CONTEXT_LENGTH);
        let newHtml = strippedHtml.slice(0, insertAt) + expandedNew + strippedHtml.slice(insertAt);

        const threadId = store.get(currentThreadIdAtom);
        if (threadId) {
            newHtml = addOrUpdateEditFooter(newHtml, threadId);
        }

        newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

        const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
        if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
            throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
        }

        const postEditStripped = stripDataCitationItems(newHtml);
        undoBeforeContext = postEditStripped.substring(
            Math.max(0, insertAt - UNDO_CONTEXT_LENGTH),
            insertAt,
        );
        undoAfterContext = postEditStripped.substring(
            insertAt + expandedNew.length,
            insertAt + expandedNew.length + UNDO_CONTEXT_LENGTH,
        );

        try {
            assertNoPreviewMarkers(newHtml, 'editNoteActions:append:apply');
            item.setNote(newHtml);
            await item.saveTx();
            logger(`executeEditNoteAction: Saved append edit to ${noteId}`, 1);
        } catch (error) {
            try {
                assertNoPreviewMarkers(oldHtml, 'editNoteActions:append:rollback');
                item.setNote(oldHtml);
            } catch (_) { /* best-effort */ }
            throw new Error(`Failed to save note: ${error}`);
        }

        await waitForNoteSaveStabilization(item, newHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);

        const duplicateWarning = checkDuplicateCitations(new_string, metadata);
        const warnings = collectWarnings(duplicateWarning, locatorWarning);

        const result: EditNoteResultData = {
            library_id,
            zotero_key,
            library_ref: libraryRefForLibraryID(library_id) ?? undefined,
            occurrences_replaced: 1,
            warnings,
            undo_old_html: '',
            undo_new_html: expandedNew,
            undo_before_context: undoBeforeContext,
            undo_after_context: undoAfterContext,
        };

        const savedStrippedHtml = stripDataCitationItems(newHtml);
        await waitForPMNormalization(item, savedStrippedHtml, result, strippedHtml);

        return result;
    }

    // ── String replacement mode (default) ──

    // 6. Strip data-citation-items from raw HTML for matching.
    //    Snapshot the cache first so rebuild can preserve itemData for
    //    URIs that don't resolve in the current library.
    const existingCitationCache = extractDataCitationItems(oldHtml);
    const strippedHtml = stripDataCitationItems(oldHtml);

    // 7. Run the ranked matcher (same chain the validator and WS executor use).
    //    Defense-in-depth: validator normally normalizes via normalized_action_data,
    //    but the note may have drifted between validation and execution
    //    (PM re-normalization, concurrent edit) so we re-match here against
    //    the current HTML.
    const matchInput: MatchInput = {
        oldString: old_string ?? '',
        newString: new_string,
        operation,
        metadata,
        simplified,
        strippedHtml,
        externalRefContext,
        pageLabels: newPageLabels,
        resolvedLocatorPages,
    };
    let base: BaseExpansion;
    try {
        base = expandBase(matchInput);
    } catch (e: any) {
        const err = new Error(e.message || String(e));
        (err as any).code = 'expansion_failed';
        throw err;
    }

    const match = findBestMatch(matchInput, base);
    if (!match) {
        // Defense-in-depth: same partial-tag check as the WS executor
        // (editNote.ts:836-847) — the executor may receive un-normalized
        // action_data on stale paths.
        const partial = detectPartialSimplifiedTag(old_string ?? '');
        if (partial) {
            const err = new Error(buildPartialSimplifiedTagMessage(partial));
            (err as any).code = 'partial_simplified_tag';
            throw err;
        }
        const hint = buildExecutionZeroMatchHint(simplified, old_string ?? '');
        const err = new Error(hint.message);
        (err as any).code = 'old_string_not_found';
        if (hint.candidates.length > 0) (err as any).candidates = hint.candidates;
        throw err;
    }

    // 7a. Transform validator-supplied context anchors the same way the
    //     matcher transformed the haystack needle (entity decode/encode, NFKC).
    //     Mutation-style strategies use identity, so this is a no-op for them.
    if (target_before_context != null) target_before_context = match.normalizeAnchor(target_before_context);
    if (target_after_context != null) target_after_context = match.normalizeAnchor(target_after_context);

    const expandedOld = match.expandedOld;
    const expandedNew = match.expandedNew;
    const matchCount = match.matchCount;

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
        assertNoPreviewMarkers(newHtml, 'editNoteActions:strReplace:apply');
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteAction: Saved note edit to ${noteId} (${replacementCount} occurrence(s) replaced)`, 1);
    } catch (error) {
        // Restore in-memory state on save failure
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteActions:strReplace:rollback');
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
    const warnings = collectWarnings(duplicateWarning, locatorWarning);

    const result: EditNoteResultData = {
        library_id,
        zotero_key,
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
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
    const { library_id: requestedLibraryId, library_ref, zotero_key, old_string, new_string, operation: rawOp } = action.proposed_data as {
        library_id: number;
        library_ref?: string;
        zotero_key: string;
        old_string?: string;
        new_string: string;
        operation?: EditNoteOperation;
    };
    const operation: EditNoteOperation = rawOp ?? 'str_replace';

    const resultData = action.result_data as EditNoteResultData | undefined;

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

    // ── rewrite undo: restore full note from undo_full_html ──
    if (resultData?.undo_full_html) {
        await item.loadDataType('note');
        const noteId = `${library_id}-${zotero_key}`;

        // Seed the rebuild with the current note's cache so itemData for
        // foreign/unresolved URIs survives the undo round-trip.
        const currentHtml = getLatestNoteHtml(item);
        const existingCitationCache = extractDataCitationItems(currentHtml);
        const restoredHtml = rebuildDataCitationItems(resultData.undo_full_html, existingCitationCache);
        assertNoPreviewMarkers(restoredHtml, 'editNoteActions:undoRewrite');
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteAction: Restored full note content for ${noteId}`, 1);
        await waitForNoteSaveStabilization(item, restoredHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);
        return;
    }

    // ── String replacement undo ──

    if (!old_string && operation !== 'append') {
        throw new Error('No undo data available: proposed_data.old_string is required');
    }

    const isDeletion = !new_string;

    // 1. Load note data (item resolved above via library_ref with fallback)
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

    if (expandedOld === undefined || (!isDeletion && expandedNew === undefined)) {
        const pageLabelsByItemId = await preloadNotePageLabels(currentHtml, library_id);
        const { metadata } = getOrSimplify(noteId, currentHtml, library_id, pageLabelsByItemId);
        const externalRefContext = getExternalRefContext();
        // Resolve page labels for new_string citations so the fallback
        // expansion translates 1-based page numbers the same way the
        // original execute did.
        const undoPageLabels = isDeletion
            ? {}
            : await preloadPageLabelsForNewCitations(new_string);

        try {
            if (expandedOld === undefined) {
                expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
            }
            if (!isDeletion && expandedNew === undefined) {
                expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext, undoPageLabels);
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
        assertNoPreviewMarkers(restoredHtml, 'editNoteActions:undoStrReplace');
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

// =============================================================================
// Batch variants (edit_note_batch): one action, ordered edits, one save
// =============================================================================

/** Build the thrown Error for a batch that failed the pre-check re-validation pass. */
function buildPrepFailureError(failures: BatchEditFailure[]): Error {
    const first = failures[0];
    return new Error(
        `Batch cannot be applied: ${failures.length} edit(s) failed re-validation `
        + `(edit ${first.index}: ${first.error})`
    );
}

/** Build the thrown Error for a batch whose edits no longer resolve against the current note. */
function buildResolveFailureError(failures: BatchEditFailure[]): Error {
    const first = failures[0];
    return new Error(
        `Batch cannot be applied: ${failures.length} edit(s) no longer resolve against the current note `
        + `(edit ${first.index}: ${first.error})`
    );
}

/**
 * Apply a single-rewrite batch using the same wrapper-preserving semantics as
 * the single-edit rewrite path (see the `operation === 'rewrite'` branch of
 * `executeEditNoteAction` above), wrapped in the batch result envelope. The
 * undo record carries the FULL pre-edit stripped body in `undo_old_html`.
 */
async function executeBatchSingleRewrite(
    item: Zotero.Item,
    edit: EditNoteBatchEditItem,
    library_id: number,
    zotero_key: string,
    oldHtml: string,
    strippedHtml: string,
    existingCitationCache: ReturnType<typeof extractDataCitationItems>,
    metadata: SimplificationMetadata,
    externalRefContext: ExternalRefContext,
    threadId: string | null,
    noteId: string,
): Promise<EditNoteBatchResultData> {
    const newPageLabels = await preloadPageLabelsForNewCitations(edit.new_string);
    const structuralLocators = await preloadStructuralLocatorPages(edit.new_string);
    const resolvedLocatorPages = structuralLocators.pages;
    const locatorWarning = buildUnresolvedLocatorWarning(structuralLocators.unresolved);

    let expandedNew: string;
    try {
        expandedNew = expandToRawHtml(edit.new_string, metadata, 'new', externalRefContext, newPageLabels, resolvedLocatorPages);
    } catch (e: any) {
        throw new Error(e.message || String(e));
    }

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
    if (threadId) {
        newHtml = addOrUpdateEditFooter(newHtml, threadId);
    }
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
    }

    try {
        assertNoPreviewMarkers(newHtml, 'editNoteActions:batch:rewrite:apply');
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteBatchAction: Saved rewrite edit to ${noteId}`, 1);
    } catch (error) {
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteActions:batch:rewrite:rollback');
            item.setNote(oldHtml);
        } catch (_) { /* best-effort */ }
        throw new Error(`Failed to save note: ${error}`);
    }

    await waitForNoteSaveStabilization(item, newHtml);
    clearNoteEditorSelection(library_id, zotero_key);
    invalidateSimplificationCache(noteId);

    const duplicateWarning = checkDuplicateCitations(edit.new_string, metadata);
    const warnings = collectWarnings(duplicateWarning, locatorWarning);

    return {
        library_id,
        zotero_key,
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
        applied: [{
            index: edit.index,
            client_item_id: edit.client_item_id,
            occurrences_replaced: 1,
        }],
        ...(warnings ? { warnings } : {}),
        undo: [{
            index: edit.index,
            client_item_id: edit.client_item_id,
            operation: 'rewrite',
            undo_old_html: strippedHtml,
        }],
    };
}

/**
 * Apply an edit_note_batch action: resolve every edit against one snapshot of
 * the note, verify no ranges overlap, splice in descending offset order, and
 * persist with a single save. All-or-nothing — throws without writing when any
 * edit fails to resolve or two edits conflict.
 *
 * This is the UI-initiated re-apply path (user clicks Apply/Retry on a pending
 * or errored batch action). It mirrors `executeEditNoteAction`'s guard
 * sequence above but delegates resolution/overlap/apply to the shared
 * `editNoteBatchCore`, reusing the same pre-check/preload helpers the WS
 * executor uses (`prepareSpecs`, `preloadBatchLabels`) for defense-in-depth
 * re-validation against a note that may have drifted since approval.
 */
export async function executeEditNoteBatchAction(
    action: AgentAction,
): Promise<EditNoteBatchResultData> {
    const {
        library_id: requestedLibraryId,
        library_ref,
        zotero_key,
        edits,
    } = action.proposed_data as EditNoteBatchProposedData;

    const shapeError = checkBatchShape(edits);
    if (shapeError) {
        throw new Error(shapeError.error);
    }

    // Library exclusions can change after validation/action creation. Enforce
    // the boundary again before resolving or loading the note.
    assertBatchLibraryNotExcluded({
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

    // 2c. Repair notes that contain persisted diff-preview markup, mirroring
    //     the agent execute path.
    {
        const persistedHtml: string = item.getNote();
        if (containsPreviewMarkers(persistedHtml)) {
            const repaired = stripPreviewMarkers(persistedHtml);
            if (!containsPreviewMarkers(repaired)) {
                logger(`executeEditNoteBatchAction: repairing persisted diff-preview markup in ${library_id}-${zotero_key}`, 1);
                item.setNote(repaired);
                await item.saveTx();
                await waitForNoteSaveStabilization(item, repaired);
            } else {
                logger(`executeEditNoteBatchAction: diff-preview markup in ${library_id}-${zotero_key} could not be fully stripped; save will be refused by the preview guard`, 1);
            }
        }
    }

    // 3. Snapshot the note once. Every edit resolves against this snapshot.
    const oldHtml: string = item.getNote();
    const noteId = `${library_id}-${zotero_key}`;
    const pageLabelsByItemId = await preloadNotePageLabels(oldHtml, library_id);
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id, pageLabelsByItemId);
    const externalRefContext = getExternalRefContext();

    const existingCitationCache = extractDataCitationItems(oldHtml);
    const strippedHtml = stripDataCitationItems(oldHtml);

    const threadId = store.get(currentThreadIdAtom);

    // ── Single-rewrite batch: same wrapper-preserving semantics as v1's
    //    rewrite branch, wrapped in the batch result envelope. ──
    if (edits.length === 1 && (edits[0].operation ?? 'str_replace') === 'rewrite') {
        return await executeBatchSingleRewrite(
            item, edits[0], library_id, zotero_key, oldHtml, strippedHtml,
            existingCitationCache, metadata, externalRefContext, threadId, noteId,
        );
    }

    // ── General batch ──

    // 4. Preload page labels + structural locators for every edit, then run
    //    the same no-op/precheck/enrichment/Markdown-fallback pass the WS
    //    executor runs before resolution.
    const labels = await preloadBatchLabels(edits);
    const { specs, failures: prepFailures } = await prepareSpecs(
        edits, metadata, externalRefContext, labels, library_id,
    );
    if (prepFailures.length > 0) {
        throw buildPrepFailureError(prepFailures);
    }

    const appendPoint = getBeaverFooterAppendPoint(strippedHtml);
    const resolveCtx: ResolveBatchContext = {
        strippedHtml, simplified, metadata, externalRefContext,
        pageLabels: labels.pageLabels,
        resolvedLocatorPages: labels.resolvedLocatorPages,
        appendPoint,
        mode: 'execute',
    };
    const { resolved: resolvedEdits, failures: resolveFailures } = resolveBatchEdits(resolveCtx, specs);
    if (resolveFailures.length > 0) {
        throw buildResolveFailureError(resolveFailures);
    }

    const overlaps = detectOverlaps(resolvedEdits);
    if (overlaps.length > 0) {
        const o = overlaps[0];
        throw new Error(
            `Batch cannot be applied: edits ${o.firstIndex} and ${o.secondIndex} now target overlapping `
            + 'regions of the note.'
        );
    }

    // 5. Apply ALL edits in one pass, footer + citation-item rebuild ONCE.
    const { newStrippedHtml, undoDrafts } = applyResolvedEdits(strippedHtml, resolvedEdits);

    let newHtml = newStrippedHtml;
    if (threadId) {
        newHtml = addOrUpdateEditFooter(newHtml, threadId);
    }
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
    }

    // 6. Save ONCE.
    try {
        assertNoPreviewMarkers(newHtml, 'editNoteActions:batch:apply');
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteBatchAction: Saved ${resolvedEdits.length} edit(s) to ${noteId}`, 1);
    } catch (error) {
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteActions:batch:rollback');
            item.setNote(oldHtml);
        } catch (_) { /* best-effort */ }
        throw new Error(`Failed to save note: ${error}`);
    }

    await waitForNoteSaveStabilization(item, newHtml);
    clearNoteEditorSelection(library_id, zotero_key);
    invalidateSimplificationCache(noteId);

    // 7. Refresh undo contexts against the final (post-footer, PM-normalized) HTML.
    const finalStripped = stripDataCitationItems(getLatestNoteHtml(item));
    captureUndoContexts(finalStripped, undoDrafts);

    // 8. Warnings: per-edit duplicate-citation + batch locator warnings.
    const warnings: string[] = [...labels.locatorWarnings];
    for (const edit of edits) {
        const dup = checkDuplicateCitations(edit.new_string, metadata);
        if (dup) warnings.push(dup);
    }

    const applied = buildAppliedList(resolvedEdits);
    const undo = buildUndoList(undoDrafts);

    return {
        library_id,
        zotero_key,
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
        applied,
        ...(warnings.length > 0 ? { warnings } : {}),
        undo,
    };
}

/**
 * Replay one `EditNoteBatchUndoRecord` against `strippedHtml`, returning the
 * updated HTML. Returns `strippedHtml` unchanged when the record is already
 * undone (idempotent retry). Throws when the recorded fragment/context can no
 * longer be located by any fallback.
 *
 * Dispatch (derived purely from the record's own fields, no proposed_data
 * needed):
 *   - `operation === 'rewrite'`        → unconditionally restore the full
 *                                        pre-edit body from `undo_old_html`.
 *   - `undo_occurrence_contexts` set   → str_replace_all: per-occurrence
 *                                        replay via `undoReplaceAllViaContexts`.
 *   - `undo_new_html === ''`           → the edit deleted content (str_replace
 *                                        with an empty new_string): locate the
 *                                        seam via before/after context and
 *                                        reinsert `undo_old_html`.
 *   - otherwise                        → str_replace / insert_after /
 *                                        insert_before / append: locate
 *                                        `undo_new_html` (exact → entity-decode
 *                                        → whitespace-tolerant → context/fuzzy)
 *                                        and replace it with `undo_old_html`
 *                                        (empty for insert/append, restoring
 *                                        to "nothing was there").
 */
function applyBatchUndoRecord(
    strippedHtml: string,
    record: EditNoteBatchUndoRecord,
    libraryId: number,
): string {
    const operation = record.operation ?? 'str_replace';
    const undoOldHtml = record.undo_old_html ?? '';
    const undoNewHtml = record.undo_new_html ?? '';

    // ── rewrite: unconditionally restore the full pre-edit body ──
    if (operation === 'rewrite') {
        return undoOldHtml;
    }

    // ── str_replace_all: per-occurrence context replay ──
    if (record.undo_occurrence_contexts !== undefined) {
        const occCtxs = record.undo_occurrence_contexts;
        if (occCtxs.length === 0) {
            throw new Error(`Cannot undo edit ${record.index}: no occurrence context data recorded for a str_replace_all edit.`);
        }
        // Always replay through the per-occurrence anchors. A document-wide
        // split/join would also rewrite matching text that this action never
        // touched (including text added by the user after application).
        const restored = undoReplaceAllViaContexts(
            strippedHtml, undoOldHtml, undoNewHtml, [...occCtxs].reverse(), libraryId,
        );
        if (!restored) {
            throw new Error(
                `Cannot undo edit ${record.index}: the note has been modified since this edit was applied. `
                + 'Neither the applied text nor the original text could be found.'
            );
        }
        if (restored === strippedHtml) {
            logger(`undoEditNoteBatchAction: edit ${record.index} already undone, skipping`, 1);
            return strippedHtml;
        }
        logger(`undoEditNoteBatchAction: restored ${occCtxs.length} replace_all occurrence(s) via contexts for edit ${record.index}`, 1);
        return restored;
    }

    // ── deletion (undo_new_html empty): locate the seam via context and reinsert undo_old_html ──
    if (undoNewHtml === '') {
        let beforeCtx = record.undo_before_context;
        let afterCtx = record.undo_after_context;
        let restoreHtml = undoOldHtml;

        if (beforeCtx === undefined && afterCtx === undefined) {
            throw new Error(`Cannot undo edit ${record.index}: no surrounding context stored for this deletion.`);
        }

        // PM may have decoded HTML entities (e.g. &#x27; → ') since the undo
        // data was stored. Try entity-decoded versions if the raw seam isn't found.
        const seamRaw = (beforeCtx || '') + (afterCtx || '');
        if (seamRaw && !strippedHtml.includes(seamRaw)) {
            const decodedBefore = beforeCtx != null ? decodeHtmlEntities(beforeCtx) : undefined;
            const decodedAfter = afterCtx != null ? decodeHtmlEntities(afterCtx) : undefined;
            const seamDecoded = (decodedBefore || '') + (decodedAfter || '');
            if (seamDecoded !== seamRaw && strippedHtml.includes(seamDecoded)) {
                beforeCtx = decodedBefore;
                afterCtx = decodedAfter;
                restoreHtml = decodeHtmlEntities(restoreHtml);
            }
        }

        // PM may have changed inter-tag whitespace (indentation, newlines).
        const seamAfterDecode = (beforeCtx || '') + (afterCtx || '');
        if (seamAfterDecode && !strippedHtml.includes(seamAfterDecode)) {
            const beforeWs = beforeCtx ? findWhitespaceTolerant(strippedHtml, beforeCtx) : null;
            const afterWs = afterCtx ? findWhitespaceTolerant(strippedHtml, afterCtx) : null;
            if (beforeWs || afterWs) {
                logger(`undoEditNoteBatchAction: whitespace-tolerant context match for edit ${record.index} deletion undo`, 1);
                if (beforeWs) beforeCtx = strippedHtml.substring(beforeWs.start, beforeWs.end);
                if (afterWs) afterCtx = strippedHtml.substring(afterWs.start, afterWs.end);
                const oldWs = findWhitespaceTolerant(strippedHtml, restoreHtml);
                if (oldWs) restoreHtml = strippedHtml.substring(oldWs.start, oldWs.end);
            }
        }

        if (isAlreadyUndone(strippedHtml, restoreHtml, beforeCtx, afterCtx)) {
            logger(`undoEditNoteBatchAction: edit ${record.index} already undone, skipping`, 1);
            return strippedHtml;
        }

        const seamLoc = locateEditFragment({
            strippedHtml,
            intent: { kind: 'undo-seam', beforeContext: beforeCtx, afterContext: afterCtx },
        });
        if (seamLoc.kind !== 'seam') {
            throw new Error(
                `Cannot undo edit ${record.index}: the note has been modified around the deletion point. `
                + 'The surrounding context could not be found.'
            );
        }
        logger(`undoEditNoteBatchAction: edit ${record.index} deletion seam at ${seamLoc.insertionPoint}`
            + (seamLoc.gapEnd !== undefined ? ` (gap=${seamLoc.gapEnd - seamLoc.insertionPoint})` : ''), 1);
        const sliceEnd = seamLoc.gapEnd ?? seamLoc.insertionPoint;
        return strippedHtml.substring(0, seamLoc.insertionPoint) + restoreHtml + strippedHtml.substring(sliceEnd);
    }

    // ── general case (str_replace / insert_after / insert_before / append):
    //    locate undo_new_html and restore undo_old_html in its place ──
    let undoOldHtmlLocal = undoOldHtml;
    let undoNewHtmlLocal = undoNewHtml;
    let beforeCtx = record.undo_before_context;
    let afterCtx = record.undo_after_context;

    if (!strippedHtml.includes(undoNewHtmlLocal)) {
        const decodedNew = decodeHtmlEntities(undoNewHtmlLocal);
        if (decodedNew !== undoNewHtmlLocal && strippedHtml.includes(decodedNew)) {
            undoNewHtmlLocal = decodedNew;
            undoOldHtmlLocal = decodeHtmlEntities(undoOldHtmlLocal);
            if (beforeCtx != null) beforeCtx = decodeHtmlEntities(beforeCtx);
            if (afterCtx != null) afterCtx = decodeHtmlEntities(afterCtx);
        }
    }

    if (!strippedHtml.includes(undoNewHtmlLocal)) {
        const wsMatch = findWhitespaceTolerant(strippedHtml, undoNewHtmlLocal);
        if (wsMatch) {
            logger(`undoEditNoteBatchAction: whitespace-tolerant match for edit ${record.index}`, 1);
            undoNewHtmlLocal = strippedHtml.substring(wsMatch.start, wsMatch.end);
            if (!strippedHtml.includes(undoOldHtmlLocal)) {
                const oldWsMatch = findWhitespaceTolerant(strippedHtml, undoOldHtmlLocal);
                if (oldWsMatch) undoOldHtmlLocal = strippedHtml.substring(oldWsMatch.start, oldWsMatch.end);
            }
            beforeCtx = strippedHtml.substring(Math.max(0, wsMatch.start - UNDO_CONTEXT_LENGTH), wsMatch.start);
            afterCtx = strippedHtml.substring(wsMatch.end, Math.min(strippedHtml.length, wsMatch.end + UNDO_CONTEXT_LENGTH));
        }
    }

    const newStringFound = strippedHtml.includes(undoNewHtmlLocal);
    if (!newStringFound && isAlreadyUndone(strippedHtml, undoOldHtmlLocal, beforeCtx, afterCtx)) {
        logger(`undoEditNoteBatchAction: edit ${record.index} already undone, skipping`, 1);
        return strippedHtml;
    }

    const fragment = locateEditFragment({
        strippedHtml,
        intent: {
            kind: 'undo-fragment',
            expectedHtml: undoNewHtmlLocal,
            beforeContext: beforeCtx,
            afterContext: afterCtx,
            libraryId,
            allowFuzzy: true,
        },
    });
    if (fragment.kind !== 'range') {
        throw new Error(
            `Cannot undo edit ${record.index}: the note has been modified since this edit was applied. `
            + 'Neither the applied text nor the original text could be found.'
        );
    }
    if (fragment.via !== 'exact') {
        logger(`undoEditNoteBatchAction: edit ${record.index} restored via ${fragment.via}`, 1);
    }
    return strippedHtml.substring(0, fragment.start) + undoOldHtmlLocal + strippedHtml.substring(fragment.end);
}

/**
 * Undo an applied edit_note_batch action by replaying its per-edit undo
 * records in reverse order through the shared relocation machinery. A batch
 * whose sole edit was a rewrite restores the full pre-edit body from
 * undo_old_html.
 *
 * The fully-restored HTML is built in memory first (replaying every record
 * against the evolving stripped HTML) and saved ONCE at the end — a record
 * that cannot be located throws before anything is written.
 */
export async function undoEditNoteBatchAction(action: AgentAction): Promise<void> {
    const {
        library_id: requestedLibraryId,
        library_ref,
        zotero_key,
    } = action.proposed_data as EditNoteBatchProposedData;

    const resultData = action.result_data as EditNoteBatchResultData | undefined;
    const undoRecords = resultData?.undo;
    if (!undoRecords || undoRecords.length === 0) {
        throw new Error('No undo data available: result_data.undo is empty or missing');
    }

    // Undo is a fresh mutation and must respect exclusions that changed after
    // the action was originally applied. Check before resolving/loading.
    assertBatchLibraryNotExcluded({
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
    for (const record of [...undoRecords].reverse()) {
        strippedHtml = applyBatchUndoRecord(strippedHtml, record, library_id);
    }

    // Rebuild data-citation-items, preserving the pre-undo itemData so
    // citations to foreign/unresolved URIs don't lose their labels.
    const restoredHtml = rebuildDataCitationItems(strippedHtml, existingCitationCache);

    try {
        assertNoPreviewMarkers(restoredHtml, 'editNoteActions:undoBatch');
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteBatchAction: Reversed ${undoRecords.length} edit(s) on note ${noteId}`, 1);
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
