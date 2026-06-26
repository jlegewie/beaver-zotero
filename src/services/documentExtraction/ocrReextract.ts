/**
 * Re-extract OCR'd PDF bytes and cache the result against the original
 * attachment's on-disk identity.
 *
 * The OCR microservice returns a *searchable* PDF (the original page image plus
 * an invisible, positioned text layer). That PDF is consumed transiently: we run
 * Beaver Extract on its bytes, store the resulting `StructuredDocument` in the
 * document cache, and discard the bytes. Citations and annotations are
 * coordinate-driven, so this verifies that the OCR PDF preserves the original
 * page geometry before writing to the cache.
 *
 * The cache entry is keyed to the original file's on-disk signature (path +
 * mtime + size), so every later read is a cache hit that serves the OCR-derived
 * content without re-reading the image-only original. Both extraction modes are
 * populated so either read path can use the OCR-derived cache entry.
 *
 * This module is bundle-neutral (no Supabase / React imports) so it can run on
 * the esbuild background lane.
 */

import {
    ExtractionError,
    ExtractionErrorCode,
    getMuPDFWorkerClient,
    type PDFWorkerSlotName,
} from '../../beaver-extract';
import type { BeaverExtractResult } from '../../beaver-extract/schema';
import type { PageGeometry } from '../../beaver-extract/types';
import type { DocumentCacheExtractionMode } from '../database';
import { buildExtractedDocumentCacheMetadata } from '../documentExtractionCore';
import { logger } from '../../utils/logger';

/** Extraction modes populated so neither read path re-extracts the original. */
const OCR_REEXTRACT_MODES: DocumentCacheExtractionMode[] = ['structured', 'markdown'];

/** Page box/size tolerance, in PDF points, for the geometry invariant. */
const GEOMETRY_TOLERANCE_PT = 1;

export type OcrReextractResult =
    /** OCR text extracted and cached against the original identity. */
    | { kind: 'ok'; pageCount: number }
    /** Extraction still found no usable text layer (loop-guard terminal). */
    | { kind: 'no_text' }
    /** OCR'd PDF geometry diverges from the original. */
    | { kind: 'geometry_mismatch'; detail: string }
    /** The document cache or original file could not be resolved. */
    | { kind: 'unavailable'; reason: string }
    /** Caller aborted (window closing / lease expiry). */
    | { kind: 'aborted' }
    /** Transient extraction failure; caller may retry. */
    | { kind: 'error'; message: string };

export interface ExtractOcrBytesArgs {
    /** Original attachment whose on-disk identity keys the cache entry. */
    item: Zotero.Item;
    /**
     * Original on-disk PDF path, resolved by the caller so it matches the path
     * the read path resolves (the document-cache key).
     */
    filePath: string;
    /** Searchable PDF bytes returned by the OCR microservice. */
    ocrBytes: Uint8Array;
    /** Page count from the original no-text-layer detection; enforced 1:1. */
    expectedPageCount: number | null;
    /** MuPDF worker slot. The background lane passes `'background'`. */
    workerName?: PDFWorkerSlotName;
    abortSignal?: AbortSignal;
}

/**
 * Extract `ocrBytes` and cache the result under the original attachment's
 * identity, after verifying the geometry invariant.
 */
export async function extractPdfBytesAndCacheAsOriginalAttachment(
    args: ExtractOcrBytesArgs,
): Promise<OcrReextractResult> {
    const { item, filePath, ocrBytes, expectedPageCount, abortSignal } = args;
    const workerName = args.workerName ?? 'background';

    const cache = Zotero.Beaver?.documentCache;
    if (!cache) {
        return { kind: 'unavailable', reason: 'document_cache_unavailable' };
    }

    const docRef = { libraryId: item.libraryID, zoteroKey: item.key };

    // Snapshot the original's on-disk identity once. Every payload is written
    // under this snapshot so a file that changes mid-OCR cannot get OCR content
    // stamped against the new bytes.
    let sourceIdentity;
    try {
        sourceIdentity = await cache.getSourceIdentitySnapshot(filePath);
    } catch (error) {
        logger(`extractPdfBytesAndCacheAsOriginalAttachment: source identity snapshot failed: ${error}`, 1);
        return { kind: 'unavailable', reason: 'source_identity_unavailable' };
    }

    // Use original page geometry when available; otherwise enforce page count.
    const originalMeta = await cache.getMetadata(docRef, filePath).catch(() => null);
    const originalPages = originalMeta?.pages ?? null;

    const client = getMuPDFWorkerClient(workerName);
    const maxSourceSizeBytes = sourceIdentity.sourceSizeBytes > 0
        ? sourceIdentity.sourceSizeBytes
        : undefined;

    let primaryPageCount: number | null = null;

    for (const mode of OCR_REEXTRACT_MODES) {
        if (abortSignal?.aborted) return { kind: 'aborted' };

        let extracted: BeaverExtractResult;
        try {
            extracted = await client.extract(
                ocrBytes,
                { mode, settings: { checkTextLayer: true } },
                abortSignal,
            );
        } catch (error) {
            if (error instanceof ExtractionError && error.code === ExtractionErrorCode.NO_TEXT_LAYER) {
                // The OCR layer produced no usable text. Structured is the
                // primary mode, so treat its absence as terminal for this engine.
                // A later mode failing after structured succeeded is unexpected;
                // surface it the same way so we don't cache a half-readable doc.
                return { kind: 'no_text' };
            }
            if (abortSignal?.aborted) return { kind: 'aborted' };
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'error', message: `${mode}_extract_failed: ${message}` };
        }

        // Page count and per-page box/rotation must match the original so
        // coordinate-based citations and highlights stay aligned.
        const geometryError = checkGeometryInvariant(
            extracted,
            expectedPageCount,
            originalPages,
        );
        if (geometryError) {
            return { kind: 'geometry_mismatch', detail: geometryError };
        }

        try {
            await cache.putResult({
                item,
                filePath,
                mode,
                sourceSizeBytes: 0,
                contentType: item.attachmentContentType || 'application/pdf',
                result: extracted,
                metadata: buildExtractedDocumentCacheMetadata(extracted),
                expectedSourceIdentity: sourceIdentity,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'error', message: `${mode}_cache_write_failed: ${message}` };
        }

        if (primaryPageCount == null) {
            primaryPageCount = extracted.document.pageCount;
        }
    }

    return { kind: 'ok', pageCount: primaryPageCount ?? expectedPageCount ?? 0 };
}

/**
 * Compare the OCR'd document's geometry to the original. Returns a human
 * description on mismatch, or null when geometry is preserved.
 */
function checkGeometryInvariant(
    extracted: BeaverExtractResult,
    expectedPageCount: number | null,
    originalPages: (PageGeometry | null)[] | null,
): string | null {
    const ocrPageCount = extracted.document.pageCount;
    if (expectedPageCount != null && ocrPageCount !== expectedPageCount) {
        return `page_count ${ocrPageCount} != original ${expectedPageCount}`;
    }

    if (!originalPages) return null;
    if (originalPages.length !== ocrPageCount) {
        return `page_count ${ocrPageCount} != original_geometry ${originalPages.length}`;
    }

    const ocrPages = buildExtractedDocumentCacheMetadata(extracted).pages;
    for (let i = 0; i < originalPages.length; i += 1) {
        const original = originalPages[i];
        const ocr = ocrPages[i];
        if (!original || !ocr) continue;
        if (original.rotation !== ocr.rotation) {
            return `page ${i} rotation ${ocr.rotation} != original ${original.rotation}`;
        }
        if (Math.abs(original.width - ocr.width) > GEOMETRY_TOLERANCE_PT) {
            return `page ${i} width ${ocr.width} != original ${original.width}`;
        }
        if (Math.abs(original.height - ocr.height) > GEOMETRY_TOLERANCE_PT) {
            return `page ${i} height ${ocr.height} != original ${original.height}`;
        }
    }
    return null;
}
