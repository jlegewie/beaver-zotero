/**
 * Handler for read_note_request events.
 *
 * Returns a Zotero note's content in simplified HTML,
 * warming the simplification cache used by edit_note.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getOrSimplify } from '../../utils/noteHtmlSimplifier';
import { preloadNotePageLabels } from '../../utils/noteCitationExpand';
import { getNoteHtmlForRead } from '../../utils/noteEditorIO';
import { containsPreviewMarkers, stripPreviewMarkers } from '../../utils/notePreviewGuard';
import { buildAddressSnapshot, snapshotNoteId } from '../../utils/noteSnapshot';
import {
    WSReadNoteRequest,
    WSReadNoteResponse,
} from '@beaver/agent-core/protocol/agentProtocol';
import { ItemStub, ItemSummary } from '@beaver/agent-core/types/zotero';
import { serializeItemStub, serializeItemSummary } from '../../utils/zoteroSerializers';
import {
    libraryRefForLibraryID,
    modelObjectId,
    resolveObjectId,
    UNRESOLVED_LIBRARY_ID,
} from '../../utils/libraryIdentity';
import { checkLibraryExcluded, prepareAttachmentInfoBatchData, processAttachmentInfoBatch } from './utils';
import { CITATION_TAG_PATTERN } from '../../../react/utils/citationPreprocessing';
import {
    normalizeCitationTag,
    parseRawCitationAttributes,
    parseZoteroId,
} from '@beaver/agent-core/citations/citationGrammar';
import { getNoteContentPreviewText } from '../../../react/utils/noteText';

const CITED_NOTE_PREVIEW_LENGTH = 500;

/** Maximum simplified note content per page. An indivisible block may exceed it. */
export const READ_NOTE_MAX_CHARS = 40_000;

/**
 * Returns the leading block count within `maxChars`. The first non-empty block
 * is kept whole, while blank-only prefixes remain capped.
 */
function linesWithinCharBudget(lines: string[], maxChars: number): number {
    let used = 0;
    let hasContent = false;
    for (let i = 0; i < lines.length; i++) {
        const cost = lines[i].length + (i === 0 ? 0 : 1);
        if (i > 0 && used + cost > maxChars && (hasContent || used >= maxChars)) {
            return i;
        }
        used += cost;
        hasContent = hasContent || lines[i].length > 0;
    }
    return lines.length;
}

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
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
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
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
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

        // Key on library_ref when available: an unresolved portable ref
        // collapses library_id to UNRESOLVED_LIBRARY_ID, and two refs from
        // different groups would otherwise collide on the same key.
        const key = `${parsed.library_ref ?? parsed.library_id}-${parsed.zotero_key}`;
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
        // Never resolve cited items in libraries the user excluded from Beaver.
        if (checkLibraryExcluded(ref.libraryId)) continue;
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
 * Parse a note_id string (portable "u-KEY" / "g<groupID>-KEY" or legacy
 * "{libraryID}-{itemKey}") into a device-local reference.
 * Returns null if the format is invalid.
 */
function parseNoteId(noteId: string): { libraryId: number; itemKey: string; libraryRef?: string } | null {
    const resolved = resolveObjectId(noteId);
    if (!resolved) return null;
    return { libraryId: resolved.library_id, itemKey: resolved.zotero_key, libraryRef: resolved.library_ref };
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
            `Invalid note_id format: '${note_id}'. Expected '{library}-{itemKey}'.`
        );
    }
    if (parsed.libraryId === UNRESOLVED_LIBRARY_ID) {
        return errorResponse(
            `The library for note ${note_id} (${parsed.libraryRef}) is not available on this computer.`
        );
    }

    // Reject notes in libraries the user excluded from Beaver before any lookup,
    // so an excluded note is never read or confirmed to exist.
    const excluded = checkLibraryExcluded(parsed.libraryId);
    if (excluded) {
        return errorResponse(excluded.message);
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
        let rawHtml = await getNoteHtmlForRead(item);
        if (!rawHtml || rawHtml.trim() === '') {
            return errorResponse(
                `Note ${note_id} is empty. There is no content to read.`
            );
        }
        // Recovery path: if diff-preview markup was ever accidentally
        // persisted into this note, read the stripped content so the model
        // sees the same HTML the edit_note validate/execute paths repair to.
        if (containsPreviewMarkers(rawHtml)) {
            logger(`handleReadNoteRequest: note ${note_id} contains persisted diff-preview markup; reading stripped content`, 1);
            rawHtml = stripPreviewMarkers(rawHtml);
        }

        // 6. Simplify (also warms the cache for a subsequent edit_note_blocks
        // call). The key is built from the RESOLVED item, so a note addressed by
        // a portable id and by a legacy numeric id shares one entry — and it is
        // the same string the address snapshot binds, which is why it must come
        // from `snapshotNoteId` and not be spelled out here.
        //
        // That makes it the PORTABLE "{library_ref}-{itemKey}" form, which the
        // v1 `edit_note`/`edit_note_batch` paths do not use: they still key on
        // the device-local "{resolvedLibraryId}-{zotero_key}". So this read only
        // warms the block-addressed path, and a v1 edit of the same note pays
        // one redundant simplification. Deliberately not "fixed" by keying this
        // read device-locally: `getOrSimplify` re-simplifies on a content-hash
        // miss, so two entries for one note cost work, never correctness — and
        // the snapshot identity has to be portable. Unify by moving the v1 paths
        // onto `snapshotNoteId` too, never by moving this one back.
        //
        // Pass raw HTML, not normalized: `simplifyNoteHtml` normalizes
        // internally, so the cached output is identical either way and every
        // caller can hand over what it already has.
        const cacheNoteId = snapshotNoteId(item.libraryID, item.key);
        const pageLabelsByItemId = await preloadNotePageLabels(rawHtml, item.libraryID, { extractOnCacheMiss: true });
        const { simplified } = getOrSimplify(cacheNoteId, rawHtml, item.libraryID, pageLabelsByItemId);

        // 7. Apply offset/limit pagination.
        //
        // SANITIZE FIRST. `offset`/`limit` are unvalidated `number?` on the wire
        // and reach us verbatim from the MCP and HTTP entry points, so they can
        // be negative, zero, fractional or non-finite. Left raw they corrupt
        // every derived value at once, not just the slice: `limit: -1` gives
        // `end = -1`, and `lines.slice(0, -1)` cheerfully returns all-but-the-
        // last line, so the response ships real content alongside
        // `lines_returned: "1--1"` and `next_offset: 0` — and an offset of 0
        // re-reads the same page forever. Flooring and clamping here makes every
        // line below total, and is why nothing downstream needs a fail-closed
        // branch.
        const lines = simplified.split('\n');
        const totalLines = lines.length;
        const safeOffset = Number.isFinite(offset as number)
            ? Math.max(1, Math.floor(offset as number))
            : 1;
        // `limit` absent — or non-finite, which cannot describe a count — means
        // "to the end". A finite but nonsensical one (0, negative, fractional)
        // clamps to one line rather than zero, so a read always shows something.
        const safeLimit = limit === undefined || limit === null
            ? undefined
            : (Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined);
        // NOT clamped to the last line: an offset past the end honestly returns
        // nothing, which is long-standing behavior and the only answer that does
        // not invent a page the model did not ask for.
        const start = safeOffset - 1;
        const requestedEnd = safeLimit === undefined
            ? totalLines
            : Math.min(start + safeLimit, totalLines);
        const requested = lines.slice(start, requestedEnd);

        // Apply the size ceiling after offset/limit and keep blocks intact.
        const keptLines = linesWithinCharBudget(requested, READ_NOTE_MAX_CHARS);
        const truncated = keptLines < requested.length;
        const slice = truncated ? requested.slice(0, keptLines) : requested;
        const end = start + slice.length;

        const content = slice.join('\n');
        const hasMore = end < totalLines;
        const nextOffset = hasMore ? end + 1 : undefined; // 1-indexed
        const startLine = start + 1;
        const linesReturned = slice.length === 0 ? undefined
            : (startLine === end ? String(startLine) : `${startLine}-${end}`);

        // Address snapshot for edit_note_blocks — ONLY when this response showed
        // the WHOLE note.
        //
        // The digest covers the whole `simplified` string (that is the string
        // whose split('\n') defines the block numbering) plus the note's
        // identity, so a token verifies only against this note in this state.
        // But covering the whole note is exactly why it must not be handed out
        // after a PARTIAL read: it would license numeric addresses into the
        // pages the model never saw, and `expect` cannot catch that on its own.
        // Over half of a typical note's lines have no visible text, and those
        // are confirmed only by their attribute-stripped tag — one `</ul>`
        // matches every other `</ul>` in the note — while a ranged `delete`
        // confirms only its two endpoints and never its interior. See
        // `matchExpect` in editNoteBlocksCore.ts, which documents that `expect`
        // is a per-block sanity check and not an addressing guard.
        //
        // So a paged read is for READING. To edit by block number, read the note
        // whole; that single rule replaces the per-response read window this
        // token used to carry, and is the same policy the backend applies when
        // it withholds a snapshot alongside a listing it could not show.
        const showedWholeNote = slice.length === totalLines;
        const snapshot = showedWholeNote
            ? buildAddressSnapshot(cacheNoteId, simplified)
            : undefined;

        // 8. Gather parent metadata
        let parentItemId: string | undefined;
        let parentTitle: string | undefined;
        let parentSummary: ItemStub | undefined;
        if (item.parentItem) {
            await Zotero.Items.loadDataTypes([item.parentItem], ['primaryData', 'itemData', 'creators']);
            parentItemId = modelObjectId(item.parentItem.libraryID, item.parentItem.key);
            parentTitle = item.parentItem.getField('title') as string;
            parentSummary = serializeItemStub(item.parentItem);
        }

        // 9. Resolve cited items from the visible content only
        const citedRefs = extractCitedItemRefs(content);
        const citedItems = await resolveCitedItems(citedRefs);

        // 10. Return response
        return {
            type: 'read_note',
            request_id,
            success: true,
            note_id,
            library_id: item.libraryID,
            zotero_key: item.key,
            library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
            title: item.getNoteTitle() || '(untitled)',
            parent_item_id: parentItemId,
            parent_title: parentTitle,
            parent_item: parentSummary,
            total_lines: totalLines,
            content,
            has_more: hasMore,
            next_offset: nextOffset,
            lines_returned: linesReturned,
            truncated: truncated || undefined,
            snapshot,
            cited_items: citedItems.length > 0 ? citedItems : undefined,
        };
    } catch (error) {
        logger(`handleReadNoteRequest: Failed for ${note_id}: ${error}`, 1);
        return errorResponse(
            `Failed to read note ${note_id}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
