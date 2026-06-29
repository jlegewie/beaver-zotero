import { BeaverExtractor, ExtractionError, ExtractionErrorCode, isTransientWorkerError } from '../../beaver-extract';
import { logger } from '../../utils/logger';
import { getPref } from '../../utils/prefs';
import { isAttachmentAvailableRemotely } from '../../utils/webAPI';
import { effectiveMaxFileSizeMB } from '../attachmentLimits';
import { isRemoteFilePath, makeRemoteFilePath } from '../documentFileIdentity';
import { getContentKind } from './attachmentResolution';
import { isReadableContentKind, type AttachmentInfo, type ContentKind } from './shared/contentKinds';
import { getPDFPageCountFromFulltext, getPDFPageCountFromWorker } from './shared/pageCount';
import type { TimingAccumulator } from '../../utils/timing';

export interface AttachmentInfoOptions {
    parentItemId?: string | null;
    isPrimary?: boolean;
    includeAnnotationsCount?: boolean;
    skipWorkerFallback?: boolean;
    nonPdfReadableEnabled?: boolean;
    /**
     * PDF analysis depth. 'full' reads file bytes and checks OCR needs on a
     * cache miss; 'lightweight' uses cheap page-count probes only.
     */
    pdfAnalysis?: 'full' | 'lightweight';
    timing?: TimingAccumulator;
}


type FileStatusCodeValue =
    | 'unsupported_file_type'
    | 'file_not_local'
    | 'file_not_local_remote'
    | 'file_too_large'
    | 'pdf_encrypted'
    | 'pdf_invalid'
    | 'pdf_needs_ocr'
    | 'pdf_parser_crash'
    | 'pdf_analysis_error'
    | 'pdf_unreadable'
    | 'epub_invalid'
    | 'epub_no_text';

type AttachmentAvailabilityResult =
    | { available: false; status_code?: FileStatusCodeValue | null; status_reason?: string | null; fileExistsLocally?: boolean }
    | { available: true; filePath: string; contentType: string };

function attachmentId(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

function defaultParentItemId(item: Zotero.Item): string | null {
    return item.parentKey ? `${item.libraryID}-${item.parentKey}` : null;
}

function contentKindLabel(kind: ContentKind): string {
    return kind.replace('_', ' ');
}

function unreadableTypeReason(kind: ContentKind): string {
    if (kind === 'linked_url') {
        return 'Linked URL attachments are web links, not stored files Beaver can read.';
    }
    if (kind === 'image') {
        return 'Image attachments cannot be read as text.';
    }
    if (isReadableContentKind(kind)) {
        return `Beaver cannot yet read ${contentKindLabel(kind)} attachments.`;
    }
    return `Beaver cannot read ${contentKindLabel(kind)} attachments.`;
}

async function checkAttachmentAvailability(
    attachment: Zotero.Item,
): Promise<AttachmentAvailabilityResult> {
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        if (isRemoteAccessAvailable(attachment)) {
            return {
                available: true,
                filePath: makeRemoteFilePath(attachment),
                contentType: attachment.attachmentContentType || 'application/octet-stream',
            };
        }
        const isFileAvailableOnServer = isAttachmentAvailableRemotely(attachment);
        return {
            available: false,
            fileExistsLocally: false,
            status_code: isFileAvailableOnServer ? 'file_not_local_remote' : 'file_not_local',
        };
    }

    if (!isRemoteFilePath(filePath)) {
        const maxFileSizeMB = effectiveMaxFileSizeMB();
        try {
            const stat = await IOUtils.stat(filePath);
            const fileSizeInMB = (stat.size ?? 0) / 1024 / 1024;
            if (fileSizeInMB > maxFileSizeMB) {
                return {
                    available: false,
                    fileExistsLocally: true,
                    status_code: 'file_too_large',
                    status_reason: `File size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit.`,
                };
            }
        } catch (error) {
            logger(`getAttachmentInfo: IOUtils.stat failed for ${filePath}: ${error}`, 2);
            if (isRemoteAccessAvailable(attachment)) {
                return {
                    available: true,
                    filePath: makeRemoteFilePath(attachment),
                    contentType: attachment.attachmentContentType || 'application/octet-stream',
                };
            }
            const isFileAvailableOnServer = isAttachmentAvailableRemotely(attachment);
            return {
                available: false,
                fileExistsLocally: false,
                status_code: isFileAvailableOnServer ? 'file_not_local_remote' : 'file_not_local',
            };
        }
    }

    return {
        available: true,
        filePath,
        contentType: attachment.attachmentContentType || 'application/octet-stream',
    };
}

function isRemoteAccessAvailable(item: Zotero.Item): boolean {
    return getPref('accessRemoteFiles') && isAttachmentAvailableRemotely(item);
}

function statusFromCachedPdf(
    record: { errorCode: string | null; pageCount: number | null },
): Pick<AttachmentInfo, 'status' | 'status_code' | 'page_count'> {
    if (record.errorCode === 'encrypted') {
        return { page_count: null, status: 'unreadable', status_code: 'pdf_encrypted' };
    }
    if (record.errorCode === 'invalid_pdf') {
        return { page_count: null, status: 'unreadable', status_code: 'pdf_invalid' };
    }
    if (record.errorCode === 'no_text_layer') {
        return { page_count: record.pageCount, status: 'unreadable', status_code: 'pdf_needs_ocr' };
    }
    return { page_count: record.pageCount, status: 'readable' };
}

async function getCheapPdfPageCount(
    attachment: Zotero.Item,
    filePath: string,
    skipWorkerFallback: boolean,
): Promise<number | null> {
    let pageCount = await getPDFPageCountFromFulltext(attachment);
    if (pageCount === null && !skipWorkerFallback && !isRemoteFilePath(filePath)) {
        pageCount = await getPDFPageCountFromWorker(attachment);
    }
    return pageCount;
}

/**
 * Retry limits for transient PDF analysis failures. Heap exhaustion gets fewer
 * attempts because each retry starts with a fresh worker but remains expensive.
 */
const PDF_ANALYSIS_MAX_ATTEMPTS = 3;
const PDF_HEAP_EXHAUSTION_MAX_ATTEMPTS = 2;
const PDF_ANALYSIS_RETRY_BACKOFF_MS = [400, 1200];
const PDF_ANALYSIS_TOTAL_BUDGET_MS = 8000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHeapExhaustion(error: unknown): boolean {
    return error instanceof ExtractionError
        && error.code === ExtractionErrorCode.HEAP_EXHAUSTION;
}

async function resolvePdfInfo(
    attachment: Zotero.Item,
    availability: Extract<AttachmentAvailabilityResult, { available: true }>,
    options: AttachmentInfoOptions,
): Promise<Pick<AttachmentInfo, 'status' | 'status_code' | 'status_reason' | 'page_count'>> {
    const cache = Zotero.Beaver?.documentCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata({
                libraryId: attachment.libraryID,
                zoteroKey: attachment.key,
            }, availability.filePath);
            // Only consume PDF-shaped rows: an EPUB row's null errorCode/pageCount
            // would otherwise read as a readable PDF with unknown pages.
            if (cached && cached.contentKind === 'pdf') {
                return statusFromCachedPdf(cached);
            }
        } catch (error) {
            logger(`getAttachmentInfo: cache read error: ${error}`, 1);
        }
    }

    if (options.pdfAnalysis === 'lightweight') {
        const pageCount = await getCheapPdfPageCount(
            attachment,
            availability.filePath,
            options.skipWorkerFallback ?? false,
        );
        if (pageCount === null) {
            if (options.skipWorkerFallback || isRemoteFilePath(availability.filePath)) {
                // Optimistic: the file exists and is the right type; it is
                // just not fulltext-indexed yet (or remote-only, so the page
                // count is determined on download).
                return { page_count: null, status: 'readable' };
            }
            // Both cheap probes failed — the PDF is likely encrypted,
            // corrupted, or unparseable.
            return { page_count: null, status: 'unreadable', status_code: 'pdf_unreadable' };
        }
        return { page_count: pageCount, status: 'readable' };
    }

    if (options.skipWorkerFallback) {
        const pageCount = await getCheapPdfPageCount(attachment, availability.filePath, true);
        return { page_count: pageCount, status: 'readable' };
    }

    // Full analysis reads bytes once and reuses them across bounded worker
    // retries; worker posts copy the data without detaching it.
    const isRemote = isRemoteFilePath(availability.filePath);
    let sourceSizeBytes = 0;
    let pdfData: Uint8Array;
    try {
        pdfData = isRemote
            ? await loadRemoteData(attachment, availability.filePath)
            : await IOUtils.read(availability.filePath);
        sourceSizeBytes = isRemote ? pdfData.byteLength : 0;
    } catch (error) {
        logger(`getAttachmentInfo: failed to load PDF data: ${error}`, 1);
        return { page_count: null, status: 'unreadable', status_reason: 'Failed to load attachment file.' };
    }

    // One worker analysis attempt. The retry loop classifies any thrown error.
    const runAnalysis = async (): Promise<Pick<AttachmentInfo, 'status' | 'status_code' | 'status_reason' | 'page_count'>> => {
        const extractor = new BeaverExtractor();
        const metadata = await extractor.getMetadata(pdfData);
        const { pageCount, pageLabels, pages } = metadata;
        if (pageCount === 0) {
            return { page_count: 0, status: 'unreadable', status_code: 'pdf_invalid' };
        }

        const ocrAnalysis = await extractor.analyzeOCRNeeds(pdfData);
        if (ocrAnalysis.needsOCR) {
            await cache?.putErrorMetadata({ item: attachment, filePath: availability.filePath, sourceSizeBytes, contentType: availability.contentType, errorCode: 'no_text_layer', pageCount, pageLabels, pages: pages ?? null });
            return { page_count: pageCount, status: 'unreadable', status_code: 'pdf_needs_ocr' };
        }

        await cache?.putMetadata({
            item: attachment,
            filePath: availability.filePath,
            sourceSizeBytes,
            contentType: availability.contentType,
            metadata: { pageCount, pageLabels, pages: pages ?? null, errorCode: null },
        });
        return { page_count: pageCount, status: 'readable' };
    };

    let lastTransientError: unknown;
    const analysisStart = Date.now();
    for (let attempt = 0; attempt < PDF_ANALYSIS_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            // Give the worker host a short window to settle before respawning.
            await delay(PDF_ANALYSIS_RETRY_BACKOFF_MS[Math.min(attempt - 1, PDF_ANALYSIS_RETRY_BACKOFF_MS.length - 1)]);
        }
        try {
            return await runAnalysis();
        } catch (error) {
            // Deterministic content verdicts are not retried. Permanent ones
            // are cached so future reads skip analysis.
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    await cache?.putErrorMetadata({ item: attachment, filePath: availability.filePath, sourceSizeBytes, contentType: availability.contentType, errorCode: 'encrypted', pageCount: null, pageLabels: null, pages: null });
                    return { page_count: null, status: 'unreadable', status_code: 'pdf_encrypted' };
                }
                if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    await cache?.putErrorMetadata({ item: attachment, filePath: availability.filePath, sourceSizeBytes, contentType: availability.contentType, errorCode: 'invalid_pdf', pageCount: null, pageLabels: null, pages: null });
                    return { page_count: null, status: 'unreadable', status_code: 'pdf_invalid' };
                }
                if (error.code === ExtractionErrorCode.EMPTY_DOCUMENT) {
                    return { page_count: 0, status: 'unreadable', status_code: 'pdf_invalid' };
                }
                if (error.code === ExtractionErrorCode.WASM_ERROR) {
                    return {
                        page_count: null,
                        status: 'unreadable',
                        status_code: 'pdf_parser_crash',
                        status_reason: 'PDF crashes the local PDF parser',
                    };
                }
            }

            // Retry transient worker failures while attempts and time remain.
            if (isTransientWorkerError(error)) {
                lastTransientError = error;
                const heap = isHeapExhaustion(error);
                const maxAttempts = heap ? PDF_HEAP_EXHAUSTION_MAX_ATTEMPTS : PDF_ANALYSIS_MAX_ATTEMPTS;
                const hasMoreAttempts = attempt < maxAttempts - 1;
                const withinBudget = Date.now() - analysisStart < PDF_ANALYSIS_TOTAL_BUDGET_MS;
                if (hasMoreAttempts && withinBudget) {
                    logger(`getAttachmentInfo: transient worker error analyzing PDF (attempt ${attempt + 1}/${maxAttempts}), retrying: ${error}`, 2);
                    continue;
                }
                if (heap) {
                    // Repeated heap exhaustion means this file cannot be
                    // analyzed under current local parser limits.
                    logger(`getAttachmentInfo: PDF exhausts the local parser's memory after ${attempt + 1} attempt(s): ${error}`, 1);
                    return {
                        page_count: null,
                        status: 'unreadable',
                        status_code: 'pdf_parser_crash',
                        status_reason: 'PDF is too large for the local PDF parser to process.',
                    };
                }
                // Worker analysis is unavailable, but the file exists and has
                // already passed attachment availability checks.
                logger(`getAttachmentInfo: PDF analysis unavailable after ${attempt + 1} attempt(s); treating as readable: ${error}`, 1);
                return { page_count: null, status: 'readable' };
            }

            // Unknown, non-transient failure.
            logger(`getAttachmentInfo: Error analyzing PDF: ${error}`, 1);
            return { page_count: null, status: 'unreadable', status_code: 'pdf_analysis_error' };
        }
    }

    // Defensive fallback; the final transient attempt normally returns above.
    logger(`getAttachmentInfo: PDF analysis unavailable; treating as readable: ${lastTransientError}`, 1);
    return { page_count: null, status: 'readable' };
}

/**
 * Resolve readability info for an EPUB attachment.
 *
 * EPUB extraction requires the full DOM pipeline, so this never extracts on
 * the hot path. A cached extraction supplies the stamped page count when
 * available, falling back to section count for older cache rows; a cold cache
 * simply reports the attachment as readable — file existence and size were
 * already checked by `checkAttachmentAvailability`.
 */
async function resolveEpubInfo(
    attachment: Zotero.Item,
    availability: Extract<AttachmentAvailabilityResult, { available: true }>,
): Promise<Pick<AttachmentInfo, 'status' | 'status_code' | 'status_reason' | 'page_count'>> {
    const cache = Zotero.Beaver?.documentCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata({
                libraryId: attachment.libraryID,
                zoteroKey: attachment.key,
            }, availability.filePath);
            if (cached && cached.contentKind === 'epub') {
                if (cached.errorCode) {
                    return {
                        page_count: null,
                        status: 'unreadable',
                        status_code: 'epub_invalid',
                        status_reason: 'EPUB could not be read by the local extractor.',
                    };
                }
                const meta = cached.documentMetadata;
                const epubMeta = meta?.content_kind === 'epub' ? meta : null;
                const sectionCount = epubMeta?.sectionCount ?? null;
                // The extraction path rejects section-less EPUBs as having no
                // extractable text, so don't advertise them as readable.
                if (sectionCount === 0) {
                    return {
                        page_count: 0,
                        status: 'unreadable',
                        status_code: 'epub_invalid',
                        status_reason: 'EPUB has no readable sections.',
                    };
                }
                // Image-only/scanned EPUBs have sections but zero extracted
                // text; the read path rejects them as no_text_layer, so the
                // status must agree. Missing diagnostics stay readable because
                // unknown is not zero.
                if (epubMeta?.extractedTextChars === 0) {
                    return {
                        page_count: sectionCount,
                        status: 'unreadable',
                        status_code: 'epub_no_text',
                        status_reason: 'EPUB contains no extractable text (image-only or scanned book).',
                    };
                }
                // Use the cached page count when available; otherwise report
                // the section count as the best available EPUB extent.
                return { page_count: epubMeta?.pageCount ?? sectionCount, status: 'readable' };
            }
        } catch (error) {
            logger(`getAttachmentInfo: cache read error: ${error}`, 1);
        }
    }
    return { page_count: null, status: 'readable' };
}

async function resolveSnapshotInfo(
    attachment: Zotero.Item,
    availability: Extract<AttachmentAvailabilityResult, { available: true }>,
): Promise<Pick<AttachmentInfo, 'status' | 'status_code' | 'status_reason' | 'page_count'>> {
    const cache = Zotero.Beaver?.documentCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata({
                libraryId: attachment.libraryID,
                zoteroKey: attachment.key,
            }, availability.filePath);
            if (cached && cached.contentKind === 'snapshot') {
                if (cached.errorCode) {
                    return {
                        page_count: null,
                        status: 'unreadable',
                        status_code: 'snapshot_invalid',
                        status_reason: 'Snapshot could not be read by the local extractor.',
                    };
                }
                const meta = cached.documentMetadata;
                const snapshotMeta = meta?.content_kind === 'snapshot' ? meta : null;
                // Text-empty snapshots are rejected as no_text_layer by the read
                // path, so the status must agree. Missing diagnostics stay
                // readable because unknown is not zero.
                if (snapshotMeta?.extractedTextChars === 0) {
                    return {
                        page_count: snapshotMeta?.pageCount ?? null,
                        status: 'unreadable',
                        status_code: 'snapshot_no_text',
                        status_reason: 'Snapshot contains no extractable text.',
                    };
                }
                // Snapshot reads use the same stamped synthetic page coordinate
                // as citations, so attachment metadata must report that count.
                return { page_count: snapshotMeta?.pageCount ?? null, status: 'readable' };
            }
        } catch (error) {
            logger(`getAttachmentInfo: cache read error: ${error}`, 1);
        }
    }
    return { page_count: null, status: 'readable' };
}

async function loadRemoteData(attachment: Zotero.Item, filePath: string): Promise<Uint8Array> {
    const { loadAttachmentData } = await import('./attachmentSource');
    const result = await loadAttachmentData({
        item: attachment,
        source: { kind: 'remote', filePath, isRemoteOnly: true },
        maxFileSizeMB: effectiveMaxFileSizeMB(),
    });
    if (result.kind === 'ok') {
        return result.data;
    }
    throw result.error ?? new Error(result.code);
}

/**
 * Resolve a Zotero attachment to the unified agent-facing attachment shape.
 */
export async function getAttachmentInfo(
    item: Zotero.Item,
    options: AttachmentInfoOptions = {},
): Promise<AttachmentInfo> {
    // Batch callers preload item data, but one-off callers (annotation
    // actions, dev endpoints) pass items with only primary data loaded, and
    // reading the title field below would then throw "Item data not loaded".
    // Load it on demand; the _loaded check avoids a redundant DB query when
    // the data is already loaded (loadDataType always re-queries).
    const loaded = (item as { _loaded?: Record<string, boolean> })._loaded;
    if (!loaded?.itemData) {
        await item.loadDataType?.('itemData');
    }

    const contentKind = getContentKind(item);
    const isPrimary = options.isPrimary ?? false;
    const base: AttachmentInfo = {
        attachment_id: attachmentId(item),
        parent_item_id: options.parentItemId ?? defaultParentItemId(item),
        title: item.getField?.('title') || item.getDisplayTitle?.() || null,
        filename: item.attachmentFilename || null,
        content_kind: contentKind,
        status: 'unreadable',
        page_count: null,
        line_count: null,
        is_primary: isPrimary,
    };

    if (options.includeAnnotationsCount) {
        base.annotations_count = item.isFileAttachment?.() ? item.getAnnotations().length : 0;
    }

    // Linked URLs are web links, not files Beaver can read.
    if (contentKind === 'linked_url') {
        return { ...base, status_reason: unreadableTypeReason(contentKind) };
    }

    // PDF, EPUB, and plain text are readable by default. Other readable kinds
    // remain behind the nonPdfReadableEnabled option until extraction supports them.
    const isUnconditionallyReadable =
        contentKind === 'pdf' || contentKind === 'epub'
        || contentKind === 'snapshot' || contentKind === 'text';
    if (!isReadableContentKind(contentKind) || (!isUnconditionallyReadable && !options.nonPdfReadableEnabled)) {
        return { ...base, status_reason: unreadableTypeReason(contentKind) };
    }

    const availability = await checkAttachmentAvailability(item);
    if (!availability.available) {
        return {
            ...base,
            status: 'unreadable',
            status_code: availability.status_code,
            status_reason: availability.status_reason,
        };
    }

    if (contentKind === 'pdf') {
        const pdfInfo = await resolvePdfInfo(item, availability, options);
        return { ...base, ...pdfInfo };
    }

    if (contentKind === 'epub') {
        // EPUB extraction requires a local file path.
        if (isRemoteFilePath(availability.filePath)) {
            return {
                ...base,
                status: 'unreadable',
                status_code: 'file_not_local_remote',
                status_reason: 'The EPUB file is available remotely but is not synced locally. Sync it in Zotero so Beaver can read it.',
            };
        }
        const epubInfo = await resolveEpubInfo(item, availability);
        return { ...base, ...epubInfo };
    }

    if (contentKind === 'snapshot') {
        // Snapshot extraction reads the local HTML file directly and never
        // downloads remote bytes, so a remote-only snapshot is unreadable even
        // with remote access enabled.
        if (isRemoteFilePath(availability.filePath)) {
            return {
                ...base,
                status: 'unreadable',
                status_code: 'file_not_local_remote',
                status_reason: 'The snapshot file is available remotely but is not synced locally. Sync it in Zotero so Beaver can read it.',
            };
        }
        const snapshotInfo = await resolveSnapshotInfo(item, availability);
        return { ...base, ...snapshotInfo };
    }

    return { ...base, status: 'readable' };
}
