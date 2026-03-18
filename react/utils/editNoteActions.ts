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
    isNoteInEditor,
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

    // 3. Snapshot for undo
    const oldHtml = item.getNote();

    // 4. Check editor conflict
    if (isNoteInEditor(item.id)) {
        throw new Error('This note is currently open in the Zotero editor. Close the editor tab before making programmatic edits.');
    }

    // 5. Get metadata from cache or re-simplify
    const noteId = `${library_id}-${zotero_key}`;
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id);

    // 6. Expand old_string and new_string to raw HTML
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string, metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new');
    } catch (e: any) {
        throw new Error(e.message || String(e));
    }

    // 7. Strip data-citation-items from raw HTML for matching
    const strippedHtml = stripDataCitationItems(oldHtml);

    // 8. Count occurrences
    const matchCount = countOccurrences(strippedHtml, expandedOld);

    // 9. Zero matches
    if (matchCount === 0) {
        const fuzzy = findFuzzyMatch(simplified, old_string);
        throw new Error(
            'The string to replace was not found in the note.'
            + (fuzzy ? ` Found a possible fuzzy match:\n${fuzzy}` : '')
        );
    }

    // 10. Multiple matches without replace_all
    if (matchCount > 1 && !replace_all) {
        throw new Error(
            `The string to replace was found ${matchCount} times in the note. `
            + 'Use replace_all to replace all occurrences, or include more context.'
        );
    }

    // 11. Perform replacement
    let newHtml: string;
    if (replace_all) {
        newHtml = strippedHtml.split(expandedOld).join(expandedNew);
    } else {
        const idx = strippedHtml.indexOf(expandedOld);
        newHtml = strippedHtml.substring(0, idx) + expandedNew
            + strippedHtml.substring(idx + expandedOld.length);
    }

    // 12. Rebuild data-citation-items
    newHtml = rebuildDataCitationItems(newHtml);

    // 13. Wrapper div protection
    if (!newHtml.includes('data-schema-version=')) {
        throw new Error('The note wrapper <div data-schema-version="..."> must not be removed.');
    }

    // 14. Save
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

    // 15. Invalidate cache
    invalidateSimplificationCache(noteId);

    // 16. Check for duplicate citation warnings
    const duplicateWarning = checkDuplicateCitations(new_string, metadata);
    const warnings = duplicateWarning ? [duplicateWarning] : undefined;

    return {
        library_id,
        zotero_key,
        old_html: oldHtml,
        new_html: newHtml,
        occurrences_replaced: matchCount,
        warnings,
    };
}

/**
 * Undo an edit_note agent action by restoring the note to its previous HTML.
 * Uses old_html from result_data (captured at apply-time).
 *
 * @param action The agent action to undo (must have been applied with result_data)
 */
export async function undoEditNoteAction(
    action: AgentAction
): Promise<void> {
    const { library_id, zotero_key } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
    };

    const resultData = action.result_data as EditNoteResultData | undefined;
    if (!resultData?.old_html) {
        throw new Error('No undo data available: result_data.old_html is missing');
    }

    // 1. Load item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    // 2. Load note data
    await item.loadDataType('note');

    // 3. Check editor conflict
    if (isNoteInEditor(item.id)) {
        throw new Error('This note is currently open in the Zotero editor. Close the editor tab before undoing edits.');
    }

    // 4. Restore old HTML
    try {
        item.setNote(resultData.old_html);
        await item.saveTx();
        logger(`undoEditNoteAction: Restored note ${library_id}-${zotero_key} to previous state`, 1);
    } catch (error) {
        throw new Error(`Failed to save note after undo: ${error}`);
    }

    // 5. Invalidate simplification cache
    const noteId = `${library_id}-${zotero_key}`;
    invalidateSimplificationCache(noteId);
}
