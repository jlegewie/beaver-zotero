/**
 * Handler for read_note_request events.
 *
 * Returns a Zotero note's content in simplified HTML,
 * warming the simplification cache used by edit_note.
 */

import { logger } from '../../utils/logger';
import { getOrSimplify } from '../../utils/noteHtmlSimplifier';
import { getLatestNoteHtml } from '../../utils/noteEditorIO';
import {
    WSReadNoteRequest,
    WSReadNoteResponse,
} from '../agentProtocol';
import { ItemSummary } from '../../../react/types/zotero';
import { serializeItemSummary } from '../../utils/zoteroSerializers';
import { prepareBatchAttachmentData, processAttachmentsWithBatchData, toAttachmentSummary } from './utils';
import { searchableLibraryIdsAtom, syncWithZoteroAtom } from '../../../react/atoms/profile';
import { userIdAtom } from '../../../react/atoms/auth';
import { store } from '../../../react/store';

/**
 * Extract unique cited item references from simplified note HTML.
 * Parses both single citations (`<citation item_id="LIB-KEY" .../>`)
 * and compound citations (`<citation items="LIB-KEY1, LIB-KEY2" .../>`).
 * Returns deduplicated array of { libraryId, itemKey } pairs.
 */
function extractCitedItemRefs(simplifiedHtml: string): { libraryId: number; itemKey: string }[] {
    const seen = new Set<string>();
    const refs: { libraryId: number; itemKey: string }[] = [];

    const addRef = (itemId: string) => {
        // Strip page locator suffix (e.g., "1-KEY:page=42" → "1-KEY")
        const colonIdx = itemId.indexOf(':');
        const cleanId = colonIdx !== -1 ? itemId.substring(0, colonIdx) : itemId;

        if (seen.has(cleanId)) return;
        const parsed = parseNoteId(cleanId);
        if (parsed) {
            seen.add(cleanId);
            refs.push(parsed);
        }
    };

    // Match single citations: <citation item_id="LIB-KEY" .../>
    const singleRe = /<citation\s+item_id="([^"]+)"/g;
    let match;
    while ((match = singleRe.exec(simplifiedHtml)) !== null) {
        addRef(match[1]);
    }

    // Match compound citations: <citation items="LIB-KEY1:page=P1, LIB-KEY2" .../>
    const compoundRe = /<citation\s+items="([^"]+)"/g;
    while ((match = compoundRe.exec(simplifiedHtml)) !== null) {
        const itemsStr = match[1];
        for (const part of itemsStr.split(',')) {
            addRef(part.trim());
        }
    }

    return refs;
}

/**
 * Resolve cited item references to ItemSummary[] with attachments.
 */
async function resolveCitedItems(
    refs: { libraryId: number; itemKey: string }[]
): Promise<ItemSummary[]> {
    if (refs.length === 0) return [];

    // Load all cited items
    const items: Zotero.Item[] = [];
    for (const ref of refs) {
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryId, ref.itemKey);
            if (item && item.isRegularItem() && !item.deleted) {
                items.push(item);
            }
        } catch {
            // Skip items that can't be loaded
        }
    }

    if (items.length === 0) return [];

    // Load data types needed for serialization
    await Zotero.Items.loadDataTypes(items, ["primaryData", "itemData", "creators", "tags", "collections", "childItems"]);

    // Build attachment context
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const attachmentContext = {
        searchableLibraryIds,
        syncWithZotero: store.get(syncWithZoteroAtom),
        userId: store.get(userIdAtom),
    };

    // Batch-fetch attachment data
    const batchAttachmentData = await prepareBatchAttachmentData(items, attachmentContext);

    // Serialize items with attachments
    const results: ItemSummary[] = [];
    for (const item of items) {
        try {
            const [itemData, rawAttachments] = await Promise.all([
                serializeItemSummary(item),
                processAttachmentsWithBatchData(item, attachmentContext, batchAttachmentData, { skipHash: true, skipWorkerFallback: true }),
            ]);
            results.push({ ...itemData, attachments: rawAttachments.map(toAttachmentSummary) });
        } catch (error) {
            logger(`resolveCitedItems: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    return results;
}

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
 * Reads a Zotero note's content and returns it in simplified HTML.
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
            if (item.isPDFAttachment()) {
                return errorResponse(
                    `Item ${note_id} is a PDF attachment and not a note. You can read PDF attachments with the read_pages tool.`
                );
            }
            return errorResponse(
                `Item ${note_id} is not a note (type: ${item.itemType})`
            );
        }

        // 4. Load note data
        await item.loadDataType('note');

        // 5. Get raw HTML (reads from open editor if available, to capture unsaved changes)
        const rawHtml = getLatestNoteHtml(item);
        if (!rawHtml || rawHtml.trim() === '') {
            return errorResponse(
                `Note ${note_id} is empty. There is no content to read.`
            );
        }

        // 6. Simplify (also warms cache for subsequent edit_note calls).
        // Pass raw HTML so the cache key matches edit_note's getOrSimplify
        // calls — simplifyNoteHtml normalizes internally, so the cached
        // simplified output is identical either way.
        const { simplified } = getOrSimplify(note_id, rawHtml, item.libraryID);

        // 7. Apply offset/limit pagination
        const lines = simplified.split('\n');
        const totalLines = lines.length;
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit ? Math.min(start + limit, totalLines) : totalLines;
        const slice = lines.slice(start, end);

        const content = slice.join('\n');
        const hasMore = end < totalLines;
        const nextOffset = hasMore ? end + 1 : undefined; // 1-indexed
        const startLine = start + 1;
        const linesReturned = slice.length === 0 ? undefined
            : (startLine === end ? String(startLine) : `${startLine}-${end}`);

        // 8. Gather parent metadata
        let parentItemId: string | undefined;
        let parentTitle: string | undefined;
        if (item.parentItem) {
            await item.parentItem.loadDataType('itemData');
            parentItemId = `${item.parentItem.libraryID}-${item.parentItem.key}`;
            parentTitle = item.parentItem.getField('title') as string;
        }

        // 9. Resolve cited items from the visible slice only
        const citedRefs = extractCitedItemRefs(slice.join('\n'));
        const citedItems = await resolveCitedItems(citedRefs);

        // 10. Return response
        return {
            type: 'read_note',
            request_id,
            success: true,
            note_id,
            title: item.getNoteTitle() || '(untitled)',
            parent_item_id: parentItemId,
            parent_title: parentTitle,
            total_lines: totalLines,
            content,
            has_more: hasMore,
            next_offset: nextOffset,
            lines_returned: linesReturned,
            cited_items: citedItems.length > 0 ? citedItems : undefined,
        };
    } catch (error) {
        logger(`handleReadNoteRequest: Failed for ${note_id}: ${error}`, 1);
        return errorResponse(
            `Failed to read note ${note_id}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
