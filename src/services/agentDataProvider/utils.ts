import { logger } from '../../utils/logger';
import { ZoteroItemReference } from '../../../react/types/zotero';
import { ZoteroItemStatus, FrontendFileStatus, AttachmentDataWithStatus } from '../../../react/types/zotero';
import { safeIsInTrash, safeFileExists, isLinkedUrlAttachment } from '../../utils/zoteroUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../../utils/sync';
import { getPref } from '../../utils/prefs';

import { isAttachmentOnServer } from '../../utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../../../react/utils/sourceUtils';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { MuPDFService } from '../pdf/MuPDFService';
import { EXTRACTION_VERSION } from '../attachmentFileCache';
import type { AttachmentFileCacheRecord } from '../attachmentFileCache';
import { DeferredToolPreference } from '../agentProtocol';
import { isSupportedItem } from '../../utils/sync';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { serializeAttachment } from '../../utils/zoteroSerializers';
import { getPDFPageCountFromFulltext, getPDFPageCountFromWorker } from '../../../react/utils/pdfUtils';
import { TimingAccumulator } from '../../utils/timing';

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
    | { available: false; status: FrontendFileStatus }
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
                status_reason: `File type "${contentType || 'unknown'}" is not supported`,
            }
        };
    }

    // Check if the file exists locally
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        const isFileAvailableOnServer = isAttachmentOnServer(attachment);
        const status_message = isFileAvailableOnServer
            ? 'File not available locally. It may be in remote storage, which cannot be accessed by Beaver.'
            : 'File is not available locally';
        return {
            available: false,
            status: {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "unavailable",
                status_reason: status_message,
            }
        };
    }
    
    const fileExists = await attachment.fileExists();
    if (!fileExists) {
        return {
            available: false,
            status: {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "unavailable",
                status_reason: 'File is not available',
            }
        };
    }
    
    // Check file size limit
    const maxFileSizeMB = getPref('maxFileSizeMB');
    const fileSize = await Zotero.Attachments.getTotalFileSize(attachment);
    
    if (fileSize) {
        const fileSizeInMB = fileSize / 1024 / 1024;
        
        if (fileSizeInMB > maxFileSizeMB) {
            return {
                available: false,
                status: {
                    is_primary: isPrimary,
                    mime_type: contentType,
                    page_count: null,
                    status: "unavailable",
                    status_reason: `File size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
                }
            };
        }
    }
    
    return { available: true, filePath, contentType };
}

/**
 * Build a FrontendFileStatus from a cached metadata record.
 */
function fileStatusFromCache(record: AttachmentFileCacheRecord, isPrimary: boolean): FrontendFileStatus {
    const maxPageCount = getPref('maxPageCount');

    if (record.is_encrypted) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: null, status: "unavailable", status_reason: 'PDF is password-protected' };
    }
    if (record.is_invalid) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: null, status: "unavailable", status_reason: 'PDF file is invalid or corrupted' };
    }
    if (record.page_count != null && record.page_count > maxPageCount) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: record.page_count, status: "unavailable", status_reason: `PDF has ${record.page_count} pages, which exceeds the ${maxPageCount}-page limit` };
    }
    if (record.needs_ocr) {
        return { is_primary: isPrimary, mime_type: record.content_type, page_count: record.page_count, status: "unavailable", status_reason: `Text unavailable because the PDF requires OCR. Page images are available` };
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
        const stat = await IOUtils.stat(filePath);
        await cache.setMetadata({
            item_id: attachment.id,
            library_id: attachment.libraryID,
            zotero_key: attachment.key,
            file_path: filePath,
            file_mtime_ms: stat.lastModified ?? 0,
            file_size_bytes: stat.size ?? 0,
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
 * Errors are caught internally and logged — they never propagate.
 */
export async function backfillMetadataForError(
    item: Zotero.Item,
    filePath: string,
    errorCode: ExtractionErrorCode,
    totalPages: number | null,
    callerTag: string,
): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    try {
        const stat = await IOUtils.stat(filePath);
        await cache.setMetadata({
            item_id: item.id,
            library_id: item.libraryID,
            zotero_key: item.key,
            file_path: filePath,
            file_mtime_ms: stat.lastModified ?? 0,
            file_size_bytes: stat.size ?? 0,
            content_type: item.attachmentContentType || 'application/pdf',
            page_count: totalPages,
            // Encrypted/invalid: definitively no labels (can't parse PDF).
            // NO_TEXT_LAYER: page labels live in the page tree and ARE
            // readable — leave null so preload can still extract them.
            page_labels: (errorCode === ExtractionErrorCode.ENCRYPTED || errorCode === ExtractionErrorCode.INVALID_PDF) ? {} : null,
            has_text_layer: errorCode === ExtractionErrorCode.NO_TEXT_LAYER ? false : null,
            needs_ocr: errorCode === ExtractionErrorCode.NO_TEXT_LAYER,
            is_encrypted: errorCode === ExtractionErrorCode.ENCRYPTED,
            is_invalid: errorCode === ExtractionErrorCode.INVALID_PDF,
            extraction_version: EXTRACTION_VERSION,
        });
    } catch (error) {
        logger(`${callerTag}: cache backfill error: ${error}`, 1);
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

    // Cache-first: try metadata cache.
    // All records written by this handler are complete (OCR + labels resolved),
    // but backfillMetadataForError from other handlers may write records with
    // needs_ocr: null. Accept those only when terminal flags are set.
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata(attachment.id, filePath);
            if (cached && (cached.needs_ocr !== null || cached.is_encrypted || cached.is_invalid)) {
                return fileStatusFromCache(cached, isPrimary);
            }
        } catch (error) {
            logger(`getAttachmentFileStatus: cache read error: ${error}`, 1);
        }
    }

    // Cache miss: run full extraction
    try {
        const pdfData = await IOUtils.read(filePath);
        const extractor = new PDFExtractor();

        // Get page count - this also validates the PDF and detects encryption
        let pageCount: number;
        try {
            pageCount = await extractor.getPageCount(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    await persistMetadataToCache(attachment, filePath, contentType, { page_count: null, page_labels: {}, has_text_layer: null, needs_ocr: null, is_encrypted: true, is_invalid: false });
                    return {
                        is_primary: isPrimary,
                        mime_type: contentType,
                        page_count: null,
                        status: "unavailable",
                        status_reason: 'PDF is password-protected',
                    };
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    await persistMetadataToCache(attachment, filePath, contentType, { page_count: null, page_labels: {}, has_text_layer: null, needs_ocr: null, is_encrypted: false, is_invalid: true });
                    return {
                        is_primary: isPrimary,
                        mime_type: contentType,
                        page_count: null,
                        status: "unavailable",
                        status_reason: 'PDF file is invalid or corrupted',
                    };
                }
            }
            throw error;
        }

        // Check page count limit
        const maxPageCount = getPref('maxPageCount');

        if (pageCount > maxPageCount) {
            // No cache write: a full record would require OCR analysis
            // (expensive, pointless for a rejected PDF). The lightweight
            // path gets page count cheaply from fulltext/PDFWorker.
            return {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: pageCount,
                status: "unavailable",
                status_reason: `PDF has ${pageCount} pages, which exceeds the ${maxPageCount}-page limit`,
            };
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
                status_reason: `Text unavailable because the PDF requires OCR. Page images are available`,
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
            status_reason: `Error analyzing PDF`,
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
    isPrimary: boolean
): Promise<FrontendFileStatus> {
    // Check basic availability (PDF type, file exists, size limits)
    const availabilityCheck = await checkAttachmentAvailability(attachment, isPrimary);
    if (!availabilityCheck.available) {
        return availabilityCheck.status;
    }

    const { filePath, contentType } = availabilityCheck;

    // Cache-first: try metadata cache (provides richer status when available).
    // Only use cache when OCR state is resolved (needs_ocr !== null) or a
    // terminal error is present. Rows with needs_ocr === null may come
    // from backfillMetadataForError (encrypted/invalid without OCR check);
    // for those we fall through to the optimistic lightweight path below.
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (cache) {
        try {
            const cached = await cache.getMetadata(attachment.id, filePath);
            if (cached && (cached.needs_ocr !== null || cached.is_encrypted || cached.is_invalid)) {
                logger(`getAttachmentFileStatusLightweight: cache hit for item=${attachment.id}, using cached status`);
                return fileStatusFromCache(cached, isPrimary);
            }
            if (cached) {
                logger(`getAttachmentFileStatusLightweight: cache hit for item=${attachment.id} but needs_ocr=null, falling through to lightweight path`);
            }
        } catch (error) {
            logger(`getAttachmentFileStatusLightweight: cache read error: ${error}`, 1);
        }
    } else {
        logger(`getAttachmentFileStatusLightweight: cache not available (Zotero.Beaver?.attachmentFileCache is ${cache === null ? 'null' : 'undefined'})`);
    }

    // Cache miss: use lightweight methods (no full file read)
    // First try fulltext index (instant database query)
    let pageCount = await getPDFPageCountFromFulltext(attachment);

    // Fallback to PDFWorker if not indexed (reads minimal data)
    if (pageCount === null) {
        pageCount = await getPDFPageCountFromWorker(attachment);
    }

    // If both page count methods failed, the PDF is likely problematic
    // (encrypted, corrupted, or unparseable)
    if (pageCount === null) {
        return {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: null,
            status: "unavailable",
            status_reason: 'Unable to read PDF - file may be encrypted, corrupted, or invalid',
        };
    }

    // Check page count limit
    const maxPageCount = getPref('maxPageCount');

    if (pageCount > maxPageCount) {
        return {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: pageCount,
            status: "unavailable",
            status_reason: `PDF has ${pageCount} pages, which exceeds the ${maxPageCount}-page limit`,
        };
    }

    // All checks passed - file is available
    return {
        is_primary: isPrimary,
        mime_type: contentType,
        page_count: pageCount,
        status: "available",
    };
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
    options?: { syncDateCache?: Map<number, string | null> }
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

        // Compute status and file status in parallel
        // Use lightweight file status to avoid reading full PDFs
        const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
        const statusFn = () => computeItemStatus(attachment, context.searchableLibraryIds, context.syncWithZotero, context.userId, { syncDateCache });
        const fileStatusFn = () => getAttachmentFileStatusLightweight(attachment, isPrimary);

        const [status, fileStatus] = ta
            ? await Promise.all([
                ta.track('att_status_ms', statusFn),
                ta.track('att_file_status_ms', fileStatusFn),
            ])
            : await Promise.all([statusFn(), fileStatusFn()]);

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
 * Get collection by ID, key, or name.
 * 
 * Supports:
 * - Number: Looks up by collection ID
 * - String: Checks for a key (8 alphanumeric chars), then numeric ID (digits only), then searches by name
 * - null/undefined: Returns null
 * 
 * @param collectionIdOrName - Collection ID, key, or name
 * @param libraryId - Optional library ID to narrow the search (recommended for better performance)
 * @returns Collection object or null if not found
 */
export function getCollectionByIdOrName(
    collectionIdOrName: number | string | null | undefined,
    libraryId?: number
): Zotero.Collection | null {
    if (collectionIdOrName == null) {
        return null;
    }
    
    // If it's a number, look up by ID
    if (typeof collectionIdOrName === 'number') {
        return Zotero.Collections.get(collectionIdOrName) || null;
    }
    
    // It's a string - try different approaches
    
    // Check if it looks like a Zotero key (8 alphanumeric characters)
    if (/^[A-Z0-9]{8}$/i.test(collectionIdOrName)) {
        // If we have a library ID, use it
        if (libraryId !== undefined) {
            const collection = Zotero.Collections.getByLibraryAndKey(libraryId, collectionIdOrName);
            if (collection) return collection;
        } else {
            // Search across all libraries
            const allLibraries = Zotero.Libraries.getAll();
            for (const lib of allLibraries) {
                const collection = Zotero.Collections.getByLibraryAndKey(lib.libraryID, collectionIdOrName);
                if (collection) return collection;
            }
        }
    }

    // If it's a purely numeric string, try to parse as collection ID
    if (/^\d+$/.test(collectionIdOrName)) {
        const parsedId = parseInt(collectionIdOrName, 10);
        const collection = Zotero.Collections.get(parsedId);
        if (collection) return collection;
    }
    
    // Look up by name
    const librariesToSearch = libraryId !== undefined 
        ? [libraryId] 
        : Zotero.Libraries.getAll().map(lib => lib.libraryID);
    
    const collectionNameLower = collectionIdOrName.toLowerCase();
    for (const libId of librariesToSearch) {
        const collections = Zotero.Collections.getByLibrary(libId, true);
        const collectionByName = collections.find(
            (c: Zotero.Collection) => c.name.toLowerCase() === collectionNameLower
        );
        if (collectionByName) return collectionByName;
    }
    
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
 */
export function getDeferredToolPreference(toolName: string): DeferredToolPreference {
    try {
        const prefString = getPref('deferredToolPreferences');
        if (prefString && typeof prefString === 'string') {
            const data = JSON.parse(prefString);
            const toolToGroup = data.toolToGroup || {};
            const groupPreferences = data.groupPreferences || {};
            
            // Get the group for this tool (fallback to tool name itself)
            const group = toolToGroup[toolName] ?? toolName;
            
            // Get the preference for this group (fallback to 'always_ask')
            const preference = groupPreferences[group];
            if (preference === 'always_ask' || preference === 'always_apply' || preference === 'continue_without_applying') {
                return preference;
            }
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
