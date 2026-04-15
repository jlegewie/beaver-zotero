import { logger } from '../../utils/logger';
import { ZoteroItemReference } from '../../../react/types/zotero';
import { ZoteroItemStatus, FrontendFileStatus, AttachmentDataWithStatus, AttachmentSummary, FileStatusCode } from '../../../react/types/zotero';
import { safeIsInTrash, safeFileExists, isLinkedUrlAttachment } from '../../utils/zoteroUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../../utils/sync';
import { getPref } from '../../utils/prefs';

import { isAttachmentOnServer, getAttachmentDataInMemory, DownloadOptions } from '../../utils/webAPI';
import { addPopupMessageAtom } from '../../../react/utils/popupMessageUtils';
import { wasItemAddedBeforeLastSync } from '../../../react/utils/sourceUtils';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { MuPDFService } from '../pdf/MuPDFService';
import { EXTRACTION_VERSION, isRemoteFilePath, makeRemoteFilePath } from '../attachmentFileCache';
import type { AttachmentFileCacheRecord } from '../attachmentFileCache';
import { DeferredToolPreference } from '../agentProtocol';
import { deferredToolPreferencesAtom } from '../../../react/atoms/deferredToolPreferences';
import { isSupportedItem } from '../../utils/sync';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { serializeAttachment } from '../../utils/zoteroSerializers';
import { getPDFPageCountFromFulltext, getPDFPageCountFromWorker } from '../../../react/utils/pdfUtils';
import { TimingAccumulator } from '../../utils/timing';

// ---------------------------------------------------------------------------
// Remote PDF download cache
// ---------------------------------------------------------------------------

/**
 * Check if remote file access is enabled AND the attachment is on the server.
 * Combines the preference check with the server-availability check.
 */
export function isRemoteAccessAvailable(item: Zotero.Item): boolean {
    return getPref('accessRemoteFiles') && isAttachmentOnServer(item);
}

// ---------------------------------------------------------------------------
// Remote download failure notification (rate-limited to once per 8 hours)
// ---------------------------------------------------------------------------

const REMOTE_FAILURE_NOTIFY_INTERVAL_MS = 8 * 60 * 60 * 1000;
let _remoteDownloadFailureLastNotifiedAt = 0;

function notifyRemoteDownloadFailure(): void {
    const now = Date.now();
    if (now - _remoteDownloadFailureLastNotifiedAt < REMOTE_FAILURE_NOTIFY_INTERVAL_MS) return;
    _remoteDownloadFailureLastNotifiedAt = now;

    try {
        store.set(addPopupMessageAtom, {
            id: 'remote-download-failed',
            type: 'warning',
            title: 'Remote File Download Failed',
            text: "Couldn't download a remotely stored attachment. This is usually a network or server issue. For faster, more reliable access, sync the file locally in Zotero. "
                + 'You can disable remote file access in Settings \u203A Permissions.',
            expire: false,
        });
    } catch (error) {
        logger(`notifyRemoteDownloadFailure: failed to surface popup: ${error}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Agent-context download options (fail fast)
// ---------------------------------------------------------------------------

const AGENT_DOWNLOAD_OPTIONS: DownloadOptions = {
    errorDelayIntervals: [],   // no retries — agent context can't afford the delay
    timeout: 20_000,           // 20s per-request timeout (30s backend timeout - 10s buffer)
};

/**
 * Brief in-memory cache for remote PDF downloads.
 * Avoids redundant server round-trips when multiple operations target the
 * same remote file within a short window (e.g., metadata check followed by
 * content extraction, or page-images after pages).
 */
const _remoteDataCache = new Map<string, { data: Uint8Array; ts: number }>();
/** In-flight downloads keyed by hash — coalesces concurrent requests for the same file. */
const _remoteInflight = new Map<string, Promise<Uint8Array>>();
const REMOTE_CACHE_TTL_MS = 120_000;
const REMOTE_CACHE_MAX = 10;

/**
 * Load PDF data from local disk or remote server.
 * Remote downloads are briefly cached in memory (keyed by synced hash)
 * to avoid redundant downloads across sequential handler calls.
 *
 * @throws On download failure (callers should catch and produce their own error response)
 */
export async function loadPdfData(
    item: Zotero.Item,
    filePath: string,
    isRemoteOnly: boolean,
): Promise<Uint8Array> {
    if (!isRemoteOnly) {
        return IOUtils.read(filePath);
    }

    // Cache key: prefer the synced hash; fall back to libraryID-key for
    // on-demand attachments that haven't been downloaded yet (hash is empty
    // until first sync, see isAttachmentOnServer in utils/webAPI.ts).
    const cacheKey = item.attachmentSyncedHash || `k:${item.libraryID}-${item.key}`;

    const cached = _remoteDataCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < REMOTE_CACHE_TTL_MS) {
        cached.ts = Date.now(); // refresh TTL on read
        return cached.data;
    }

    // Coalesce with an in-flight download for the same key
    const inflight = _remoteInflight.get(cacheKey);
    if (inflight) return inflight;

    const downloadPromise = getAttachmentDataInMemory(item, AGENT_DOWNLOAD_OPTIONS);
    _remoteInflight.set(cacheKey, downloadPromise);

    let data: Uint8Array;
    try {
        data = await downloadPromise;
    } catch (error) {
        notifyRemoteDownloadFailure();
        throw error;
    } finally {
        _remoteInflight.delete(cacheKey);
    }

    // Only cache data within the configured size limit to avoid pinning
    // oversized buffers in memory (the caller will reject them anyway).
    const maxMB = getPref('maxFileSizeMB');
    const withinSizeLimit = (data.length / 1024 / 1024) <= maxMB;

    if (withinSizeLimit) {
        // Evict expired entries when at capacity
        if (_remoteDataCache.size >= REMOTE_CACHE_MAX) {
            const now = Date.now();
            for (const [k, v] of _remoteDataCache) {
                if (now - v.ts > REMOTE_CACHE_TTL_MS) _remoteDataCache.delete(k);
            }
        }
        if (_remoteDataCache.size >= REMOTE_CACHE_MAX) {
            const oldest = _remoteDataCache.keys().next().value;
            if (oldest !== undefined) _remoteDataCache.delete(oldest);
        }
        _remoteDataCache.set(cacheKey, { data, ts: Date.now() });
    }

    return data;
}

/**
 * Check whether remote PDF data exceeds the configured size limit.
 * Returns size info when the limit is exceeded, or null when within limits.
 */
export function checkRemotePdfSize(
    data: Uint8Array,
    skipLimits?: boolean,
): { sizeMB: number; maxMB: number } | null {
    if (skipLimits) return null;
    const maxMB = getPref('maxFileSizeMB');
    const sizeMB = data.length / 1024 / 1024;
    return sizeMB > maxMB ? { sizeMB, maxMB } : null;
}

/**
 * Validate that a ZoteroItemReference has correctly formatted fields.
 * - library_id must be a finite positive integer
 * - zotero_key must be exactly 8 alphanumeric characters
 *
 * @returns null if valid, or an error message string if invalid
 */
export function validateZoteroItemReference(ref: ZoteroItemReference): string | null {
    const { library_id, zotero_key } = ref;

    if (typeof library_id !== 'number' || !Number.isFinite(library_id) || library_id < 1 || library_id !== Math.floor(library_id)) {
        return `Invalid library_id: '${library_id}'. Must be a positive integer.`;
    }

    if (typeof zotero_key !== 'string' || !Zotero.Utilities.isValidObjectKey(zotero_key)) {
        return `Invalid zotero_key: '${zotero_key}'. Must be exactly 8 characters from Zotero's allowed set (e.g., '3RRUYX5J').`;
    }

    return null;
}

/**
 * Result of attachment availability check.
 * Either an early-exit status (if unavailable) or file info to continue processing.
 */
type AttachmentAvailabilityResult =
    | { available: false; status: FrontendFileStatus; fileExistsLocally?: boolean }
    | { available: true; filePath: string; contentType: string };

/**
 * Check attachment availability before PDF processing.
 * Validates: PDF type, file path, file existence, and size limits.
 * 
 * @param attachment - Zotero attachment item
 * @param isPrimary - Whether this is the primary attachment for the parent item
 * @returns Either early-exit status or file info to continue processing
 */
async function checkAttachmentAvailability(
    attachment: Zotero.Item,
    isPrimary: boolean
): Promise<AttachmentAvailabilityResult> {
    const contentType = attachment.attachmentContentType;

    // Non-PDF attachments are not currently supported for content extraction
    if (!attachment.isPDFAttachment()) {
        return {
            available: false,
            status: {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "unavailable",
                status_code: FileStatusCode.UnsupportedFileType,
            }
        };
    }

    // Check if the file exists locally
    // getFilePathAsync() resolves the path AND checks OS-level existence in one call
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        // File is not local — check if remote access is enabled and file is on the server
        if (isRemoteAccessAvailable(attachment)) {
            // Report as available with a synthetic remote path.
            // The actual download will happen when content is requested.
            const remotePath = makeRemoteFilePath(attachment);
            return { available: true, filePath: remotePath, contentType };
        }
        const isFileAvailableOnServer = isAttachmentOnServer(attachment);
        return {
            available: false,
            fileExistsLocally: false,
            status: {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "unavailable",
                status_code: isFileAvailableOnServer
                    ? FileStatusCode.FileNotLocalRemote
                    : FileStatusCode.FileNotLocal,
            }
        };
    }

    // Check file size limit using IOUtils.stat on the PDF file directly.
    // This replaces Zotero.Attachments.getTotalFileSize() which iterates the
    // entire storage directory with OS.File.stat() per entry — very expensive.
    // Skip for remote files (size unknown until download).
    if (!isRemoteFilePath(filePath)) {
        const maxFileSizeMB = getPref('maxFileSizeMB');
        try {
            const stat = await IOUtils.stat(filePath);
            const fileSizeInMB = (stat.size ?? 0) / 1024 / 1024;

            if (fileSizeInMB > maxFileSizeMB) {
                return {
                    available: false,
                    fileExistsLocally: true,
                    status: {
                        is_primary: isPrimary,
                        mime_type: contentType,
                        page_count: null,
                        status: "unavailable",
                        status_reason: `File size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
                    }
                };
            }
        } catch (error) {
            // If stat fails, skip size check and continue — the file was confirmed
            // to exist by getFilePathAsync() above, so this is a transient issue
            logger(`checkAttachmentAvailability: IOUtils.stat failed for ${filePath}: ${error}`, 2);
        }
    }

    return { available: true, filePath, contentType };
}

/**
 * Build a FrontendFileStatus from a cached metadata record.
 */
function fileStatusFromCache(record: AttachmentFileCacheRecord, isPrimary: boolean): FrontendFileStatus {
    if (record.is_encrypted) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: null, status: "unavailable", status_code: FileStatusCode.PdfEncrypted };
    }
    if (record.is_invalid) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: null, status: "unavailable", status_code: FileStatusCode.PdfInvalid };
    }
    if (record.needs_ocr) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: record.page_count, status: "unavailable", status_code: FileStatusCode.PdfNeedsOcr };
    }
    return { is_primary: isPrimary, mime_type: record.content_type, page_count: record.page_count, status: "available" };
}

/**
 * Extract page labels from PDF data using MuPDF.
 * Returns the label mapping (empty {} if no custom labels or on error).
 */
async function extractPageLabelsFromData(pdfData: Uint8Array): Promise<Record<number, string>> {
    const mupdf = new MuPDFService();
    try {
        await mupdf.open(pdfData);
        return mupdf.getAllPageLabels();
    } catch {
        return {};
    } finally {
        mupdf.close();
    }
}

/**
 * Persist metadata to the attachment file cache after extraction.
 * Awaited at call sites to ensure cache consistency before returning.
 * Errors are caught internally and logged — they never propagate.
 */
async function persistMetadataToCache(
    attachment: Zotero.Item,
    filePath: string,
    contentType: string,
    fields: {
        page_count: number | null;
        page_labels: Record<number, string>;
        has_text_layer: boolean | null;
        needs_ocr: boolean | null;
        is_encrypted: boolean;
        is_invalid: boolean;
    }
): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    try {
        let file_mtime_ms = 0;
        let file_size_bytes = 0;
        if (!isRemoteFilePath(filePath)) {
            const stat = await IOUtils.stat(filePath);
            file_mtime_ms = stat.lastModified ?? 0;
            file_size_bytes = stat.size ?? 0;
        }
        await cache.setMetadata({
            item_id: attachment.id,
            library_id: attachment.libraryID,
            zotero_key: attachment.key,
            file_path: filePath,
            file_mtime_ms,
            file_size_bytes,
            content_type: contentType,
            page_count: fields.page_count,
            page_labels: fields.page_labels,
            has_text_layer: fields.has_text_layer,
            needs_ocr: fields.needs_ocr,
            is_encrypted: fields.is_encrypted,
            is_invalid: fields.is_invalid,
            extraction_version: EXTRACTION_VERSION,
        });
    } catch (error) {
        logger(`persistMetadataToCache: ${error}`, 1);
    }
}

/**
 * Backfill metadata for known error states (encrypted, invalid, no text layer).
 * Uses full upsert since error states are authoritative.
 *
 * For NO_TEXT_LAYER errors, the ExtractionError carries pageLabels and pageCount
 * extracted before the OCR check (the PDF is open and page tree is readable
 * regardless of text layer status). Encrypted/invalid PDFs throw before any
 * data is accessible, so those always write page_labels: {}.
 *
 * Errors are caught internally and logged — they never propagate.
 */
export async function backfillMetadataForError(
    item: Zotero.Item,
    filePath: string,
    error: ExtractionError,
    fallbackPageCount: number | null,
    callerTag: string,
): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    const errorCode = error.code;

    // Resolve page_labels:
    //  - ENCRYPTED/INVALID_PDF: can't parse PDF → definitively empty
    //  - NO_TEXT_LAYER: use labels extracted before the OCR check (fall back to {} if absent)
    let pageLabels: Record<number, string>;
    if (errorCode === ExtractionErrorCode.NO_TEXT_LAYER) {
        pageLabels = error.pageLabels && Object.keys(error.pageLabels).length > 0
            ? error.pageLabels
            : {};
    } else {
        pageLabels = {};
    }

    try {
        let file_mtime_ms = 0;
        let file_size_bytes = 0;
        if (!isRemoteFilePath(filePath)) {
            const stat = await IOUtils.stat(filePath);
            file_mtime_ms = stat.lastModified ?? 0;
            file_size_bytes = stat.size ?? 0;
        }
        await cache.setMetadata({
            item_id: item.id,
            library_id: item.libraryID,
            zotero_key: item.key,
            file_path: filePath,
            file_mtime_ms,
            file_size_bytes,
            content_type: item.attachmentContentType || 'application/pdf',
            page_count: error.pageCount ?? fallbackPageCount,
            page_labels: pageLabels,
            has_text_layer: errorCode === ExtractionErrorCode.NO_TEXT_LAYER ? false : null,
            needs_ocr: errorCode === ExtractionErrorCode.NO_TEXT_LAYER,
            is_encrypted: errorCode === ExtractionErrorCode.ENCRYPTED,
            is_invalid: errorCode === ExtractionErrorCode.INVALID_PDF,
            extraction_version: EXTRACTION_VERSION,
        });
    } catch (cacheError) {
        logger(`${callerTag}: cache backfill error: ${cacheError}`, 1);
    }
}

/**
 * Get file status information for an attachment.
 * Determines page count and availability of fulltext/page images.
 * Performs full PDF analysis including OCR detection.
 *
 * Uses cache-first: if a fresh metadata record exists, maps it to FrontendFileStatus
 * without reading the PDF. On miss, runs the full extraction and persists metadata.
 *
 * @param attachment - Zotero attachment item
 * @param isPrimary - Whether this is the primary attachment for the parent item
 * @returns File status information
 */
export async function getAttachmentFileStatus(attachment: Zotero.Item, isPrimary: boolean): Promise<FrontendFileStatus> {
    // Check basic availability (PDF type, file exists, size limits)
    const availabilityCheck = await checkAttachmentAvailability(attachment, isPrimary);
    if (!availabilityCheck.available) {
        return availabilityCheck.status;
    }

    const { filePath, contentType } = availabilityCheck;

    // Cache-first: all writers produce complete records, so any hit is usable.
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata(attachment.id, filePath);
            if (cached) {
                return fileStatusFromCache(cached, isPrimary);
            }
        } catch (error) {
            logger(`getAttachmentFileStatus: cache read error: ${error}`, 1);
        }
    }

    // Cache miss: run full extraction
    try {
        const isRemote = isRemoteFilePath(filePath);
        let pdfData: Uint8Array;
        try {
            pdfData = await loadPdfData(attachment, filePath, isRemote);
        } catch (error) {
            if (!isRemote) throw error; // local I/O error — let outer catch deal with it
            logger(`getAttachmentFileStatus: remote download failed: ${error}`, 1);
            return {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "unavailable",
                status_reason: 'Failed to download file from remote storage',
            };
        }
        const extractor = new PDFExtractor();

        // Get page count - this also validates the PDF and detects encryption
        let pageCount: number;
        try {
            pageCount = await extractor.getPageCount(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    await persistMetadataToCache(attachment, filePath, contentType, { page_count: null, page_labels: {}, has_text_layer: null, needs_ocr: false, is_encrypted: true, is_invalid: false });
                    return {
                        is_primary: isPrimary,
                        mime_type: contentType,
                        page_count: null,
                        status: "unavailable",
                        status_code: FileStatusCode.PdfEncrypted,
                    };
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    await persistMetadataToCache(attachment, filePath, contentType, { page_count: null, page_labels: {}, has_text_layer: null, needs_ocr: false, is_encrypted: false, is_invalid: true });
                    return {
                        is_primary: isPrimary,
                        mime_type: contentType,
                        page_count: null,
                        status: "unavailable",
                        status_code: FileStatusCode.PdfInvalid,
                    };
                }
            }
            throw error;
        }

        // Analyze OCR needs and extract page labels in parallel
        const [ocrAnalysis, pageLabels] = await Promise.all([
            extractor.analyzeOCRNeeds(pdfData),
            extractPageLabelsFromData(pdfData),
        ]);

        if (ocrAnalysis.needsOCR) {
            await persistMetadataToCache(attachment, filePath, contentType, { page_count: pageCount, page_labels: pageLabels, has_text_layer: false, needs_ocr: true, is_encrypted: false, is_invalid: false });
            return {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: pageCount,
                status: "unavailable",
                status_code: FileStatusCode.PdfNeedsOcr,
            };
        }

        // All checks passed - file is fully accessible
        await persistMetadataToCache(attachment, filePath, contentType, { page_count: pageCount, page_labels: pageLabels, has_text_layer: true, needs_ocr: false, is_encrypted: false, is_invalid: false });
        return {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: pageCount,
            status: "available",
        };

    } catch (error) {
        // Unexpected error during analysis
        logger(`getAttachmentFileStatus: Error analyzing PDF: ${error}`, 1);
        return {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: null,
            status: "unavailable",
            status_code: FileStatusCode.PdfAnalysisError,
        };
    }
}

/**
 * Lightweight file status check for search results.
 * Skips expensive OCR analysis and uses efficient page count methods.
 *
 * Cache-first: if a fresh metadata record exists (from a prior full extraction),
 * returns richer status (including OCR/encrypted flags) without any I/O.
 * On miss: keeps existing lightweight behavior (fulltext/PDFWorker page count only)
 * and only persists metadata when page count comes from PDFWorker.
 *
 * @param attachment - Zotero attachment item
 * @param isPrimary - Whether this is the primary attachment for the parent item
 * @returns File status information (without OCR analysis on cache miss)
 */
export async function getAttachmentFileStatusLightweight(
    attachment: Zotero.Item,
    isPrimary: boolean,
    options?: { skipWorkerFallback?: boolean }
): Promise<{ fileStatus: FrontendFileStatus; fileExistsLocally: boolean | undefined }> {
    // Check basic availability (PDF type, file exists, size limits)
    const availabilityCheck = await checkAttachmentAvailability(attachment, isPrimary);
    if (!availabilityCheck.available) {
        // fileExistsLocally is set by checkAttachmentAvailability:
        // - undefined for non-PDF (not checked), false for missing file, true for file-too-large
        return { fileStatus: availabilityCheck.status, fileExistsLocally: availabilityCheck.fileExistsLocally };
    }

    const { filePath, contentType } = availabilityCheck;

    // File is available — locally or on the Zotero server
    const fileExistsLocally = !isRemoteFilePath(filePath);

    // Cache-first: all writers produce complete records, so any hit is usable.
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata(attachment.id, filePath);
            if (cached) {
                return { fileStatus: fileStatusFromCache(cached, isPrimary), fileExistsLocally };
            }
        } catch (error) {
            logger(`getAttachmentFileStatusLightweight: cache read error: ${error}`, 1);
        }
    }

    // Cache miss: use lightweight methods (no full file read)
    // First try fulltext index (instant database query)
    let pageCount = await getPDFPageCountFromFulltext(attachment);

    // Fallback to PDFWorker if not indexed (reads minimal data).
    // In batch/search contexts, skip the worker to avoid queue contention —
    // many concurrent calls serialize on the single PDFWorker and cause timeouts.
    if (pageCount === null && !options?.skipWorkerFallback && !isRemoteFilePath(filePath)) {
        pageCount = await getPDFPageCountFromWorker(attachment);
    }

    if (pageCount === null) {
        if (options?.skipWorkerFallback || isRemoteFilePath(filePath)) {
            // Optimistic: file passed availability checks (exists locally or on server, correct type).
            // Page count is unknown but the PDF is likely usable — just not yet fulltext-indexed
            // or the file is remote-only (page count will be determined on download).
            return { fileStatus: {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "available",
            }, fileExistsLocally };
        }
        // Both methods failed — PDF is likely problematic (encrypted, corrupted, or unparseable)
        return { fileStatus: {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: null,
            status: "unavailable",
            status_code: FileStatusCode.PdfUnreadable,
        }, fileExistsLocally };
    }

    // All checks passed - file is available
    return { fileStatus: {
        is_primary: isPrimary,
        mime_type: contentType,
        page_count: pageCount,
        status: "available",
    }, fileExistsLocally };
}

/**
 * Pre-fetch sync dates for a set of libraries.
 * Returns a Map from libraryId to the last sync date SQL string (or null if no sync log).
 * This avoids redundant DB queries when computing status for many items from the same libraries.
 *
 * @param libraryIds - Library IDs to pre-fetch sync dates for
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID
 * @returns Map from libraryId to lastSyncDateSQL (null means no sync log found)
 */
export async function prefetchSyncDates(
    libraryIds: number[],
    syncWithZotero: any,
    userId: string | null
): Promise<Map<number, string | null>> {
    const cache = new Map<number, string | null>();
    if (!userId) return cache;

    const uniqueLibraryIds = [...new Set(libraryIds)];

    await Promise.all(uniqueLibraryIds.map(async (libraryId) => {
        try {
            const syncLog = syncWithZotero
                ? await Zotero.Beaver.db.getSyncLogWithHighestVersion(userId, libraryId)
                : await Zotero.Beaver.db.getSyncLogWithMostRecentDate(userId, libraryId);

            if (!syncLog) {
                cache.set(libraryId, null);
            } else {
                const lastSyncDate = syncLog.library_date_modified;
                const lastSyncDateSQL = Zotero.Date.isISODate(lastSyncDate)
                    ? Zotero.Date.isoToSQL(lastSyncDate)
                    : lastSyncDate;
                cache.set(libraryId, lastSyncDateSQL);
            }
        } catch (e) {
            // Don't cache errors — let computeItemStatus fall back to per-item query,
            // which will also fail and correctly set isPendingSync = null (unknown).
        }
    }));

    return cache;
}

/**
 * Compute sync status information for a Zotero item.
 * Determines why an item might not be available in the backend.
 *
 * @param item - Zotero item to compute status for
 * @param syncedLibraryIds - List of library IDs configured for sync
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID (for pending sync detection)
 * @param options.syncDateCache - Pre-fetched sync dates from prefetchSyncDates() to avoid per-item DB queries
 * @returns Status information for the item
 */
export async function computeItemStatus(
    item: Zotero.Item,
    syncedLibraryIds: number[],
    syncWithZotero: any,
    userId: string | null,
    options?: { syncDateCache?: Map<number, string | null>; fileExistsLocally?: boolean }
): Promise<ZoteroItemStatus> {
    const isSyncedLibrary = syncedLibraryIds.includes(item.libraryID);
    const trashState = safeIsInTrash(item);
    const isInTrash = trashState === true;

    // Determine if item is available locally or on server
    // For attachments: check file exists (but skip for linked URLs which have no file)
    let availableLocallyOrOnServer = true;
    let passesSyncFilters = true;

    if (item.isAttachment()) {
        if (isLinkedUrlAttachment(item)) {
            // Linked URLs are web links with no file - they don't pass sync filters
            // Skip safeFileExists() and syncingItemFilterAsync() which are not applicable
            availableLocallyOrOnServer = true;
            passesSyncFilters = false;
        } else if (options?.fileExistsLocally !== undefined) {
            // File existence already determined by caller (e.g. getAttachmentFileStatusLightweight)
            // — skip redundant safeFileExists() and syncingItemFilterAsync() I/O
            availableLocallyOrOnServer = options.fileExistsLocally || isAttachmentOnServer(item);
            passesSyncFilters = syncingItemFilter(item) && availableLocallyOrOnServer;
        } else {
            // For file attachments, check if file exists locally or on server
            availableLocallyOrOnServer = (await safeFileExists(item)) || isAttachmentOnServer(item);
            passesSyncFilters = availableLocallyOrOnServer && (await syncingItemFilterAsync(item));
        }
    } else {
        // Regular items - check sync filters normally
        passesSyncFilters = await syncingItemFilterAsync(item);
    }

    // Compute is_pending_sync only if we have a userId
    let isPendingSync: boolean | null = null;
    if (userId) {
        try {
            const syncDateCache = options?.syncDateCache;
            if (syncDateCache && syncDateCache.has(item.libraryID)) {
                const lastSyncDateSQL = syncDateCache.get(item.libraryID)!;
                if (lastSyncDateSQL === null) {
                    // No sync log found for this library
                    isPendingSync = true;
                } else {
                    isPendingSync = !(item.dateAdded <= lastSyncDateSQL);
                }
            } else {
                // No cache or library not in cache — fall back to per-item query
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                isPendingSync = !wasAddedBeforeSync;
            }
        } catch (e) {
            // Unable to determine pending status
            isPendingSync = null;
        }
    }

    return {
        is_synced_library: isSyncedLibrary,
        is_in_trash: isInTrash,
        available_locally_or_on_server: availableLocallyOrOnServer,
        passes_sync_filters: passesSyncFilters,
        is_pending_sync: isPendingSync
    };
}

/**
 * Context for processing attachments (sync configuration)
 */
export interface AttachmentProcessingContext {
    searchableLibraryIds: number[];
    syncWithZotero: any;
    userId: string | null;
}

/**
 * Batch-fetch the "best attachment" for multiple parent items in a single SQL query.
 * Replicates Zotero's `getBestAttachment()` ranking:
 *   1. PDF content type preferred
 *   2. URL matches parent's URL preferred
 *   3. Earliest dateAdded wins ties
 *
 * Uses `ROW_NUMBER() OVER (PARTITION BY ...)` to pick the best attachment per parent
 * in one pass instead of N individual queries.
 *
 * @param parentItemIds - IDs of regular (parent) items
 * @returns Map from parentItemID to bestAttachmentItemID
 */
export async function getBestAttachmentBatch(
    parentItemIds: number[]
): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (parentItemIds.length === 0) return result;

    const CHUNK_SIZE = 500;
    for (let i = 0; i < parentItemIds.length; i += CHUNK_SIZE) {
        const chunk = parentItemIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');

        const sql = `
            WITH ranked AS (
                SELECT
                    IA.parentItemID,
                    IA.itemID AS attachmentItemID,
                    ROW_NUMBER() OVER (
                        PARTITION BY IA.parentItemID
                        ORDER BY
                            CASE WHEN IA.contentType = 'application/pdf' THEN 0 ELSE 1 END,
                            CASE WHEN COALESCE(IDV_att.value, '') = COALESCE(IDV_parent.value, '') THEN 0 ELSE 1 END,
                            I.dateAdded ASC
                    ) AS rn
                FROM itemAttachments IA
                JOIN items I ON I.itemID = IA.itemID
                LEFT JOIN deletedItems DI ON DI.itemID = IA.itemID
                LEFT JOIN itemData ID_att ON ID_att.itemID = IA.itemID
                    AND ID_att.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'url')
                LEFT JOIN itemDataValues IDV_att ON IDV_att.valueID = ID_att.valueID
                LEFT JOIN itemData ID_parent ON ID_parent.itemID = IA.parentItemID
                    AND ID_parent.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'url')
                LEFT JOIN itemDataValues IDV_parent ON IDV_parent.valueID = ID_parent.valueID
                WHERE IA.parentItemID IN (${placeholders})
                  AND DI.itemID IS NULL
                  AND IA.linkMode != ${Zotero.Attachments.LINK_MODE_LINKED_URL}
            )
            SELECT parentItemID, attachmentItemID
            FROM ranked
            WHERE rn = 1
        `;

        const rows: { parentItemID: number; attachmentItemID: number }[] = [];
        await Zotero.DB.queryAsync(sql, chunk, {
            onRow: (row: any) => {
                rows.push({
                    parentItemID: row.getResultByIndex(0),
                    attachmentItemID: row.getResultByIndex(1),
                });
            },
        });

        for (const row of rows) {
            result.set(row.parentItemID, row.attachmentItemID);
        }
    }

    return result;
}

/**
 * Pre-fetched batch data for attachment processing.
 */
export interface BatchAttachmentData {
    bestAttachmentMap: Map<number, number>;
    syncDateCache: Map<number, string | null>;
}

/**
 * Prepare batch attachment data for a set of parent items.
 * Runs getBestAttachmentBatch + prefetchSyncDates in parallel.
 */
export async function prepareBatchAttachmentData(
    parentItems: Zotero.Item[],
    context: AttachmentProcessingContext,
    timing?: TimingAccumulator
): Promise<BatchAttachmentData> {
    const parentItemIds = parentItems.map(item => item.id);
    const libraryIds = [...new Set(parentItems.map(item => item.libraryID))];

    const fn = () => Promise.all([
        getBestAttachmentBatch(parentItemIds),
        prefetchSyncDates(libraryIds, context.syncWithZotero, context.userId),
    ]);

    const [bestAttachmentMap, syncDateCache] = timing
        ? await timing.track('batch_prefetch_ms', fn)
        : await fn();

    return { bestAttachmentMap, syncDateCache };
}

/**
 * Process attachments for an item using pre-fetched batch data.
 * Variant of processAttachmentsParallel that avoids per-item DB queries
 * for getBestAttachment and prefetchSyncDates.
 *
 * @param item - Parent Zotero item
 * @param context - Sync configuration context
 * @param batchData - Pre-fetched attachment data from prepareBatchAttachmentData
 * @param options.skipHash - If true, skip SHA-256 hash computation
 * @param options.timing - Optional timing accumulator
 * @returns Array of processed attachments with status
 */
export async function processAttachmentsWithBatchData(
    item: Zotero.Item,
    context: AttachmentProcessingContext,
    batchData: BatchAttachmentData,
    options?: { skipHash?: boolean; skipWorkerFallback?: boolean; timing?: TimingAccumulator }
): Promise<AttachmentDataWithStatus[]> {
    const skipHash = options?.skipHash ?? false;
    const skipWorkerFallback = options?.skipWorkerFallback ?? false;
    const ta = options?.timing;
    const attachmentIds = item.getAttachments();
    if (attachmentIds.length === 0) {
        return [];
    }

    // Fetch attachment items (mostly cache hits in Zotero's item cache)
    const fetchFn = () => Zotero.Items.getAsync(attachmentIds);
    const attachmentItems = ta
        ? await ta.track('att_fetch_ms', fetchFn)
        : await fetchFn();

    // Load data types for all attachments
    const loadFn = () => Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData", "tags", "collections", "relations", "childItems"]);
    await (ta ? ta.track('att_load_data_ms', loadFn) : loadFn());

    // Use batch data for primary attachment lookup
    const bestAttachmentId = batchData.bestAttachmentMap.get(item.id);

    // Process all attachments in parallel
    const attachmentPromises = attachmentItems.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
        // Validate attachment
        const isValidAttachment = syncingItemFilter(attachment);
        if (!isValidAttachment) {
            return null;
        }

        // Serialize attachment
        const serializeFn = () => serializeAttachment(attachment, undefined, { skipFileHash: true, skipSyncingFilter: true, skipHash });
        const attachmentData = ta
            ? await ta.track('att_serialize_ms', serializeFn)
            : await serializeFn();
        if (!attachmentData) {
            return null;
        }

        // Use batch data for isPrimary and syncDateCache
        const isPrimary = bestAttachmentId !== undefined && attachment.id === bestAttachmentId;

        // Run file status first to determine file existence, then pass the hint
        // to computeItemStatus to avoid redundant filesystem I/O
        const fileStatusFn = () => getAttachmentFileStatusLightweight(attachment, isPrimary, { skipWorkerFallback });
        const { fileStatus, fileExistsLocally } = ta
            ? await ta.track('att_file_status_ms', fileStatusFn)
            : await fileStatusFn();

        const statusFn = () => computeItemStatus(attachment, context.searchableLibraryIds, context.syncWithZotero, context.userId, { syncDateCache: batchData.syncDateCache, fileExistsLocally });
        const status = ta
            ? await ta.track('att_status_ms', statusFn)
            : await statusFn();

        return {
            attachment: attachmentData,
            status,
            file_status: fileStatus,
        };
    });

    const results = await Promise.all(attachmentPromises);

    // Filter out null results (invalid attachments)
    return results.filter((result): result is AttachmentDataWithStatus => result !== null);
}

/**
 * Convert AttachmentDataWithStatus to the lightweight AttachmentSummary format
 * used in ItemSummary search results.
 */
export function toAttachmentSummary(a: AttachmentDataWithStatus): AttachmentSummary {
    return {
        library_id: a.attachment.library_id,
        zotero_key: a.attachment.zotero_key,
        parent_key: a.attachment.parent_key ?? null,
        title: a.attachment.title,
        mime_type: a.attachment.mime_type,
        is_primary: a.file_status?.is_primary ?? false,
        page_count: a.file_status?.page_count ?? null,
        status: a.file_status?.status === 'available' ? 'available' : 'unavailable',
        status_code: a.file_status?.status_code,
        status_reason: a.file_status?.status_reason,
    };
}

/**
 * Process attachments for an item in parallel.
 * Fetches, validates, and serializes all attachments concurrently.
 * 
 * Uses lightweight file status check (no full PDF read, no OCR analysis)
 * to avoid timeouts when processing many attachments.
 * 
 * @param item - Parent Zotero item
 * @param context - Sync configuration context
 * @param options.skipHash - If true, skip SHA-256 hash computation (for search/lookup paths)
 * @returns Array of processed attachments with status
 */
export async function processAttachmentsParallel(
    item: Zotero.Item,
    context: AttachmentProcessingContext,
    options?: { skipHash?: boolean; timing?: TimingAccumulator }
): Promise<AttachmentDataWithStatus[]> {
    const skipHash = options?.skipHash ?? false;
    const ta = options?.timing;
    const attachmentIds = item.getAttachments();
    if (attachmentIds.length === 0) {
        return [];
    }

    // Fetch attachment items, primary attachment, and sync dates in parallel
    const fetchFn = () => Promise.all([
        Zotero.Items.getAsync(attachmentIds),
        item.getBestAttachment(),
        prefetchSyncDates([item.libraryID], context.syncWithZotero, context.userId)
    ]);
    const [attachmentItems, primaryAttachment, syncDateCache] = ta
        ? await ta.track('att_fetch_ms', fetchFn)
        : await fetchFn();

    // Load data types for all attachments
    const loadFn = () => Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData", "tags", "collections", "relations", "childItems"]);
    await (ta ? ta.track('att_load_data_ms', loadFn) : loadFn());

    // Process all attachments in parallel
    const attachmentPromises = attachmentItems.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
        // Validate attachment
        const isValidAttachment = syncingItemFilter(attachment);
        if (!isValidAttachment) {
            return null;
        }

        // Serialize attachment (skip file hash — not needed for search results)
        const serializeFn = () => serializeAttachment(attachment, undefined, { skipFileHash: true, skipSyncingFilter: true, skipHash });
        const attachmentData = ta
            ? await ta.track('att_serialize_ms', serializeFn)
            : await serializeFn();
        if (!attachmentData) {
            return null;
        }

        // Run file status first, then pass file-existence hint to computeItemStatus
        // to avoid redundant filesystem I/O (getFilePathAsync / fileExists)
        const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
        const fileStatusFn = () => getAttachmentFileStatusLightweight(attachment, isPrimary);
        const { fileStatus, fileExistsLocally } = ta
            ? await ta.track('att_file_status_ms', fileStatusFn)
            : await fileStatusFn();

        const statusFn = () => computeItemStatus(attachment, context.searchableLibraryIds, context.syncWithZotero, context.userId, { syncDateCache, fileExistsLocally });
        const status = ta
            ? await ta.track('att_status_ms', statusFn)
            : await statusFn();

        return {
            attachment: attachmentData,
            status,
            file_status: fileStatus,
        };
    });

    const results = await Promise.all(attachmentPromises);

    // Filter out null results (invalid attachments)
    return results.filter((result): result is AttachmentDataWithStatus => result !== null);
}

/**
 * Get library by ID or name, with proper validation.
 * 
 * Supports:
 * - Number: Looks up by library ID
 * - String: First tries to parse as ID, then looks up by name
 * - null/undefined: Returns user's default library
 * 
 * IMPORTANT: Does NOT fall back to user library when an explicit library is requested
 * but not found. Returns null in that case so callers can return proper error responses.
 */
export function getLibraryByIdOrName(libraryIdOrName: number | string | null | undefined): LibraryLookupResult {
    if (libraryIdOrName == null) {
        // Default to user's library - no explicit request
        return {
            library: Zotero.Libraries.userLibrary,
            wasExplicitlyRequested: false,
            searchInput: null,
        };
    }
    
    // If it's a number, look up by ID
    if (typeof libraryIdOrName === 'number') {
        const lib = Zotero.Libraries.get(libraryIdOrName);
        return {
            library: lib || null,
            wasExplicitlyRequested: true,
            searchInput: String(libraryIdOrName),
        };
    }
    
    // It's a string - try to parse as ID first
    const parsedId = parseInt(libraryIdOrName, 10);
    if (!isNaN(parsedId)) {
        const lib = Zotero.Libraries.get(parsedId);
        if (lib) {
            return {
                library: lib,
                wasExplicitlyRequested: true,
                searchInput: libraryIdOrName,
            };
        }
    }
    
    // Look up by name (case-insensitive)
    const allLibraries = Zotero.Libraries.getAll();
    const searchLower = libraryIdOrName.toLowerCase();
    const libByName = allLibraries.find((l: any) => l.name.toLowerCase() === searchLower);
    
    return {
        library: libByName || null,
        wasExplicitlyRequested: true,
        searchInput: libraryIdOrName,
    };
}

/**
 * Result of collection lookup, including the library where the collection was found.
 */
export interface CollectionLookupResult {
    collection: Zotero.Collection;
    libraryID: number;
}

/**
 * Get collection by ID, key, or name.
 *
 * Supports:
 * - Number: Looks up by collection ID
 * - String: Checks for a key (8 alphanumeric chars), then "<libraryID>-<key>" compound format
 *   (e.g. "1-ABCD1234"), then numeric ID (digits only), then searches by name
 * - null/undefined: Returns null
 *
 * The "<libraryID>-<key>" format is resolved only in the embedded library, ignoring the
 * libraryId parameter.
 *
 * When libraryId is provided, does a full lookup (key + name) in that library first.
 * Cross-library fallback only applies when the input looks like a Zotero key (8 alphanumeric
 * chars). Name-based lookups stay scoped to the requested
 * library to avoid returning a same-named collection from the wrong library.
 *
 * @param collectionIdOrName - Collection ID, key, or name
 * @param libraryId - Optional library ID to search first (falls back to other libraries)
 * @returns Collection and its library ID, or null if not found
 */
export function getCollectionByIdOrName(
    collectionIdOrName: number | string | null | undefined,
    libraryId?: number
): CollectionLookupResult | null {
    if (collectionIdOrName == null) {
        return null;
    }
    
    // If it's a number, look up by ID
    if (typeof collectionIdOrName === 'number') {
        const collection = Zotero.Collections.get(collectionIdOrName);
        return collection ? { collection, libraryID: collection.libraryID } : null;
    }

    // Try "<libraryID>-<key>" compound format (e.g. "1-ABCD1234")
    const compoundMatch = collectionIdOrName.match(/^(\d+)-(.+)$/);
    if (compoundMatch) {
        const compoundLibId = parseInt(compoundMatch[1], 10);
        const compoundKey = compoundMatch[2];
        if (Zotero.Utilities.isValidObjectKey(compoundKey)) {
            const collection = Zotero.Collections.getByLibraryAndKey(compoundLibId, compoundKey);
            if (collection) return { collection, libraryID: collection.libraryID };
        }
    }

    const isKeyLike = Zotero.Utilities.isValidObjectKey(collectionIdOrName);
    const hasLibraryId = libraryId !== undefined && Number.isFinite(libraryId);

    // If libraryId provided, do full lookup (key + name) there first
    if (hasLibraryId) {
        const found = findCollectionInLibrary(collectionIdOrName, libraryId, isKeyLike);
        if (found) return found;
    }

    // Try numeric collection ID
    if (/^\d+$/.test(collectionIdOrName)) {
        const parsedId = parseInt(collectionIdOrName, 10);
        const collection = Zotero.Collections.get(parsedId);
        if (collection) return { collection, libraryID: collection.libraryID };
    }
    
    // Cross-library fallback: only for key-like inputs.
    // Name-based lookups stay scoped to the requested library since names like
    // "Inbox" are commonly duplicated across libraries.
    if (!isKeyLike && hasLibraryId) {
        return null;
    }

    const searchableIds = getSearchableLibraryIds();
    const otherLibraryIds = Zotero.Libraries.getAll()
        .map((lib: any) => lib.libraryID as number)
        .filter((id: number) => !hasLibraryId || id !== libraryId);
    const sortedLibraryIds = [
        ...otherLibraryIds.filter(id => searchableIds.includes(id)),
        ...otherLibraryIds.filter(id => !searchableIds.includes(id)),
    ];

    for (const libId of sortedLibraryIds) {
        const found = findCollectionInLibrary(collectionIdOrName, libId, isKeyLike);
        if (found) return found;
    }
    
    return null;
}

/**
 * Try to find a collection in a single library by key, then by name.
 */
function findCollectionInLibrary(
    input: string,
    libraryId: number,
    isKeyLike: boolean
): CollectionLookupResult | null {
    if (isKeyLike) {
        const collection = Zotero.Collections.getByLibraryAndKey(libraryId, input);
        if (collection) return { collection, libraryID: collection.libraryID };
    }
    
    const collections = Zotero.Collections.getByLibrary(libraryId, true);
    const inputLower = input.toLowerCase();
    const byName = collections.find(
        (c: Zotero.Collection) => c.name.toLowerCase() === inputLower
    );
    if (byName) return { collection: byName, libraryID: byName.libraryID };
    
    return null;
}

/**
 * Format creators array into a string for display.
 */
export function formatCreatorsString(creators: any[] | undefined): string | null {
    if (!creators || creators.length === 0) return null;
    
    const names = creators.map(c => {
        if (c.lastName && c.firstName) {
            return c.lastName;
        } else if (c.lastName) {
            return c.lastName;
        } else if (c.name) {
            return c.name;
        }
        return null;
    }).filter(Boolean);
    
    if (names.length === 0) return null;
    if (names.length === 1) return names[0] as string;
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names[0]} et al.`;
}

/**
 * Extract year from a date string.
 */
export function extractYear(dateStr: string | undefined): number | null {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{4})/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Brief library info for error responses.
 */
export interface AvailableLibraryInfo {
    library_id: number;
    name: string;
}

/**
 * Get searchable library IDs from the store.
 * Pro users: synced libraries only. Free users: all local libraries.
 */
export function getSearchableLibraryIds(): number[] {
    return store.get(searchableLibraryIdsAtom);
}

/**
 * Check if a library ID is searchable.
 */
export function isLibrarySearchable(libraryId: number): boolean {
    return getSearchableLibraryIds().includes(libraryId);
}

/**
 * Get a list of searchable libraries for error responses.
 * Only returns libraries that are in searchableLibraryIdsAtom.
 */
export function getSearchableLibraries(): AvailableLibraryInfo[] {
    const searchableIds = getSearchableLibraryIds();
    return Zotero.Libraries.getAll()
        .filter((lib: any) => searchableIds.includes(lib.libraryID))
        .map((lib: any) => ({
            library_id: lib.libraryID,
            name: lib.name,
        }));
}

/**
 * Get a list of available libraries for error responses.
 * @deprecated Use getSearchableLibraries() for agent handlers to enforce library restrictions.
 */
export function getAvailableLibraries(): AvailableLibraryInfo[] {
    return Zotero.Libraries.getAll().map((lib: any) => ({
        library_id: lib.libraryID,
        name: lib.name,
    }));
}

/**
 * Result of library lookup with validation information.
 */
export interface LibraryLookupResult {
    /** The found library, or null if not found */
    library: _ZoteroTypes.Library.LibraryLike | null;
    /** Whether a library was explicitly requested (vs defaulting to user library) */
    wasExplicitlyRequested: boolean;
    /** The input that was used to search (for error messages) */
    searchInput: string | null;
}

/**
 * Error codes for library validation failures.
 */
export type LibraryValidationErrorCode = 'library_not_found' | 'library_not_searchable';

/**
 * Result of library validation with searchability check.
 */
export interface LibraryValidationResult {
    /** Whether the library is valid and searchable */
    valid: boolean;
    /** The validated library (only set if valid) */
    library?: _ZoteroTypes.Library.LibraryLike;
    /** Error message (only set if invalid) */
    error?: string;
    /** Error code (only set if invalid) */
    error_code?: LibraryValidationErrorCode;
    /** List of searchable libraries for error response (only set if invalid) */
    available_libraries?: AvailableLibraryInfo[];
}

/**
 * Validate library access for agent handlers.
 * Checks both that the library exists AND that it's in searchableLibraryIdsAtom.
 * 
 * @param libraryIdOrName - Library ID or name (null/undefined defaults to user library)
 * @returns Validation result with library or error details
 */
export function validateLibraryAccess(libraryIdOrName: number | string | null | undefined): LibraryValidationResult {
    const lookupResult = getLibraryByIdOrName(libraryIdOrName);
    
    // Check if library was found
    if (lookupResult.wasExplicitlyRequested && !lookupResult.library) {
        return {
            valid: false,
            error: `Library not found: "${lookupResult.searchInput}"`,
            error_code: 'library_not_found',
            available_libraries: getSearchableLibraries(),
        };
    }
    
    const library = lookupResult.library!;
    
    // Check if library is searchable
    if (!isLibrarySearchable(library.libraryID)) {
        return {
            valid: false,
            error: `Library '${library.name}' (ID: ${library.libraryID}) is not synced with Beaver. Access is limited to synced libraries.`,
            error_code: 'library_not_searchable',
            available_libraries: getSearchableLibraries(),
        };
    }
    
    return {
        valid: true,
        library,
    };
}

/**
 * Get the user's preference for a deferred tool.
 * Reads from Zotero prefs with a two-level structure:
 * - toolToGroup: Maps tool names to group names
 * - groupPreferences: Maps group names to preference values
 *
 * Merges stored prefs with the defaults from deferredToolPreferences.ts
 * so that newly added tools (e.g. create_note) use their configured
 * default even before the user saves any preference change.
 */
export function getDeferredToolPreference(toolName: string): DeferredToolPreference {
    try {
        const data = store.get(deferredToolPreferencesAtom);
        const group = data.toolToGroup[toolName] ?? toolName;
        const preference = data.groupPreferences[group];
        if (preference === 'always_ask' || preference === 'always_apply' || preference === 'continue_without_applying') {
            return preference;
        }
    } catch (error) {
        logger(`getDeferredToolPreference: Failed to read preference for ${toolName}: ${error}`, 1);
    }
    return 'always_ask';
}


/**
 * Extract detailed error information for logging.
 * Returns an object with message and optional details (including stack trace).
 * 
 * @param error - The caught error
 * @returns Object with `message` (string) and `details` (string with stack trace, or null)
 */
export function extractErrorDetails(error: unknown): { message: string; details: string | null } {
    if (error instanceof Error) {
        const message = error.message || String(error);
        const details = error.stack ? `${error.message}\n${error.stack}` : null;
        return { message, details };
    }
    return { message: String(error), details: null };
}

/**
 * Result of resolving a Zotero item to a PDF attachment.
 */
export type PdfAttachmentResolveResult =
    | { resolved: true; item: Zotero.Item; key: string }
    | { resolved: false; error: string; error_code: 'not_attachment' | 'is_linked_url' | 'not_pdf' };

/**
 * Resolve a Zotero item to a PDF attachment.
 * - If the item is already a PDF attachment, returns it directly.
 * - If it's a regular item with exactly one PDF attachment, auto-resolves to that attachment.
 * - Notes, annotations, non-PDF attachments, and ambiguous items return an error.
 *
 * @param item - Zotero item to resolve
 * @param uniqueKey - Human-readable key for error messages (e.g. "1-ABCDE123")
 */
export async function resolveToPdfAttachment(
    item: Zotero.Item,
    uniqueKey: string
): Promise<PdfAttachmentResolveResult> {
    if (item.isAttachment()) {
        if (item.isPDFAttachment()) {
            return { resolved: true, item, key: uniqueKey };
        }
        if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
            return {
                resolved: false,
                error: `Attachment ${uniqueKey} is a linked URL, not a stored file. Beaver cannot access linked URL attachments.`,
                error_code: 'is_linked_url',
            };
        }
        const contentType = item.attachmentContentType || 'unknown';
        return {
            resolved: false,
            error: `Attachment ${uniqueKey} is not a PDF (type: ${contentType})`,
            error_code: 'not_pdf',
        };
    }

    if (item.isRegularItem()) {
        const info = await getAttachmentInfo(item);

        if (info.count === 1 && info.bestAttachmentKey) {
            const [libIdStr, key] = info.bestAttachmentKey.split('-');
            const resolvedItem = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libIdStr, 10), key);
            if (!resolvedItem) {
                return {
                    resolved: false,
                    error: `The id '${uniqueKey}' is a regular item with one attachment (${info.text}) but it could not be resolved.`,
                    error_code: 'not_attachment',
                };
            }
            await resolvedItem.loadAllData();
            return resolveToPdfAttachment(resolvedItem, info.bestAttachmentKey);
        }

        const message = info.count > 0
            ? `The id '${uniqueKey}' is a regular item, not an attachment. The item has ${info.count} attachments: ${info.text}`
            : `The id '${uniqueKey}' is a regular item, not an attachment. The item has no attachments.`;
        return { resolved: false, error: message, error_code: 'not_attachment' };
    }

    const kind = item.isNote() ? 'note' : item.isAnnotation() ? 'annotation' : 'non-attachment item';
    return {
        resolved: false,
        error: `The id '${uniqueKey}' is a ${kind}, not an attachment.`,
        error_code: 'not_attachment',
    };
}

export async function getAttachmentInfo(item: Zotero.Item): Promise<{ count: number, text: string, bestAttachmentKey: string | null }> {
    if (!item.isRegularItem()) {
        return {
            count: 0,
            text: '',
            bestAttachmentKey: null,
        };
    }

    await Zotero.Items.loadDataTypes([item], ["childItems"]);
    const attachmentIDs = item.getAttachments();
    const bestAttachment = await item.getBestAttachment();
    const bestAttachmentKey = bestAttachment ? `${bestAttachment.libraryID}-${bestAttachment.key}` : null;

    const pdfAttachmentKeys = attachmentIDs
        .map(id => Zotero.Items.get(id))
        .filter(attachment => attachment && isSupportedItem(attachment))
        .map(attachment => {
            const key = `${attachment.libraryID}-${attachment.key}`;
            const isPrimary = bestAttachmentKey && key === bestAttachmentKey;
            // return isPrimary ? `${key} (primary)` : key;
            return isPrimary
                ? `'${attachment.attachmentFilename}' (${key}, primary)`
                : `'${attachment.attachmentFilename}' (${key})`;
        });

    return {
        count: pdfAttachmentKeys.length,
        text: pdfAttachmentKeys.join(', '),
        bestAttachmentKey: bestAttachmentKey,
    }
}
