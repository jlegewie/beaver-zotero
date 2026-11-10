import type { OperationContext } from '../agentDataProvider/operationContext';
import { dismissNotePreviews } from '../notePreviews';
import { sha256Hex } from '../../utils/hash';
import { ManualApplyOptions, staleProposalError } from './staleProposal';
/**
 * Utilities for executing and undoing edit_note agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type { EditNoteBaseline, EditNoteOperation, EditNoteProposedData, EditNoteResultData } from '@beaver/agent-core/types/agentActions/editNote';
import type {
    EditNoteBatchProposedData,
    EditNoteBatchResultData,
    EditNoteBatchUndoRecord,
} from '@beaver/agent-core/types/agentActions/editNoteBatch';
import {
    findWhitespaceTolerant,
    locateEditFragment,
    normalizeUndoComparisonHtml,
} from '../../utils/editNotePositionLookup';
import { findRangeByContexts } from '../../utils/editNoteRawPosition';
import {
    resolveItemReference,
} from '../../utils/libraryIdentity';
import {
    expandToRawHtml,
    preloadNotePageLabels,
    preloadPageLabelsForNewCitations,
} from '../../utils/noteCitationExpand';
import {
    clearNoteEditorSelection,
    getLatestNoteHtml,
    waitForNoteSaveStabilization,
} from '../../utils/noteEditorIO';
import { decodeHtmlEntities } from '../../utils/noteHtmlEntities';
import {
    getOrSimplify,
    invalidateSimplificationCache,
} from '../../utils/noteHtmlSimplifier';
import { assertNoPreviewMarkers } from '../../utils/notePreviewGuard';
import {
    extractDataCitationItems,
    rebuildDataCitationItems,
    stripDataCitationItems,
} from '../../utils/noteWrapper';
import { assertLibraryRefNotExcluded, unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyEditNote, getExternalRefContext } from '../agentDataProvider/actions/editNote';
import { applyEditNoteBatch } from '../agentDataProvider/actions/editNoteBatch';

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

/**
 * Undo a batch str_replace_all edit by replaying its occurrence anchors one
 * at a time against the CURRENT evolving string, rather than resolving every
 * occurrence's range up front against the original HTML. Each occurrence's
 * before/after context is captured (see `applyResolvedEdits` /
 * `captureUndoContexts` in `src/utils/editNoteBatchCore.ts`) against the
 * document state at the exact point in replay where that occurrence reverts —
 * every occurrence LATER in `occurrenceContextsDescending` is still applied,
 * every occurrence EARLIER has already been reverted. Locating fresh after
 * each splice keeps the remaining anchors valid even when occurrences sit
 * back-to-back: reverting one seam separates it from the next, so contiguous
 * zero-width deletions resolve to distinct positions step by step instead of
 * collapsing onto one ambiguous point.
 *
 * Two occurrences whose before/after windows are byte-identical (a repeated
 * template section) can make `findRangeByContexts` resolve BOTH contexts to
 * the same match — the first pass consumes that position (whether it splices
 * an applied fragment back to `undoOldHtml`, or finds the region already
 * restored and skips it), and without a guard the second context would
 * resolve onto that same range and be silently treated as an independent
 * "already restored" retry while the real target occurrence stays untouched.
 * To catch this, EVERY range a context resolves onto this run — spliced or
 * skipped — is tracked in `consumedRanges` (in the CURRENT `result` string's
 * coordinates, shifted after each subsequent splice) and a later context that
 * resolves onto one of them fails loud instead of being treated as another
 * legitimate skip. A genuine retry (e.g. undo invoked twice against an
 * already fully-restored document) never triggers this: each context then
 * resolves onto its own distinct already-restored range, so nothing overlaps.
 *
 * `occurrenceContextsDescending` must already be in descending document-
 * position order (highest offset first) — callers pass the stored
 * (ascending) array reversed. Returns the updated HTML, or `undefined` if any
 * occurrence's context can no longer be located, its region matches neither
 * the applied fragment nor the original one, or it resolves onto a range
 * this run already consumed.
 */
export function undoBatchReplaceAllViaContexts(
    strippedHtml: string,
    undoOldHtml: string,
    undoNewHtml: string,
    occurrenceContextsDescending: Array<{ before: string; after: string }>,
    libraryId: number
): string | undefined {
    const normalizedNew = normalizeUndoComparisonHtml(undoNewHtml, libraryId);
    const normalizedOld = normalizeUndoComparisonHtml(undoOldHtml, libraryId);

    // Ranges this run has resolved a context onto — spliced back to
    // `undoOldHtml` or found already holding it — kept in the CURRENT
    // `result` string's coordinates. Splicing at a lower offset shifts every
    // range positioned after it, so entries are adjusted by the length delta
    // after each splice — with descending replay, an already-recorded range
    // sits at a HIGHER offset than the splice that just happened (it was
    // consumed in an earlier, higher-offset step), so it is always the one
    // that needs shifting, never the reverse.
    const consumedRanges: Array<{ start: number; end: number }> = [];

    let result = strippedHtml;
    for (const ctx of occurrenceContextsDescending) {
        const range = findRangeByContexts(result, ctx.before, ctx.after, undoNewHtml.length);
        if (!range) return undefined;

        // Zero-width ranges (deletion/insertion seams) need an equality
        // check instead of the strict-inequality overlap test: two distinct
        // zero-width ranges at the SAME point are indistinguishable ([s,s)
        // vs [s,s)), and the strict test `a.start < b.end && b.start < a.end`
        // always evaluates false for them, which would let a duplicate
        // zero-width resolution through undetected. Zero-width ranges that
        // sit at DIFFERENT points (e.g. successive seams separated by an
        // earlier splice) still compare unequal and correctly don't overlap.
        const isZeroWidth = range.start === range.end;
        const overlapsConsumed = consumedRanges.some((r) => {
            if (isZeroWidth && r.start === r.end) return r.start === range.start;
            return range.start < r.end && r.start < range.end;
        });
        if (overlapsConsumed) return undefined;

        const regionHtml = result.substring(range.start, range.end);
        const alreadyRestored =
            regionHtml === undoOldHtml || normalizeUndoComparisonHtml(regionHtml, libraryId) === normalizedOld;

        if (!alreadyRestored) {
            if (regionHtml !== undoNewHtml && normalizeUndoComparisonHtml(regionHtml, libraryId) !== normalizedNew) {
                return undefined;
            }

            result = result.substring(0, range.start) + undoOldHtml + result.substring(range.end);

            const delta = undoOldHtml.length - (range.end - range.start);
            if (delta !== 0) {
                for (const r of consumedRanges) {
                    if (r.start >= range.end) {
                        r.start += delta;
                        r.end += delta;
                    }
                }
            }
        }

        // Record the range this context resolved onto — whether just spliced
        // or already holding `undoOldHtml` — so a later context resolving
        // onto the same region is caught as ambiguous instead of being
        // treated as another independent already-restored retry. A spliced
        // region now holds `undoOldHtml` exactly; an already-restored region
        // keeps its resolved extent, which normalization can make longer or
        // shorter than `undoOldHtml` — recording anything narrower would let
        // a later context resolve inside the uncovered remainder.
        consumedRanges.push(
            alreadyRestored
                ? { start: range.start, end: range.end }
                : { start: range.start, end: range.start + undoOldHtml.length },
        );
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
            const current = strippedHtml.substring(range.start, range.end);
            if (current === undoOldHtml) return true;
            // The note editor inserts newlines around restored block HTML.
            // These separators are not a second deletion waiting to be undone.
            if (undoOldHtml.startsWith('<') && undoOldHtml.endsWith('>')) {
                const canonical = (html: string) => html.replace(/>\s+</g, '><').trim();
                return canonical(current) === canonical(undoOldHtml);
            }
            return false;
        }
        // Context anchors were expected but could not be found in the current
        // HTML (likely due to ProseMirror whitespace normalization drift).
        return false;
    }
    return strippedHtml.includes(undoOldHtml);
}

/**
 * Idempotency pre-check for a batch str_replace_all undo record. Batch
 * records carry no record-level before/after context for str_replace_all
 * (only the per-occurrence anchors in `undo_occurrence_contexts`), so this
 * mirrors `isAlreadyUndone`'s context-less branch at document scope: true
 * when the applied text is gone from the whole note (checked both verbatim
 * and, since a ProseMirror-normalized variant of the applied text can remain
 * present even once the raw bytes are gone, after whitespace/entity
 * normalization) and the original text is still present (same verbatim +
 * normalized check). Only meaningful for non-deletion records — a deletion's
 * `undoOldHtml` was removed by the edit, so its mere presence elsewhere in
 * the note is not a reliable "already undone" signal.
 */
export function isBatchReplaceAllAlreadyUndone(
    strippedHtml: string,
    undoOldHtml: string,
    undoNewHtml: string,
    libraryId: number
): boolean {
    if (strippedHtml.includes(undoNewHtml)) return false;

    // Reused for both the applied-text-absence check below and the
    // original-text-presence check further down.
    const normalizedDoc = normalizeUndoComparisonHtml(strippedHtml, libraryId);
    const normalizedNew = normalizeUndoComparisonHtml(undoNewHtml, libraryId);
    if (normalizedNew.length > 0 && normalizedDoc.includes(normalizedNew)) return false;

    if (strippedHtml.includes(undoOldHtml)) return true;
    if (!undoOldHtml) return false;
    const normalizedOld = normalizeUndoComparisonHtml(undoOldHtml, libraryId);
    return normalizedOld.length > 0 && normalizedDoc.includes(normalizedOld);
}

const UNDO_CONTEXT_LENGTH = 200;

/** Combine optional warning strings into a `warnings` array, or undefined when empty. */

interface RestoreEditFragmentParams {
    strippedHtml: string;
    /** Raw HTML fragment to put back (empty for insert/append undo). */
    undoOldHtml: string;
    /** Raw HTML fragment the edit inserted. `''` selects the deletion-seam path. */
    undoNewHtml: string;
    beforeCtx?: string;
    afterCtx?: string;
    libraryId: number;
    /** Function-name prefix for diagnostic logs. */
    logPrefix: string;
    /** Per-caller identifier (note id / edit index) embedded in diagnostic logs. */
    logLabel: string;
    /** Deletion path: thrown when neither before/after context was stored. */
    noContextError: string;
    /** Deletion path: thrown when the deletion seam can no longer be located. */
    seamNotFoundError: string;
    /** General path: thrown when `undo_new_html` can no longer be located. */
    fragmentNotFoundError: string;
}

type RestoreEditFragmentResult =
    | { kind: 'restored'; html: string }
    | { kind: 'already-undone' };

/**
 * Restore one edit's fragment against the current stripped note HTML, returning
 * the updated HTML (or an `already-undone` no-op signal). Handles both the
 * deletion-seam restore (`undoNewHtml === ''` → relocate the seam via
 * before/after context and reinsert `undoOldHtml`) and the general
 * single-occurrence restore (locate `undoNewHtml` — exact → entity-decode →
 * whitespace-tolerant → context/fuzzy — and replace it with `undoOldHtml`).
 *
 * Callers own the caller-specific error strings and the `already-undone` log
 * line; they also handle str_replace_all separately (its multi-occurrence
 * replay is not part of this single-fragment chain).
 */
function restoreEditFragment(params: RestoreEditFragmentParams): RestoreEditFragmentResult {
    const {
        strippedHtml,
        undoNewHtml,
        libraryId,
        logPrefix,
        logLabel,
        noContextError,
        seamNotFoundError,
        fragmentNotFoundError,
    } = params;

    // ── deletion: locate the seam via context and reinsert undo_old_html ──
    if (undoNewHtml === '') {
        let before = params.beforeCtx;
        let after = params.afterCtx;
        let restoreHtml = params.undoOldHtml;

        if (before === undefined && after === undefined) {
            throw new Error(noContextError);
        }

        // PM may have decoded HTML entities (e.g. &#x27; → ') since the undo
        // data was stored. Try entity-decoded versions if the raw seam isn't found.
        const seamRaw = (before || '') + (after || '');
        if (seamRaw && !strippedHtml.includes(seamRaw)) {
            const decodedBefore = before != null ? decodeHtmlEntities(before) : undefined;
            const decodedAfter = after != null ? decodeHtmlEntities(after) : undefined;
            const seamDecoded = (decodedBefore || '') + (decodedAfter || '');
            if (seamDecoded !== seamRaw && strippedHtml.includes(seamDecoded)) {
                before = decodedBefore;
                after = decodedAfter;
                restoreHtml = decodeHtmlEntities(restoreHtml);
            }
        }

        // PM may have changed inter-tag whitespace (indentation, newlines).
        const seamAfterDecode = (before || '') + (after || '');
        if (seamAfterDecode && !strippedHtml.includes(seamAfterDecode)) {
            const beforeWs = before ? findWhitespaceTolerant(strippedHtml, before) : null;
            const afterWs = after ? findWhitespaceTolerant(strippedHtml, after) : null;
            if (beforeWs || afterWs) {
                logger(`${logPrefix}: whitespace-tolerant context match for ${logLabel} deletion undo`, 1);
                if (beforeWs) before = strippedHtml.substring(beforeWs.start, beforeWs.end);
                if (afterWs) after = strippedHtml.substring(afterWs.start, afterWs.end);
                const oldWs = findWhitespaceTolerant(strippedHtml, restoreHtml);
                if (oldWs) restoreHtml = strippedHtml.substring(oldWs.start, oldWs.end);
            }
        }

        if (isAlreadyUndone(strippedHtml, restoreHtml, before, after)) {
            return { kind: 'already-undone' };
        }

        const seamLoc = locateEditFragment({
            strippedHtml,
            intent: { kind: 'undo-seam', beforeContext: before, afterContext: after },
        });
        if (seamLoc.kind !== 'seam') {
            throw new Error(seamNotFoundError);
        }
        logger(`${logPrefix}: ${logLabel} deletion seam at ${seamLoc.insertionPoint}`
            + (seamLoc.gapEnd !== undefined ? ` (gap=${seamLoc.gapEnd - seamLoc.insertionPoint})` : ''), 1);
        // When the editor inserted whitespace between the two contexts, span
        // the gap so the undo replaces it (gapEnd marks the start of afterCtx).
        const sliceEnd = seamLoc.gapEnd ?? seamLoc.insertionPoint;
        return {
            kind: 'restored',
            html: strippedHtml.substring(0, seamLoc.insertionPoint) + restoreHtml + strippedHtml.substring(sliceEnd),
        };
    }

    // ── general case: locate undo_new_html and restore undo_old_html there ──
    let undoOldLocal = params.undoOldHtml;
    let undoNewLocal = undoNewHtml;
    let before = params.beforeCtx;
    let after = params.afterCtx;

    // PM may have decoded HTML entities since the undo data was stored. If the
    // stored new_html isn't found, try entity-decoded versions so all
    // subsequent matching works.
    if (!strippedHtml.includes(undoNewLocal)) {
        const decodedNew = decodeHtmlEntities(undoNewLocal);
        if (decodedNew !== undoNewLocal && strippedHtml.includes(decodedNew)) {
            undoNewLocal = decodedNew;
            undoOldLocal = decodeHtmlEntities(undoOldLocal);
            if (before != null) before = decodeHtmlEntities(before);
            if (after != null) after = decodeHtmlEntities(after);
        }
    }

    // PM may have changed inter-tag whitespace since the undo data was stored.
    // If the exact string still isn't found, try whitespace-tolerant matching
    // and update the undo strings + contexts to the PM-normalized versions.
    if (!strippedHtml.includes(undoNewLocal)) {
        const wsMatch = findWhitespaceTolerant(strippedHtml, undoNewLocal);
        if (wsMatch) {
            logger(`${logPrefix}: whitespace-tolerant match for undo_new_html on ${logLabel}`, 1);
            undoNewLocal = strippedHtml.substring(wsMatch.start, wsMatch.end);
            if (!strippedHtml.includes(undoOldLocal)) {
                const oldWsMatch = findWhitespaceTolerant(strippedHtml, undoOldLocal);
                if (oldWsMatch) undoOldLocal = strippedHtml.substring(oldWsMatch.start, oldWsMatch.end);
            }
            before = strippedHtml.substring(Math.max(0, wsMatch.start - UNDO_CONTEXT_LENGTH), wsMatch.start);
            after = strippedHtml.substring(wsMatch.end, Math.min(strippedHtml.length, wsMatch.end + UNDO_CONTEXT_LENGTH));
        }
    }

    const newStringFound = strippedHtml.includes(undoNewLocal);
    if (!newStringFound && isAlreadyUndone(strippedHtml, undoOldLocal, before, after)) {
        return { kind: 'already-undone' };
    }

    const fragment = locateEditFragment({
        strippedHtml,
        intent: {
            kind: 'undo-fragment',
            expectedHtml: undoNewLocal,
            beforeContext: before,
            afterContext: after,
            libraryId,
            allowFuzzy: true,
        },
    });
    if (fragment.kind !== 'range') {
        throw new Error(fragmentNotFoundError);
    }
    if (fragment.via !== 'exact') {
        logger(`${logPrefix}: ${logLabel} restored via ${fragment.via}`, 1);
    }
    return {
        kind: 'restored',
        html: strippedHtml.substring(0, fragment.start) + undoOldLocal + strippedHtml.substring(fragment.end),
    };
}

/** Edit operations that do not anchor on matched text, so a changed note goes unnoticed. */
function isUnanchoredOperation(operation: EditNoteOperation | undefined): boolean {
    return operation === 'rewrite' || operation === 'append';
}

/**
 * Throw `stale_proposal` when the note no longer hashes to the
 * `baseline.content_hash` stored with the proposal. Called after the live
 * editor has been flushed, so the stored HTML is what the user sees. A
 * proposal without a hash is not checked.
 */
async function assertNoteUnchanged(item: Zotero.Item, proposedData: { baseline?: EditNoteBaseline | null }): Promise<void> {
    const contentHash = proposedData.baseline?.content_hash;
    if (typeof contentHash !== 'string' || !contentHash) return;
    if (await sha256Hex(item.getNote()) !== contentHash) {
        throw staleProposalError('The note changed after this edit was proposed.');
    }
}

/**
 * Apply a stored edit_note action through the shared executor
 * (`applyEditNote`), which records the exact HTML written for undo.
 *
 * rewrite and append do not anchor on text in the note, so they are refused
 * as `stale_proposal` when the note changed since the proposal, unless the
 * user applies anyway (`options.skipStaleCheck`). A replacement re-matches its
 * text against the current note instead.
 */
export async function executeEditNoteAction(
    action: AgentAction,
    context: OperationContext,
    options: ManualApplyOptions = {},
): Promise<EditNoteResultData> {
    const data = action.proposed_data as EditNoteProposedData;
    const checkDrift = isUnanchoredOperation(data.operation) && !options.skipStaleCheck;
    return applyEditNote(data, unboundedExecutionContext(), context, {
        assertUnchanged: checkDrift ? (item) => assertNoteUnchanged(item, data) : undefined,
    });
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
    action: AgentAction,
    context: OperationContext,
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

    // Undo is a fresh mutation and must respect exclusions that changed after
    // the action was originally applied. Check before resolving/loading.
    assertLibraryRefNotExcluded({
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

    // ── rewrite undo: restore full note from undo_full_html ──
    if (typeof resultData?.undo_full_html === 'string') {
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
    await dismissNotePreviews(library_id, zotero_key);
    await item.loadDataType('note');
    const noteId = `${library_id}-${zotero_key}`;

    // Load file references before the undo snapshot, only when raw undo HTML is missing.
    const externalRefContext = !isDeletion && resultData?.undo_new_html === undefined
        ? await getExternalRefContext(new_string, context)
        : undefined;

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
        // Resolve page labels for new_string citations so the fallback
        // expansion translates 1-based page numbers the same way the
        // original execute did.
        const undoPageLabels = isDeletion
            ? {}
            : await preloadPageLabelsForNewCitations(new_string);

        try {
            if (expandedOld === undefined) {
                // Actions predating raw undo snapshots used dollar-only math anchors.
                // Current actions always restore their stored undo_old_html verbatim.
                expandedOld = expandToRawHtml(old_string ?? '', metadata, 'legacy-old');
            }
            if (!isDeletion && expandedNew === undefined) {
                expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext, undoPageLabels);
            }
        } catch (e: any) {
            throw new Error(`Failed to expand strings for undo: ${e.message || String(e)}`);
        }
    }

    let restoredHtml: string | undefined;

    const restoreErrors = {
        noContextError:
            'Cannot undo deletion: no surrounding context stored in result_data. '
            + 'This action was applied before deletion-undo support was added.',
        seamNotFoundError:
            'Cannot undo deletion: the note has been modified around the deletion point. '
            + 'The surrounding context could not be found.',
        fragmentNotFoundError:
            'Cannot undo: the note has been modified since this edit was applied. '
            + 'Neither the applied text nor the original text could be found.',
    };

    if (!isDeletion && operation === 'str_replace_all') {
        // --- str_replace_all reverse: multi-occurrence replay, kept separate
        //     from the single-fragment restore chain ---
        let undoOldHtml = expandedOld!;
        let undoNewHtml = expandedNew!;

        // Absent fields arrive from the backend as null.
        let beforeCtx = resultData?.undo_before_context ?? undefined;
        let afterCtx = resultData?.undo_after_context ?? undefined;

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
                throw new Error(restoreErrors.fragmentNotFoundError);
            }
        } else {
            // Exact match path — undoNewHtml found verbatim
            restoredHtml = strippedHtml.split(undoNewHtml).join(undoOldHtml);
        }
    } else {
        // --- Deletion + single-occurrence reverse via the shared restore chain ---
        const restore = restoreEditFragment({
            strippedHtml,
            undoOldHtml: expandedOld!,
            undoNewHtml: isDeletion ? '' : expandedNew!,
            beforeCtx: resultData?.undo_before_context ?? undefined,
            afterCtx: resultData?.undo_after_context ?? undefined,
            libraryId: library_id,
            logPrefix: 'undoEditNoteAction',
            logLabel: `note ${noteId}`,
            ...restoreErrors,
        });
        if (restore.kind === 'already-undone') {
            logger(`undoEditNoteAction: Note ${noteId} already contains old_string, skipping`, 1);
            return;
        }
        restoredHtml = restore.html;
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

/**
 * Apply a stored edit_note_batch action through the shared executor
 * (`applyEditNoteBatch`): every edit resolves against one snapshot of the note
 * and is saved in a single write, all or nothing.
 *
 * A batch with a rewrite or append does not anchor every edit on text in the
 * note, so it is refused as `stale_proposal` when the note changed since the
 * proposal, unless the user applies anyway (`options.skipStaleCheck`).
 */
export async function executeEditNoteBatchAction(
    action: AgentAction,
    context: OperationContext,
    options: ManualApplyOptions = {},
): Promise<EditNoteBatchResultData> {
    const data = action.proposed_data as EditNoteBatchProposedData;
    const checkDrift = (data.edits ?? []).some((edit) => isUnanchoredOperation(edit.operation)) && !options.skipStaleCheck;
    return applyEditNoteBatch(data, unboundedExecutionContext(), context, {
        assertUnchanged: checkDrift ? (item) => assertNoteUnchanged(item, data) : undefined,
        userApproved: true,
    });
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
 *   - `undo_occurrence_contexts` set   → str_replace_all: for a non-deletion
 *                                        record, a document-wide idempotency
 *                                        check first (see
 *                                        `isBatchReplaceAllAlreadyUndone`),
 *                                        then per-occurrence replay against
 *                                        the evolving HTML via
 *                                        `undoBatchReplaceAllViaContexts`.
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

    // Undo records round-trip through the backend, which sends absent optional
    // fields as null; treat those like missing fields.
    const occCtxs = record.undo_occurrence_contexts ?? undefined;

    // ── str_replace_all: per-occurrence context replay ──
    if (occCtxs !== undefined) {
        if (occCtxs.length === 0) {
            throw new Error(`Cannot undo edit ${record.index}: no occurrence context data recorded for a str_replace_all edit.`);
        }

        // Non-deletion records have no record-level context (only
        // per-occurrence anchors), so a retried undo can't rely on the
        // per-occurrence contexts alone: they were captured against the
        // fully-applied document and no longer resolve once every occurrence
        // has already been reverted. Check document-wide first, matching v1's
        // idempotent re-undo behavior. Deletion records skip this — a
        // reliable presence check for removed text needs more than a bare
        // substring search, so double-undo of a deletion stays an error.
        if (undoNewHtml !== '' && isBatchReplaceAllAlreadyUndone(strippedHtml, undoOldHtml, undoNewHtml, libraryId)) {
            logger(`undoEditNoteBatchAction: edit ${record.index} already undone, skipping`, 1);
            return strippedHtml;
        }

        // Replay through the per-occurrence anchors against the evolving
        // HTML, one occurrence at a time (see undoBatchReplaceAllViaContexts).
        // A document-wide split/join would also rewrite matching text that
        // this action never touched (including text added by the user after
        // application).
        const restored = undoBatchReplaceAllViaContexts(
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

    // ── deletion + single-occurrence: replay through the shared restore chain ──
    const restore = restoreEditFragment({
        strippedHtml,
        undoOldHtml,
        undoNewHtml,
        beforeCtx: record.undo_before_context ?? undefined,
        afterCtx: record.undo_after_context ?? undefined,
        libraryId,
        logPrefix: 'undoEditNoteBatchAction',
        logLabel: `edit ${record.index}`,
        noContextError: `Cannot undo edit ${record.index}: no surrounding context stored for this deletion.`,
        seamNotFoundError:
            `Cannot undo edit ${record.index}: the note has been modified around the deletion point. `
            + 'The surrounding context could not be found.',
        fragmentNotFoundError:
            `Cannot undo edit ${record.index}: the note has been modified since this edit was applied. `
            + 'Neither the applied text nor the original text could be found.',
    });
    if (restore.kind === 'already-undone') {
        logger(`undoEditNoteBatchAction: edit ${record.index} already undone, skipping`, 1);
        return strippedHtml;
    }
    return restore.html;
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
    assertLibraryRefNotExcluded({
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

    await dismissNotePreviews(library_id, zotero_key);
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
