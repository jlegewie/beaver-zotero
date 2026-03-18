/**
 * Handler for read_note_request events.
 *
 * Returns a Zotero note's content in simplified HTML with line numbers,
 * warming the simplification cache used by edit_note.
 */

import { logger } from '../../utils/logger';
import { getOrSimplify, getLatestNoteHtml } from '../../utils/noteHtmlSimplifier';
import {
    WSReadNoteRequest,
    WSReadNoteResponse,
} from '../agentProtocol';


/**
 * Parse a note_id string ("{libraryID}-{itemKey}") into its components.
 * Returns null if the format is invalid.
 */
function parseNoteId(noteId: string): { libraryId: number; itemKey: string } | null {
    const dashIdx = noteId.indexOf('-');
    if (dashIdx === -1) return null;
    const libraryId = parseInt(noteId.substring(0, dashIdx), 10);
    const itemKey = noteId.substring(dashIdx + 1);
    if (isNaN(libraryId) || !itemKey) return null;
    return { libraryId, itemKey };
}


/**
 * Handle read_note_request event.
 * Reads a Zotero note's content and returns it in simplified HTML with line numbers.
 */
export async function handleReadNoteRequest(
    request: WSReadNoteRequest
): Promise<WSReadNoteResponse> {
    const { note_id, offset, limit, request_id } = request;

    // Helper for error responses
    const errorResponse = (error: string): WSReadNoteResponse => ({
        type: 'read_note',
        request_id,
        success: false,
        error,
    });

    // 1. Parse note_id
    const parsed = parseNoteId(note_id);
    if (!parsed) {
        return errorResponse(
            `Invalid note_id format: '${note_id}'. Expected '{libraryID}-{itemKey}'.`
        );
    }

    try {
        // 2. Look up item
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            parsed.libraryId,
            parsed.itemKey
        );

        if (!item) {
            return errorResponse(`Note not found: ${note_id}`);
        }

        // 3. Verify item is a note
        if (!item.isNote()) {
            return errorResponse(
                `Item ${note_id} is not a note (type: ${item.itemType})`
            );
        }

        // 4. Load note data
        await item.loadDataType('note');

        // 5. Get raw HTML (reads from open editor if available, to capture unsaved changes)
        const rawHtml = getLatestNoteHtml(item);
        if (!rawHtml || rawHtml.trim() === '') {
            return {
                type: 'read_note',
                request_id,
                success: true,
                note_id,
                title: item.getNoteTitle() || '(empty note)',
                total_lines: 0,
                content: '(empty note)',
            };
        }

        // 6. Simplify (also warms cache for subsequent edit_note calls)
        const { simplified } = getOrSimplify(note_id, rawHtml, item.libraryID);

        // 7. Format with line numbers and apply offset/limit pagination
        const lines = simplified.split('\n');
        const totalLines = lines.length;
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit ? Math.min(start + limit, totalLines) : totalLines;
        const slice = lines.slice(start, end);

        const maxLineNumWidth = String(end).length;
        const numbered = slice.map((line, i) => {
            const lineNum = String(start + i + 1).padStart(maxLineNumWidth, ' ');
            return `${lineNum}|${line}`;
        }).join('\n');

        // 8. Gather parent metadata
        let parentItemId: string | undefined;
        let parentTitle: string | undefined;
        if (item.parentItem) {
            await item.parentItem.loadDataType('itemData');
            parentItemId = `${item.parentItem.libraryID}-${item.parentItem.key}`;
            parentTitle = item.parentItem.getField('title') as string;
        }

        // 9. Return response
        return {
            type: 'read_note',
            request_id,
            success: true,
            note_id,
            title: item.getNoteTitle() || '(untitled)',
            parent_item_id: parentItemId,
            parent_title: parentTitle,
            total_lines: totalLines,
            content: numbered,
        };
    } catch (error) {
        logger(`handleReadNoteRequest: Failed for ${note_id}: ${error}`, 1);
        return errorResponse(
            `Failed to read note ${note_id}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
