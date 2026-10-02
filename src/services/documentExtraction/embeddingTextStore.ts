import type { DocumentExtractResult } from '@beaver/agent-core/extract/document/shared/documentExtractResult';
import type { DomDocument } from '@beaver/agent-core/extract/document/dom/schema';
import type { BeaverExtractResult } from '@beaver/agent-core/extract/schema';
import {
    attachmentRefKey,
    type AttachmentEmbeddingTextRecord,
    type AttachmentProcessingStateRecord,
    type BeaverDB,
} from '../database';
import type { FileSignature } from '../documentFileIdentity';
import { needsDerivedText } from '../embeddingUnits';
import { deriveEmbeddingText, EMBEDDING_TEXT_VERSION, type EmbeddingTextSource } from './embeddingText';

type EmbeddableKind = AttachmentProcessingStateRecord['contentKind'];

/** Whether a unit using this row would embed different text than with the previous row. */
function changesUnitText(
    previous: AttachmentEmbeddingTextRecord | undefined,
    next: Pick<AttachmentEmbeddingTextRecord, 'keywords' | 'body' | 'bodySource' | 'extractionSource'>,
): boolean {
    return !previous
        || previous.keywords !== next.keywords
        || previous.body !== next.body
        || previous.bodySource !== next.bodySource
        // Decides whether an outline is usable.
        || previous.extractionSource !== next.extractionSource;
}

/**
 * Whether any unit can use this attachment's text: its parent needs derived text,
 * or a unit already embeds text from it. Units that cannot use it now pick it up
 * when their own change event recomputes them. Unknown means yes.
 */
async function mayAffectUnits(
    db: Pick<BeaverDB, 'getUnitIdsBySourceAttachment'>,
    attachment: Zotero.Item,
): Promise<boolean> {
    try {
        if (attachment.parentID) {
            const parent = await Zotero.Items.getAsync(attachment.parentID);
            if (parent) {
                await parent.loadDataType('itemData');
                if (needsDerivedText(parent)) return true;
            }
        }
        return (await db.getUnitIdsBySourceAttachment([attachment.id])).length > 0;
    } catch {
        return true;
    }
}

/**
 * Derive topic text from a structured extraction and store it for the
 * attachment. When the text a unit would embed changed and a unit can use it,
 * ask the embedding index to recompute the affected units; re-extractions that
 * yield the same text do not.
 *
 * The text depends only on the file (no bibliographic title is passed), so it
 * stays valid when the attachment moves to another parent. Returns false when
 * the document is not a structured extraction.
 */
export async function storeEmbeddingText(args: {
    db: Pick<BeaverDB, 'getAttachmentEmbeddingTexts' | 'getUnitIdsBySourceAttachment' | 'upsertAttachmentEmbeddingText'>;
    item: Zotero.Item;
    kind: EmbeddableKind;
    document: DocumentExtractResult;
    fileSignature: FileSignature;
    /** Content hash of the file; the only identity of a remote-only file. */
    fileHash: string | null;
    extractionSource: 'native' | 'ocr';
}): Promise<boolean> {
    let source: EmbeddingTextSource;
    if (args.kind === 'pdf') {
        // PDF results are not stamped with a content kind; the mode identifies them.
        const pdf = args.document as BeaverExtractResult;
        if (pdf.mode !== 'structured') return false;
        source = { contentKind: 'pdf', document: pdf.document, pdfTitle: pdf.infoTitle };
    } else {
        if (args.document.content_kind !== args.kind) return false;
        source = { contentKind: args.kind, document: args.document as DomDocument };
    }
    const derived = deriveEmbeddingText(source);
    const record = {
        libraryId: args.item.libraryID,
        zoteroKey: args.item.key,
        itemId: args.item.id,
        contentKind: args.kind,
        fileMtimeMs: args.fileSignature.mtime_ms,
        fileSizeBytes: args.fileSignature.size_bytes,
        fileHash: args.fileHash,
        extractionSource: args.extractionSource,
        textVersion: EMBEDDING_TEXT_VERSION,
        title: derived.title,
        titleSource: derived.titleSource,
        keywords: derived.keywords,
        body: derived.body,
        bodySource: derived.bodySource,
    };
    const ref = { libraryId: record.libraryId, zoteroKey: record.zoteroKey };
    const previous = (await args.db.getAttachmentEmbeddingTexts([ref]))
        .get(attachmentRefKey(ref.libraryId, ref.zoteroKey));
    const markPending = changesUnitText(previous, record) && await mayAffectUnits(args.db, args.item);
    await args.db.upsertAttachmentEmbeddingText(record, Date.now(), markPending);
    if (markPending) Zotero.Beaver?.background?.markEmbeddingDirty([args.item.id]);
    return true;
}

/**
 * Drop derived text that describes an earlier version of the attachment's file,
 * after the current file yielded no text (e.g. a scan awaiting OCR).
 */
export async function clearStaleEmbeddingText(args: {
    db: Pick<BeaverDB, 'deleteAttachmentEmbeddingTextUnlessFile'>;
    item: Zotero.Item;
    fileSignature: FileSignature;
    fileHash: string | null;
}): Promise<void> {
    const file = { ...args.fileSignature, hash: args.fileHash };
    if (await args.db.deleteAttachmentEmbeddingTextUnlessFile(args.item.libraryID, args.item.key, file)) {
        Zotero.Beaver?.background?.markEmbeddingDirty([args.item.id]);
    }
}
