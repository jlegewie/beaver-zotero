import type { DocumentExtractResult } from '@beaver/agent-core/extract/document/shared/documentExtractResult';
import type { DomDocument } from '@beaver/agent-core/extract/document/dom/schema';
import type { BeaverExtractResult } from '@beaver/agent-core/extract/schema';
import { logger } from '@beaver/agent-core/platform/logger';
import { getMuPDFWorkerClient } from '../../beaver-extract/MuPDFWorkerClient';
import type { AttachmentProcessingStateRecord } from '../database';
import type { FileSignature } from '../documentFileIdentity';
import { deriveEmbeddingText, EMBEDDING_TEXT_VERSION, type EmbeddingTextSource } from './embeddingText';

type EmbeddableKind = AttachmentProcessingStateRecord['contentKind'];

/**
 * Derive topic text from a structured extraction, store it for the attachment
 * and ask the embedding index to recompute the units that may use it.
 *
 * The text depends only on the file (no bibliographic title is passed), so it
 * stays valid when the attachment moves to another parent. Returns false when
 * the document is not a structured extraction.
 */
export async function storeEmbeddingText(args: {
    db: Pick<NonNullable<typeof Zotero.Beaver.db>, 'upsertAttachmentEmbeddingText'>;
    item: Zotero.Item;
    kind: EmbeddableKind;
    document: DocumentExtractResult;
    fileSignature: FileSignature;
    /** Content hash of the file; the only identity of a remote-only file. */
    fileHash: string | null;
    extractionSource: 'native' | 'ocr';
    /** PDF Info dictionary title. */
    pdfTitle?: string | null;
}): Promise<boolean> {
    let source: EmbeddingTextSource;
    if (args.kind === 'pdf') {
        // PDF results are not stamped with a content kind; the mode identifies them.
        const pdf = args.document as BeaverExtractResult;
        if (pdf.mode !== 'structured') return false;
        source = { contentKind: 'pdf', document: pdf.document, pdfTitle: args.pdfTitle };
    } else {
        if (args.document.content_kind !== args.kind) return false;
        source = { contentKind: args.kind, document: args.document as DomDocument };
    }
    const derived = deriveEmbeddingText(source);
    await args.db.upsertAttachmentEmbeddingText({
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
    });
    Zotero.Beaver?.background?.markEmbeddingDirty([args.item.id]);
    return true;
}

/**
 * Drop derived text that describes an earlier version of the attachment's file,
 * after the current file yielded no text (e.g. a scan awaiting OCR).
 */
export async function clearStaleEmbeddingText(args: {
    db: Pick<NonNullable<typeof Zotero.Beaver.db>, 'deleteAttachmentEmbeddingTextUnlessFile'>;
    item: Zotero.Item;
    fileSignature: FileSignature;
    fileHash: string | null;
}): Promise<void> {
    const file = { ...args.fileSignature, hash: args.fileHash };
    if (await args.db.deleteAttachmentEmbeddingTextUnlessFile(args.item.libraryID, args.item.key, file)) {
        Zotero.Beaver?.background?.markEmbeddingDirty([args.item.id]);
    }
}

/**
 * Read the PDF Info dictionary title on the background worker. Call it inside
 * the MuPDF lane. Best-effort: returns null on any failure.
 */
export async function readPdfInfoTitle(
    pdf: string | Uint8Array,
    signal?: AbortSignal,
): Promise<string | null> {
    try {
        const bytes = typeof pdf === 'string' ? await IOUtils.read(pdf) : pdf;
        const info = await getMuPDFWorkerClient('background').getDocumentInfo(bytes, signal);
        return info.title?.trim() || null;
    } catch (error) {
        logger(`readPdfInfoTitle: ${error}`, 3);
        return null;
    }
}
