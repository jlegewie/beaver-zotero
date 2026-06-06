/**
 * Handler for read_note_request events.
 *
 * Returns a Zotero note's content in simplified HTML,
 * warming the simplification cache used by edit_note.
 */

import { logger } from '../../utils/logger';
import { getOrSimplify } from '../../utils/noteHtmlSimplifier';
import { getNoteHtmlForRead } from '../../utils/noteEditorIO';
import {
    WSReadNoteRequest,
    WSReadNoteResponse,
} from '../agentProtocol';
import { ItemSummary } from '../../../react/types/zotero';
import { serializeItemSummary } from '../../utils/zoteroSerializers';
import { prepareAttachmentInfoBatchData, processAttachmentInfoBatch } from './utils';
import { CITATION_TAG_PATTERN } from '../../../react/utils/citationPreprocessing';
import {
    normalizeCitationTag,
    parseRawCitationAttributes,
    parseZoteroId,
} from '../../../react/utils/citationGrammar';
import { getNoteContentPreviewText } from '../../../react/utils/noteText';

const CITED_NOTE_PREVIEW_LENGTH = 500;

function isAnnotationItem(item: Zotero.Item): boolean {
    return String(item.itemType) === 'annotation' || (item as { isAnnotation?: () => boolean }).isAnnotation?.() === true;
}

function annotationSnippet(item: Zotero.Item): string | null {
    const annotation = item as any;
    return annotation.annotationText || annotation.annotationComment || null;
}

function serializeNoteCitationSummary(item: Zotero.Item): ItemSummary {
    const noteHtml = item.getNote?.() || '';
    const title = item.getNoteTitle?.() || 'Untitled Note';
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        item_type: 'note',
        title,
        preview: getNoteContentPreviewText(noteHtml, title, CITED_NOTE_PREVIEW_LENGTH),
    };
}

function serializeAnnotationCitationSummary(item: Zotero.Item): ItemSummary {
    const annotation = item as any;
    const snippet = annotationSnippet(item);
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        item_type: 'annotation',
        title: snippet ? `Annotation: ${snippet}` : 'Annotation',
        annotation_text: annotation.annotationText || null,
        annotation_comment: annotation.annotationComment || null,
        page_label: annotation.annotationPageLabel || null,
        parent_key: annotation.parentKey || annotation.parentItem?.key || null,
    };
}

/**
 * Extract unique cited item references from simplified note HTML.
 * Parses unified and legacy single citations plus compound citations
 * (`<citation items="LIB-KEY1, LIB-KEY2" .../>`).
 * Returns deduplicated array of { libraryId, itemKey } pairs.
 */
function extractCitedItemRefs(simplifiedHtml: string): { libraryId: number; itemKey: string }[] {
    const seen = new Set<string>();
    const refs: { libraryId: number; itemKey: string }[] = [];

    const addRef = (itemId: string) => {
        // Strip compound locator suffix (e.g., "1-KEY:page=42" -> "1-KEY").
        const colonIdx = itemId.indexOf(':');
        const cleanId = (colonIdx !== -1 ? itemId.substring(0, colonIdx) : itemId).trim();

        const parsed = parseZoteroId(cleanId);
        if (!parsed) return;

        const key = `${parsed.library_id}-${parsed.zotero_key}`;
        if (seen.has(key)) return;
        seen.add(key);
        refs.push({ libraryId: parsed.library_id, itemKey: parsed.zotero_key });
    };

    CITATION_TAG_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = CITATION_TAG_PATTERN.exec(simplifiedHtml)) !== null) {
        const rawAttrs = parseRawCitationAttributes(match[1] || '');

        // Attachment-to-parent cited_items resolution is out of v0.20 scope.
        if (rawAttrs.att_id || rawAttrs.attachment_id) continue;

        const normalized = normalizeCitationTag(rawAttrs);
        if (normalized.ok && normalized.ref.kind === 'zotero') {
            addRef(`${normalized.ref.library_id}-${normalized.ref.zotero_key}`);
            continue;
        }

        if (rawAttrs.items) {
            for (const part of rawAttrs.items.split(',')) {
                addRef(part);
            }
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

    // Load all cited items and keep the final output in citation order.
    const items: Zotero.Item[] = [];
    for (const ref of refs) {
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryId, ref.itemKey);
            if (item && !item.deleted && (item.isRegularItem?.() || item.isNote?.() || isAnnotationItem(item))) {
                items.push(item);
            }
        } catch {
            // Skip items that can't be loaded
        }
    }

    if (items.length === 0) return [];

    const regularItems = items.filter(item => item.isRegularItem?.() === true);
    const noteItems = items.filter(item => item.isNote?.() === true);
    const annotationItems = items.filter(item => isAnnotationItem(item));

    if (noteItems.length > 0) {
        await Zotero.Items.loadDataTypes(noteItems, ["itemData", "note"]);
    }
    if (annotationItems.length > 0) {
        await Zotero.Items.loadDataTypes(annotationItems, ["annotation", "annotationDeferred"]);
    }

    const regularSummaries = new Map<Zotero.Item, ItemSummary>();
    // Load data types needed for serialization
    if (regularItems.length > 0) {
        await Zotero.Items.loadDataTypes(regularItems, ["primaryData", "itemData", "creators", "tags", "collections", "childItems"]);

        // Batch-fetch attachment data
        const batchAttachmentData = await prepareAttachmentInfoBatchData(regularItems);

        for (const item of regularItems) {
            try {
                const [itemData, attachments] = await Promise.all([
                    serializeItemSummary(item),
                    processAttachmentInfoBatch(item, batchAttachmentData, {
                        skipWorkerFallback: true,
                        includeAnnotationsCount: true,
                    }),
                ]);
                regularSummaries.set(item, { ...itemData, attachments });
            } catch (error) {
                logger(`resolveCitedItems: Failed to serialize item ${item.key}: ${error}`, 1);
            }
        }
    }

    const results: ItemSummary[] = [];
    for (const item of items) {
        if (item.isRegularItem?.() === true) {
            const summary = regularSummaries.get(item);
            if (summary) results.push(summary);
        } else if (item.isNote?.() === true) {
            results.push(serializeNoteCitationSummary(item));
        } else if (isAnnotationItem(item)) {
            results.push(serializeAnnotationCitationSummary(item));
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

        // 5. Get raw HTML — read-only path. Prefers a non-empty live editor
        //    snapshot (so unsaved typing is visible to the agent) and falls
        //    back to item.getNote() when the live snapshot is empty. Critically
        //    NEVER calls item.setNote() — flushLiveEditorToDB would persist a
        //    transient empty PM-render snapshot and erase the note's content.
        const rawHtml = await getNoteHtmlForRead(item);
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
