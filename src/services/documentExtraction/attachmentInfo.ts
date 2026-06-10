import { BeaverExtractor, ExtractionError, ExtractionErrorCode } from '../../beaver-extract';
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
    timing?: TimingAccumulator;
}

type FileStatusCodeValue =
    | 'unsupported_file_type'
    | 'file_not_local'
    | 'file_not_local_remote'
    | 'pdf_encrypted'
    | 'pdf_invalid'
    | 'pdf_needs_ocr'
    | 'pdf_parser_crash'
    | 'pdf_analysis_error'
    | 'pdf_unreadable'
    | 'epub_invalid';

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
                    status_reason: `File size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit.`,
                };
            }
        } catch (error) {
            logger(`getAttachmentInfo: IOUtils.stat failed for ${filePath}: ${error}`, 2);
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

    if (options.skipWorkerFallback) {
        const pageCount = await getCheapPdfPageCount(attachment, availability.filePath, true);
        return { page_count: pageCount, status: 'readable' };
    }

    try {
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

        const extractor = new BeaverExtractor();
        let metadata: Awaited<ReturnType<BeaverExtractor['getMetadata']>>;
        try {
            metadata = await extractor.getMetadata(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    await cache?.putErrorMetadata({ item: attachment, filePath: availability.filePath, sourceSizeBytes, contentType: availability.contentType, errorCode: 'encrypted', pageCount: null, pageLabels: null, pages: null });
                    return { page_count: null, status: 'unreadable', status_code: 'pdf_encrypted' };
                }
                if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    await cache?.putErrorMetadata({ item: attachment, filePath: availability.filePath, sourceSizeBytes, contentType: availability.contentType, errorCode: 'invalid_pdf', pageCount: null, pageLabels: null, pages: null });
                    return { page_count: null, status: 'unreadable', status_code: 'pdf_invalid' };
                }
                if (error.code === ExtractionErrorCode.WASM_ERROR) {
                    return {
                        page_count: null,
                        status: 'unreadable',
                        status_code: 'pdf_parser_crash',
                        status_reason: 'PDF crashes the local PDF parser',
                    };
                }
                if (error.code === ExtractionErrorCode.EMPTY_DOCUMENT) {
                    return { page_count: 0, status: 'unreadable', status_code: 'pdf_invalid' };
                }
            }
            throw error;
        }

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
    } catch (error) {
        if (error instanceof ExtractionError && error.code === ExtractionErrorCode.WASM_ERROR) {
            return {
                page_count: null,
                status: 'unreadable',
                status_code: 'pdf_parser_crash',
                status_reason: 'PDF crashes the local PDF parser',
            };
        }
        logger(`getAttachmentInfo: Error analyzing PDF: ${error}`, 1);
        return { page_count: null, status: 'unreadable', status_code: 'pdf_analysis_error' };
    }
}

/**
 * Resolve readability info for an EPUB attachment.
 *
 * EPUB extraction requires the full DOM pipeline, so this never extracts on
 * the hot path. A cached extraction supplies the section count (the EPUB
 * analogue of a page count); a cold cache simply reports the attachment as
 * readable — file existence and size were already checked by
 * `checkAttachmentAvailability`.
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
                const sectionCount = meta?.content_kind === 'epub' ? meta.sectionCount : null;
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
                return { page_count: sectionCount, status: 'readable' };
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

    if (contentKind === 'linked_url') {
        return { ...base, status_reason: unreadableTypeReason(contentKind) };
    }

    // PDF and EPUB are always readable; the remaining readable kinds
    // (text/snapshot/image) stay behind the nonPdfReadableEnabled option.
    const isUnconditionallyReadable = contentKind === 'pdf' || contentKind === 'epub';
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
        // EPUB extraction requires a local file (the zip reader cannot consume
        // downloaded bytes, and the extractor never downloads remote files), so
        // a remote-only EPUB is unreadable even with remote access enabled.
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

    return { ...base, status: 'readable' };
}
