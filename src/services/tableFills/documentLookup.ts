/**
 * What Zotero says about a fill's item rows, from metadata only: whether the
 * item is there and readable by Beaver, its abstract, and its readable
 * document attachments. No file is opened.
 */

import type { Row } from '@beaver/agent-core/layouts/table';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { getBestAttachmentBatch } from '../documentExtraction/attachmentInfoBatch';
import { isLibrarySearchable } from '../agentDataProvider/utils';
import { libraryRefForLibraryID, parseItemReference, resolveLibraryRef } from '../../utils/libraryIdentity';
import { isRowDocumentKind, type DocumentCandidate, type RowLookup } from './planner';

const LOOKUP_CHUNK = 200;

/** The local library of an item row, or null when this device has none. */
export function rowLibraryID(row: Pick<Row, 'ref'>): number | null {
    const ref = row.ref;
    if (ref?.kind !== 'item') return null;
    return resolveLibraryRef({ library_ref: ref.library_ref, library_id: ref.library_id });
}

/**
 * Whether a fill may send the row off the device: an item from a library
 * Beaver may read, or an external work.
 */
export function rowSendable(row: Pick<Row, 'ref'>): boolean {
    if (row.ref?.kind !== 'item') return true;
    const libraryID = rowLibraryID(row);
    return libraryID != null && isLibrarySearchable(libraryID);
}

/** Whether a fill may send a document off the device: an attachment in a library Beaver may read. */
export function documentSendable(documentId: string): boolean {
    const parsed = parseItemReference(documentId);
    if (!parsed) return false;
    const libraryID = resolveLibraryRef(parsed);
    return libraryID != null && isLibrarySearchable(libraryID);
}

/** Looks up the item rows, in chunks. */
export async function lookupRowDocuments(rows: readonly Row[]): Promise<Map<string, RowLookup>> {
    const out = new Map<string, RowLookup>();
    for (let start = 0; start < rows.length; start += LOOKUP_CHUNK) {
        await lookupChunk(rows.slice(start, start + LOOKUP_CHUNK), out);
    }
    return out;
}

async function lookupChunk(rows: readonly Row[], out: Map<string, RowLookup>): Promise<void> {
    const items = new Map<string, Zotero.Item>();
    for (const row of rows) {
        const ref = row.ref;
        if (ref?.kind !== 'item') continue;
        const libraryID = rowLibraryID(row);
        if (libraryID == null || !Zotero.Libraries.exists(libraryID)) {
            out.set(row.id, { error: 'library_unavailable', documents: [] });
            continue;
        }
        if (!isLibrarySearchable(libraryID)) {
            out.set(row.id, { error: 'library_excluded', documents: [] });
            continue;
        }
        const item = (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.zotero_key)) as Zotero.Item | false;
        if (!item || item.deleted || !item.isRegularItem()) {
            out.set(row.id, { error: 'item_not_found', documents: [] });
            continue;
        }
        items.set(row.id, item);
    }
    if (!items.size) return;
    const parents = [...items.values()];
    await Zotero.Items.loadDataTypes(parents, ['itemData', 'childItems']);
    const attachmentIds = parents.flatMap((item) => item.getAttachments(false) as number[]);
    const attachments = (await Zotero.Items.getAsync(attachmentIds)) as Zotero.Item[];
    if (attachments.length) await Zotero.Items.loadDataTypes(attachments, ['itemData']);
    const byId = new Map(attachments.filter(Boolean).map((attachment) => [attachment.id, attachment]));
    const primary = await getBestAttachmentBatch(parents.map((item) => item.id));
    for (const [rowId, item] of items) {
        const libraryRef = libraryRefForLibraryID(item.libraryID) ?? String(item.libraryID);
        const documents: DocumentCandidate[] = [];
        for (const id of item.getAttachments(false) as number[]) {
            const attachment = byId.get(id);
            if (!attachment || attachment.deleted) continue;
            const kind = getReadableContentKind(attachment);
            if (!isRowDocumentKind(kind)) continue;
            documents.push({
                id: `${libraryRef}-${attachment.key}`,
                kind,
                primary: primary.get(item.id) === attachment.id,
            });
        }
        const abstract = (item.getField('abstractNote') as string) || undefined;
        out.set(rowId, { documents, ...(abstract ? { abstract } : {}) });
    }
}
