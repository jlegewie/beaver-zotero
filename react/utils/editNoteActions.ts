/**
 * Utilities for executing and undoing edit_note agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import type { EditNoteResultData } from '../types/agentActions/editNote';
import { logger } from '../../src/utils/logger';
import {
    getOrSimplify,
    simplifyNoteHtml,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    countOccurrences,
    getLatestNoteHtml,
    invalidateSimplificationCache,
    checkDuplicateCitations,
    findFuzzyMatch,
    findUniqueRawMatchPosition,
    findTargetRawMatchPosition,
    preloadPageLabelsForNewCitations,
    findRangeByContexts,
    waitForPMNormalization,
    hasSchemaVersionWrapper,
    decodeHtmlEntities,
    encodeTextEntities,
} from '../../src/utils/noteHtmlSimplifier';
import { clearNoteEditorSelection } from './sourceUtils';
import { store } from '../store';
import { currentThreadIdAtom } from '../atoms/threads';
import { addOrUpdateEditFooter } from '../../src/utils/noteEditFooter';

function normalizeUndoComparisonHtml(html: string, libraryId: number): string {
    const { simplified } = simplifyNoteHtml(stripDataCitationItems(html), libraryId);
    // Collapse all whitespace, then strip whitespace between HTML tags so that
    // ProseMirror-inserted newlines (e.g. </p>\n</div> vs </p></div>) don't
    // cause false mismatches during undo comparison.
    return simplified.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

function findRangesByRawAnchors(
    currentHtml: string,
    targetHtml: string
): Array<{ start: number; end: number }> {
    const anchorLengths = [160, 120, 80, 40, 24, 16, 12];
    const candidates: Array<{ start: number; end: number }> = [];
    const seen = new Set<string>();
    const MAX_PREFIX_MATCHES = 12;
    const MAX_SUFFIX_MATCHES_PER_PREFIX = 8;

    for (const prefixLen of anchorLengths) {
        const resolvedPrefixLen = Math.min(prefixLen, targetHtml.length);
        if (resolvedPrefixLen < 12) continue;

        const prefix = targetHtml.slice(0, resolvedPrefixLen);
        let prefixSearchFrom = 0;
        let prefixMatches = 0;

        while (prefixMatches < MAX_PREFIX_MATCHES) {
            const start = currentHtml.indexOf(prefix, prefixSearchFrom);
            if (start === -1) break;

            prefixMatches += 1;

            for (const suffixLen of anchorLengths) {
                const resolvedSuffixLen = Math.min(suffixLen, targetHtml.length);
                if (resolvedSuffixLen < 12) continue;

                const suffix = targetHtml.slice(-resolvedSuffixLen);
                let suffixSearchFrom = start + resolvedPrefixLen;
                let suffixMatches = 0;

                while (suffixMatches < MAX_SUFFIX_MATCHES_PER_PREFIX) {
                    const suffixIdx = currentHtml.indexOf(suffix, suffixSearchFrom);
                    if (suffixIdx === -1) break;

                    suffixMatches += 1;

                    const key = `${start}:${suffixIdx + resolvedSuffixLen}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        candidates.push({ start, end: suffixIdx + resolvedSuffixLen });
                    }

                    suffixSearchFrom = suffixIdx + 1;
                }
            }

            prefixSearchFrom = start + 1;
        }
    }

    candidates.sort((a, b) => {
        const lengthDiff = (a.end - a.start) - (b.end - b.start);
        if (lengthDiff !== 0) {
            return lengthDiff;
        }
        return a.start - b.start;
    });

    return candidates;
}

/**
 * Undo a replace_all edit by locating each occurrence via its stored context anchors.
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
        const range = findRangeByContexts(strippedHtml, ctx.before, ctx.after);
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
        const range = findRangeByContexts(strippedHtml, beforeCtx, afterCtx);
        if (range) {
            return strippedHtml.substring(range.start, range.end) === undoOldHtml;
        }
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
        replace_all,
    } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
        target_before_context?: string;
        target_after_context?: string;
    };
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

    // 3. Get current note HTML
    const oldHtml = getLatestNoteHtml(item);

    // 4. Get metadata from cache or re-simplify
    const noteId = `${library_id}-${zotero_key}`;
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id);

    // 5. Pre-load page labels so new citations resolve page indices to labels
    await preloadPageLabelsForNewCitations(new_string);

    // 6. Expand old_string and new_string to raw HTML
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string, metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new');
    } catch (e: any) {
        throw new Error(e.message || String(e));
    }

    // 6. Strip data-citation-items from raw HTML for matching
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
        // Reverse: model used ' but note has &#x27; (pre-PM normalization)
        const encodedOld = encodeTextEntities(expandedOld);
        if (encodedOld !== expandedOld && countOccurrences(strippedHtml, encodedOld) > 0) {
            expandedOld = encodedOld;
            expandedNew = encodeTextEntities(expandedNew);
            if (target_before_context != null) target_before_context = encodeTextEntities(target_before_context);
            if (target_after_context != null) target_after_context = encodeTextEntities(target_after_context);
            matchCount = countOccurrences(strippedHtml, expandedOld);
        }
    }

    // 8. Zero matches
    if (matchCount === 0) {
        const fuzzy = findFuzzyMatch(simplified, old_string);
        throw new Error(
            'The string to replace was not found in the note.'
            + (fuzzy ? ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\`` : '')
        );
    }

    // 9. Perform replacement and capture context
    let newHtml: string;
    let undoBeforeContext: string | undefined;
    let undoAfterContext: string | undefined;
    let undoOccurrenceContexts: Array<{ before: string; after: string }> | undefined;
    let replacementCount: number;

    if (replace_all) {
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
            rawPos = findUniqueRawMatchPosition(
                strippedHtml, simplified, old_string, expandedOld, metadata
            ) ?? -1;
            if (rawPos === -1 && (
                target_before_context !== undefined || target_after_context !== undefined
            )) {
                rawPos = findTargetRawMatchPosition(
                    strippedHtml,
                    expandedOld,
                    target_before_context,
                    target_after_context
                ) ?? -1;
            }
        }

        if (rawPos === -1) {
            if (matchCount > 1) {
                throw new Error(
                    `The string to replace was found ${matchCount} times in the note. `
                    + 'Use replace_all to replace all occurrences, or include more context.'
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
    }

    // 10b. Add/update "Edited by Beaver" footer
    const threadId = store.get(currentThreadIdAtom);
    if (threadId) {
        newHtml = addOrUpdateEditFooter(newHtml, threadId);
    }

    // 11. Rebuild data-citation-items
    newHtml = rebuildDataCitationItems(newHtml);

    // 12. Wrapper div protection — only error if the edit removed it
    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
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

    // 13b. Clear editor selection so it doesn't shift to unrelated text
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
    await waitForPMNormalization(item, savedStrippedHtml, result);

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
    const { library_id, zotero_key, old_string, new_string, replace_all } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
    };

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
    const resultData = action.result_data as EditNoteResultData | undefined;

    // 3. Get current HTML
    const currentHtml = getLatestNoteHtml(item);

    // 4. Strip data-citation-items for matching
    const strippedHtml = stripDataCitationItems(currentHtml);
    const storedUndoOldHtml = resultData?.undo_old_html;
    const storedUndoNewHtml = resultData?.undo_new_html;

    let expandedOld = storedUndoOldHtml;
    let expandedNew = storedUndoNewHtml;

    if (!expandedOld || (!isDeletion && expandedNew === undefined)) {
        const { metadata } = getOrSimplify(noteId, currentHtml, library_id);

        try {
            if (!expandedOld) {
                expandedOld = expandToRawHtml(old_string, metadata, 'old');
            }
            if (!isDeletion && expandedNew === undefined) {
                expandedNew = expandToRawHtml(new_string, metadata, 'new');
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

        // Check if already undone (old_string is back in the note) — context-aware
        if (isAlreadyUndone(strippedHtml, undoOldHtml, beforeCtx, afterCtx)) {
            logger(`undoEditNoteAction: Note ${noteId} already contains old_string, skipping`, 1);
            return;
        }

        // Find the insertion point using before/after context.
        // The editor may normalize whitespace at the deletion seam (e.g. collapse
        // double newlines), so we cannot rely on an exact beforeCtx+afterCtx match.
        // Instead, find beforeCtx individually and use its end as the insertion point,
        // with afterCtx as a nearby sanity check.
        const MAX_GAP = 10; // Allow up to 10 chars of whitespace normalization at the seam

        // Strategy 1: exact seam match (ideal case)
        const seam = (beforeCtx || '') + (afterCtx || '');
        let insertionPoint = -1;
        const seamIdx = strippedHtml.indexOf(seam);
        if (seamIdx !== -1) {
            insertionPoint = seamIdx + (beforeCtx || '').length;
            logger(`undoEditNoteAction: exact seam match at ${seamIdx}`, 1);
        }

        // Strategy 2: find beforeCtx end, verify afterCtx is nearby
        if (insertionPoint === -1 && beforeCtx) {
            const beforeIdx = strippedHtml.indexOf(beforeCtx);
            if (beforeIdx !== -1) {
                const beforeEnd = beforeIdx + beforeCtx.length;
                if (afterCtx) {
                    const afterIdx = strippedHtml.indexOf(afterCtx, Math.max(0, beforeEnd - MAX_GAP));
                    if (afterIdx !== -1 && Math.abs(afterIdx - beforeEnd) <= MAX_GAP) {
                        // afterCtx is near the end of beforeCtx — use beforeEnd as insertion point.
                        // Remove any whitespace the editor inserted between the two contexts.
                        insertionPoint = beforeEnd;
                        // Adjust: if there are extra chars between beforeEnd and afterIdx, the
                        // insertion should replace that gap (it's editor-inserted whitespace)
                        const gapSize = afterIdx - beforeEnd;
                        logger(`undoEditNoteAction: beforeCtx+afterCtx proximity match (gap=${gapSize})`, 1);
                        restoredHtml = strippedHtml.substring(0, beforeEnd)
                            + undoOldHtml
                            + strippedHtml.substring(afterIdx);
                    }
                } else {
                    // No afterCtx — use beforeEnd directly
                    insertionPoint = beforeEnd;
                    logger(`undoEditNoteAction: using beforeCtx end only (no afterCtx)`, 1);
                }
            }
        }

        // Strategy 3: find afterCtx start (beforeCtx not found)
        if (insertionPoint === -1 && afterCtx) {
            const afterIdx = strippedHtml.indexOf(afterCtx);
            if (afterIdx !== -1) {
                insertionPoint = afterIdx;
                logger(`undoEditNoteAction: using afterCtx start only (no beforeCtx match)`, 1);
            }
        }

        if (insertionPoint === -1) {
            throw new Error(
                'Cannot undo deletion: the note has been modified around the deletion point. '
                + 'The surrounding context could not be found.'
            );
        }

        // Build restored HTML (if not already set by proximity match above)
        if (!restoredHtml) {
            restoredHtml = strippedHtml.substring(0, insertionPoint)
                + undoOldHtml
                + strippedHtml.substring(insertionPoint);
        }
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

        // 3-way detection — context-aware "already undone" check
        const newStringFound = strippedHtml.includes(undoNewHtml);

        if (!newStringFound && isAlreadyUndone(strippedHtml, undoOldHtml, beforeCtx, afterCtx)) {
            logger(`undoEditNoteAction: Note ${noteId} already contains old_string, skipping`, 1);
            return;
        }

        if (!newStringFound) {
            // Exact match failed — try fuzzy recovery via context anchors
            if (replace_all) {
                // replace_all: use per-occurrence contexts to locate and replace each occurrence
                const occCtxs = resultData?.undo_occurrence_contexts;
                if (occCtxs && occCtxs.length > 0) {
                    restoredHtml = undoReplaceAllViaContexts(
                        strippedHtml, undoOldHtml, undoNewHtml, occCtxs, library_id
                    );
                    if (restoredHtml) {
                        logger(`undoEditNoteAction: restored ${occCtxs.length} replace_all occurrences via contexts on note ${noteId}`, 1);
                    }
                }
            } else {
                // Single occurrence: find via context anchors + raw anchors, then normalize-compare
                const candidateRanges: Array<{ start: number; end: number; fromContext: boolean }> = [];
                const seenRanges = new Set<string>();

                const contextRange = findRangeByContexts(strippedHtml, beforeCtx, afterCtx);
                if (contextRange) {
                    const key = `${contextRange.start}:${contextRange.end}`;
                    seenRanges.add(key);
                    candidateRanges.push({ ...contextRange, fromContext: true });
                }

                for (const anchorRange of findRangesByRawAnchors(strippedHtml, undoNewHtml)) {
                    const key = `${anchorRange.start}:${anchorRange.end}`;
                    if (seenRanges.has(key)) {
                        continue;
                    }
                    seenRanges.add(key);
                    candidateRanges.push({ ...anchorRange, fromContext: false });
                }

                for (const candidateRange of candidateRanges) {
                    const candidateHtml = strippedHtml.substring(candidateRange.start, candidateRange.end);
                    const normalizedCandidate = normalizeUndoComparisonHtml(candidateHtml, library_id);
                    const normalizedExpected = normalizeUndoComparisonHtml(undoNewHtml, library_id);

                    if (normalizedCandidate !== normalizedExpected) {
                        // Normalized HTML didn't match — PM may have restructured
                        // the HTML (e.g., inline styles → semantic wrappers like
                        // <strong>). Fall back to text-content comparison: if the
                        // visible text is the same, PM only changed structure and
                        // it's safe to trust the context anchors.
                        //
                        // IMPORTANT: Only allow this fallback for context-anchor
                        // candidates (200 chars before + after), which provide
                        // strong uniqueness guarantees. Raw anchor candidates are
                        // less reliable and could false-positive on duplicate text.
                        if (!candidateRange.fromContext) {
                            continue;
                        }
                        const candidateText = candidateHtml.replace(/<[^>]+>/g, '').trim();
                        const expectedText = undoNewHtml.replace(/<[^>]+>/g, '').trim();
                        if (!candidateText || candidateText !== expectedText) {
                            continue;
                        }
                        logger(`undoEditNoteAction: text-content match (PM restructured HTML) on note ${noteId}`, 1);
                    }

                    restoredHtml = strippedHtml.substring(0, candidateRange.start)
                        + undoOldHtml
                        + strippedHtml.substring(candidateRange.end);
                    logger(`undoEditNoteAction: restored via fuzzy matching on note ${noteId}`, 1);
                    break;
                }
            }

            if (!restoredHtml) {
                throw new Error(
                    'Cannot undo: the note has been modified since this edit was applied. '
                    + 'Neither the applied text nor the original text could be found.'
                );
            }
        }

        if (!restoredHtml) {
            // Exact match path — undoNewHtml was found in strippedHtml
            if (replace_all) {
                restoredHtml = strippedHtml.split(undoNewHtml).join(undoOldHtml);
            } else {
                let idx = strippedHtml.indexOf(undoNewHtml);
                // When undoNewHtml appears more than once (e.g. after a disambiguated
                // duplicate-citation edit made the target look like another citation),
                // indexOf alone picks the first match which may be the wrong one.
                // Use context anchors to find the correct occurrence.
                if (idx !== -1 && beforeCtx && strippedHtml.indexOf(undoNewHtml, idx + undoNewHtml.length) !== -1) {
                    const ctxRange = findRangeByContexts(strippedHtml, beforeCtx, afterCtx);
                    if (ctxRange) {
                        idx = ctxRange.start;
                    }
                }
                restoredHtml = strippedHtml.substring(0, idx) + undoOldHtml
                    + strippedHtml.substring(idx + undoNewHtml.length);
            }
        }
    }

    // Rebuild data-citation-items
    restoredHtml = rebuildDataCitationItems(restoredHtml!);

    // Save
    try {
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteAction: Reversed edit on note ${noteId}`, 1);
    } catch (error) {
        throw new Error(`Failed to save note after undo: ${error}`);
    }

    // Clear editor selection so it doesn't shift to unrelated text
    clearNoteEditorSelection(library_id, zotero_key);

    // Invalidate simplification cache
    invalidateSimplificationCache(noteId);
}
