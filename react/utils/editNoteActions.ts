/**
 * Utilities for executing and undoing edit_note agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import type { EditNoteResultData } from '../types/agentActions/editNote';
import { logger } from '../../src/utils/logger';
import {
    getOrSimplify,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    countOccurrences,
    getLatestNoteHtml,
    invalidateSimplificationCache,
    checkDuplicateCitations,
    findFuzzyMatch,
} from '../../src/utils/noteHtmlSimplifier';

/**
 * Execute an edit_note agent action by applying string replacement on the note.
 * @param action The agent action to execute
 * @returns Result data including old/new HTML for undo
 */
export async function executeEditNoteAction(
    action: AgentAction
): Promise<EditNoteResultData> {
    const { library_id, zotero_key, old_string, new_string, replace_all } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
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

    // 5. Expand old_string and new_string to raw HTML
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

    // 7. Count occurrences
    const matchCount = countOccurrences(strippedHtml, expandedOld);

    // 8. Zero matches
    if (matchCount === 0) {
        const fuzzy = findFuzzyMatch(simplified, old_string);
        throw new Error(
            'The string to replace was not found in the note.'
            + (fuzzy ? ` Found a possible fuzzy match:\n${fuzzy}` : '')
        );
    }

    // 9. Multiple matches without replace_all
    if (matchCount > 1 && !replace_all) {
        throw new Error(
            `The string to replace was found ${matchCount} times in the note. `
            + 'Use replace_all to replace all occurrences, or include more context.'
        );
    }

    // 10. Perform replacement
    let newHtml: string;
    if (replace_all) {
        newHtml = strippedHtml.split(expandedOld).join(expandedNew);
    } else {
        const idx = strippedHtml.indexOf(expandedOld);
        newHtml = strippedHtml.substring(0, idx) + expandedNew
            + strippedHtml.substring(idx + expandedOld.length);
    }

    // 11. Rebuild data-citation-items
    newHtml = rebuildDataCitationItems(newHtml);

    // 12. Wrapper div protection
    if (!newHtml.includes('data-schema-version=')) {
        throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
    }

    // 13. Save
    try {
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteAction: Saved note edit to ${noteId} (${matchCount} occurrence(s) replaced)`, 1);
    } catch (error) {
        // Restore in-memory state on save failure
        try {
            item.setNote(oldHtml);
        } catch (_) {
            // Best-effort restoration
        }
        throw new Error(`Failed to save note: ${error}`);
    }

    // 14. Invalidate cache
    invalidateSimplificationCache(noteId);

    // 15. Check for duplicate citation warnings
    const duplicateWarning = checkDuplicateCitations(new_string, metadata);
    const warnings = duplicateWarning ? [duplicateWarning] : undefined;

    return {
        library_id,
        zotero_key,
        occurrences_replaced: matchCount,
        warnings,
    };
}

/**
 * Undo an edit_note agent action using reverse string replacement.
 * Finds new_string in the current note and replaces with old_string.
 *
 * 3-way detection (analogous to edit_metadata undo):
 * - new_string found → undo succeeds (replace with old_string)
 * - old_string found instead → already undone, no-op
 * - neither found → note was modified externally, error
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

    if (!old_string || !new_string) {
        throw new Error('No undo data available: proposed_data.old_string and new_string are required');
    }

    // 1. Load item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    // 2. Load note data
    await item.loadDataType('note');
    const noteId = `${library_id}-${zotero_key}`;

    // 3. Get current HTML and simplification metadata
    const currentHtml = getLatestNoteHtml(item);
    const { metadata } = getOrSimplify(noteId, currentHtml, library_id);

    // 4. Expand the simplified strings to raw HTML for matching
    let expandedNew: string;
    let expandedOld: string;
    try {
        expandedNew = expandToRawHtml(new_string, metadata, 'new');
        expandedOld = expandToRawHtml(old_string, metadata, 'old');
    } catch (e: any) {
        throw new Error(`Failed to expand strings for undo: ${e.message || String(e)}`);
    }

    // 5. Strip data-citation-items for matching
    const strippedHtml = stripDataCitationItems(currentHtml);

    // 6. 3-way detection
    const newStringFound = strippedHtml.includes(expandedNew);
    const oldStringFound = strippedHtml.includes(expandedOld);

    if (!newStringFound && oldStringFound) {
        // Already undone — no-op
        logger(`undoEditNoteAction: Note ${noteId} already contains old_string, skipping`, 1);
        return;
    }

    if (!newStringFound && !oldStringFound) {
        throw new Error(
            'Cannot undo: the note has been modified since this edit was applied. '
            + 'Neither the applied text nor the original text could be found.'
        );
    }

    // 7. Reverse the replacement: new_string → old_string
    let restoredHtml: string;
    if (replace_all) {
        restoredHtml = strippedHtml.split(expandedNew).join(expandedOld);
    } else {
        const idx = strippedHtml.indexOf(expandedNew);
        restoredHtml = strippedHtml.substring(0, idx) + expandedOld
            + strippedHtml.substring(idx + expandedNew.length);
    }

    // 8. Rebuild data-citation-items
    restoredHtml = rebuildDataCitationItems(restoredHtml);

    // 9. Save
    try {
        item.setNote(restoredHtml);
        await item.saveTx();
        logger(`undoEditNoteAction: Reversed edit on note ${noteId}`, 1);
    } catch (error) {
        throw new Error(`Failed to save note after undo: ${error}`);
    }

    // 10. Invalidate simplification cache
    invalidateSimplificationCache(noteId);
}
