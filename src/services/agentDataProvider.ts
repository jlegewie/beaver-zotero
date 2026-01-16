/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../utils/logger';
import { ZoteroItemStatus, ItemDataWithStatus, FrontendFileStatus, AttachmentDataWithStatus } from '../../react/types/zotero';
import { safeIsInTrash, deduplicateItems, safeFileExists, isLinkedUrlAttachment } from '../utils/zoteroUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../utils/sync';
import { searchableLibraryIdsAtom, syncWithZoteroAtom } from '../../react/atoms/profile';
import { userIdAtom } from '../../react/atoms/auth';
import { getPref } from '../utils/prefs';

import { store } from '../../react/store';
import { isAttachmentOnServer } from '../utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../../react/utils/sourceUtils';
import { serializeAttachment, serializeItem } from '../utils/zoteroSerializers';
import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../react/utils/batchFindExistingReferences';
import {
    WSZoteroDataRequest,
    WSZoteroDataResponse,
    WSDataError,
    WSExternalReferenceCheckRequest,
    WSExternalReferenceCheckResponse,
    ExternalReferenceCheckResult,
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPagesResponse,
    AttachmentPagesErrorCode,
    WSPageContent,
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentPageImagesResponse,
    AttachmentPageImagesErrorCode,
    WSPageImage,
    WSZoteroAttachmentSearchRequest,
    WSZoteroAttachmentSearchResponse,
    AttachmentSearchErrorCode,
    WSPageSearchResult,
    WSSearchHit,
    WSItemSearchByMetadataRequest,
    WSItemSearchByMetadataResponse,
    ItemSearchFrontendResultItem,
    WSItemSearchByTopicRequest,
    WSItemSearchByTopicResponse,
    // Library management tools
    WSZoteroSearchRequest,
    WSZoteroSearchResponse,
    ZoteroSearchResultItem,
    WSListItemsRequest,
    WSListItemsResponse,
    ListItemsResultItem,
    WSGetMetadataRequest,
    WSGetMetadataResponse,
} from './agentProtocol';
import { searchItemsByMetadata, SearchItemsByMetadataOptions, ZoteroItemSearchFilters } from '../../react/utils/searchTools';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from './pdf';
import { semanticSearchService, SearchResult } from './semanticSearchService';
import { BeaverDB } from './database';

/**
 * Get file status information for an attachment.
 * Determines page count and availability of fulltext/page images.
 * 
 * @param attachment - Zotero attachment item
 * @param isPrimary - Whether this is the primary attachment for the parent item
 * @returns File status information
 */
async function getAttachmentFileStatus(attachment: Zotero.Item, isPrimary: boolean): Promise<FrontendFileStatus> {
    // Get the attachment mime type
    const contentType = attachment.attachmentContentType;

    // Non-PDF attachments are not currently supported for content extraction
    if (!attachment.isPDFAttachment()) {
        return {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: null,
            status: "unavailable",
            status_reason: `File type "${contentType || 'unknown'}" is not supported`,
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
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: null,
            status: "unavailable",
            status_reason: status_message,
        };
    }
    
    const fileExists = await attachment.fileExists();
    if (!fileExists) {
        return {
            is_primary: isPrimary,
            mime_type: contentType,
            page_count: null,
            status: "unavailable",
            status_reason: 'File is not available',
        };
    }
    
    // Early size check before expensive reads/parsing
    const maxFileSizeMB = getPref('maxFileSizeMB');
    const fileSize = await Zotero.Attachments.getTotalFileSize(attachment);
    
    if (fileSize) {
        const fileSizeInMB = fileSize / 1024 / 1024;
        
        if (fileSizeInMB > maxFileSizeMB) {
            return {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: null,
                status: "unavailable",
                status_reason: `File size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
            };
        }
    }
    
    // Try to analyze the PDF
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
                    return {
                        is_primary: isPrimary,
                        mime_type: contentType,
                        page_count: null,
                        status: "unavailable",
                        status_reason: 'PDF is password-protected',
                    };
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
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
            return {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: pageCount,
                status: "unavailable",
                status_reason: `PDF has ${pageCount} pages, which exceeds the ${maxPageCount}-page limit`,
            };
        }
        
        // Check if the PDF has a text layer (needs OCR if not)
        const ocrAnalysis = await extractor.analyzeOCRNeeds(pdfData);
        
        if (ocrAnalysis.needsOCR) {
            return {
                is_primary: isPrimary,
                mime_type: contentType,
                page_count: pageCount,
                status: "unavailable",
                status_reason: `Text unavailable because the PDF requires OCR. Page images are available`,
            };
        }
        
        // All checks passed - file is fully accessible
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
 * Compute sync status information for a Zotero item.
 * Determines why an item might not be available in the backend.
 * 
 * @param item - Zotero item to compute status for
 * @param syncedLibraryIds - List of library IDs configured for sync
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID (for pending sync detection)
 * @returns Status information for the item
 */
async function computeItemStatus(
    item: Zotero.Item,
    syncedLibraryIds: number[],
    syncWithZotero: any,
    userId: string | null
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
            const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
            isPendingSync = !wasAddedBeforeSync;
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
 * Handle zotero_data_request event.
 * Fetches item/attachment metadata for the requested references.
 */
export async function handleZoteroDataRequest(request: WSZoteroDataRequest): Promise<WSZoteroDataResponse> {
    const errors: WSDataError[] = [];

    // Get sync configuration from store
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Track keys to avoid duplicates when including parents/attachments
    const itemKeys = new Set<string>();
    const attachmentKeys = new Set<string>();

    // Collect Zotero items to serialize
    const itemsToSerialize: Zotero.Item[] = [];
    const attachmentsToSerialize: Zotero.Item[] = [];

    const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

    // Phase 1: Collect primary items from request IN PARALLEL
    const primaryItems: Zotero.Item[] = [];
    const referenceToItem = new Map<string, Zotero.Item>();
    
    const loadResults = await Promise.all(
        request.items.map(async (reference) => {
            try {
                const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                if (!zoteroItem) {
                    return { reference, error: 'Item not found in local database', error_code: 'not_found' as const };
                }
                return { reference, item: zoteroItem };
            } catch (error: any) {
                logger(`AgentService: Failed to load zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
                const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
                return { reference, error: 'Failed to load item', error_code: 'load_failed' as const, details };
            }
        })
    );
    
    // Process results, preserving order
    for (const result of loadResults) {
        if ('item' in result && result.item) {
            primaryItems.push(result.item);
            referenceToItem.set(makeKey(result.reference.library_id, result.reference.zotero_key), result.item);
        } else if ('error' in result) {
            errors.push({
                reference: result.reference,
                error: result.error,
                error_code: result.error_code,
                details: result.details
            });
        }
    }

    // Phase 2: Load data types for primary items BEFORE accessing parentID/getAttachments
    if (primaryItems.length > 0) {
        await Zotero.Items.loadDataTypes(primaryItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    // Phase 3: Collect all parent/attachment IDs first, then batch load
    const parentIdsToLoad = new Set<number>();
    const attachmentIdsToLoad = new Set<number>();
    
    // First pass: collect IDs and categorize items
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue;

        try {
            if (zoteroItem.isAttachment()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!attachmentKeys.has(key)) {
                    attachmentKeys.add(key);
                    attachmentsToSerialize.push(zoteroItem);
                }
                // Collect parent ID for batch loading
                if (request.include_parents && zoteroItem.parentID) {
                    parentIdsToLoad.add(zoteroItem.parentID);
                }
            } else if (zoteroItem.isRegularItem()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!itemKeys.has(key)) {
                    itemKeys.add(key);
                    itemsToSerialize.push(zoteroItem);
                }
                // Collect attachment IDs for batch loading
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        attachmentIdsToLoad.add(attachmentId);
                    }
                }
            } else {
                errors.push({
                    reference,
                    error: 'Item is not a regular item or attachment',
                    error_code: 'filtered_from_sync'
                });
            }
        } catch (error: any) {
            logger(`AgentService: Failed to categorize zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed',
                details
            });
        }
    }
    
    // Batch load parents and attachments in parallel
    const [parentItemsArray, attachmentItemsArray] = await Promise.all([
        parentIdsToLoad.size > 0 ? Zotero.Items.getAsync([...parentIdsToLoad]) : Promise.resolve([]),
        attachmentIdsToLoad.size > 0 ? Zotero.Items.getAsync([...attachmentIdsToLoad]) : Promise.resolve([])
    ]);
    
    // Create lookup maps
    const parentItemsById = new Map<number, Zotero.Item>();
    for (const item of parentItemsArray) {
        if (item) parentItemsById.set(item.id, item);
    }
    
    const attachmentItemsById = new Map<number, Zotero.Item>();
    for (const item of attachmentItemsArray) {
        if (item) attachmentItemsById.set(item.id, item);
    }
    
    // Second pass: add parents and attachments using the pre-loaded items
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue;

        try {
            if (zoteroItem.isAttachment()) {
                // Add parent item if requested (using pre-loaded data)
                if (request.include_parents && zoteroItem.parentID) {
                    const parentItem = parentItemsById.get(zoteroItem.parentID);
                    if (parentItem && !parentItem.isAttachment()) {
                        const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                        if (!itemKeys.has(parentKey)) {
                            itemKeys.add(parentKey);
                            itemsToSerialize.push(parentItem);
                        }
                    }
                }
            } else if (zoteroItem.isRegularItem()) {
                // Add attachments if requested (using pre-loaded data)
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        const attachment = attachmentItemsById.get(attachmentId);
                        if (attachment) {
                            const attKey = makeKey(attachment.libraryID, attachment.key);
                            if (!attachmentKeys.has(attKey)) {
                                attachmentKeys.add(attKey);
                                attachmentsToSerialize.push(attachment);
                            }
                        }
                    }
                }
            }
        } catch (error: any) {
            logger(`AgentService: Failed to expand zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed',
                details
            });
        }
    }

    // Phase 4: Load data for all items (including newly discovered parents and children)
    const allItems = [...itemsToSerialize, ...attachmentsToSerialize];
    if (allItems.length > 0) {
        // Load all item data in bulk
        await Zotero.Items.loadDataTypes(allItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
        
        // Load parent items for attachments (needed for isInTrash() to check parent trash status)
        const parentIds = [...new Set(
            allItems
                .filter(item => item.parentID)
                .map(item => item.parentID as number)
        )];
        if (parentIds.length > 0) {
            const parentItems = await Zotero.Items.getAsync(parentIds);
            if (parentItems.length > 0) {
                await Zotero.Items.loadDataTypes(parentItems, ["primaryData"]);
            }
        }
    }

    // Phase 5: Pre-compute primary attachments per parent (cache getBestAttachment)
    const primaryAttachmentByParentId = new Map<number, Zotero.Item | false>();
    const parentIdsForPrimaryCheck = [...new Set(
        attachmentsToSerialize
            .filter(att => att.parentID)
            .map(att => att.parentID as number)
    )];
    
    // Batch load parent items and their best attachments
    if (parentIdsForPrimaryCheck.length > 0) {
        const parentsForCheck = await Zotero.Items.getAsync(parentIdsForPrimaryCheck);
        await Promise.all(
            parentsForCheck.map(async (parentItem) => {
                if (parentItem) {
                    const bestAttachment = await parentItem.getBestAttachment();
                    primaryAttachmentByParentId.set(parentItem.id, bestAttachment || false);
                }
            })
        );
    }

    // Phase 6: Serialize all items and attachments with status
    const [itemResults, attachmentResults] = await Promise.all([
        Promise.all(itemsToSerialize.map(async (item): Promise<ItemDataWithStatus | null> => {
            const serialized = await serializeItem(item, undefined);
            const status = await computeItemStatus(item, searchableLibraryIds, syncWithZotero, userId);
            return { item: serialized, status };
        })),
        Promise.all(attachmentsToSerialize.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
            const serialized = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
            if (!serialized) {
                errors.push({
                    reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                    error: 'Attachment not available locally',
                    error_code: 'not_available'
                });
                return null;
            }
            const status = await computeItemStatus(attachment, searchableLibraryIds, syncWithZotero, userId);
            
            // Determine if this is the primary attachment for its parent (using cached data)
            let isPrimary = false;
            if (attachment.parentID) {
                const primaryAttachment = primaryAttachmentByParentId.get(attachment.parentID);
                isPrimary = primaryAttachment !== false && primaryAttachment !== undefined && attachment.id === primaryAttachment.id;
            }
            
            // Get file status (optional but recommended)
            const fileStatus = await getAttachmentFileStatus(attachment, isPrimary);
            
            return { attachment: serialized, status, file_status: fileStatus };
        }))
    ]);

    // Filter out null results
    const items = itemResults.filter((i): i is ItemDataWithStatus => i !== null);
    const attachments = attachmentResults.filter((a): a is AttachmentDataWithStatus => a !== null);

    const response: WSZoteroDataResponse = {
        type: 'zotero_data',
        request_id: request.request_id,
        items,
        attachments,
        errors: errors.length > 0 ? errors : undefined
    };

    return response;   
}


/**
 * Handle zotero_attachment_pages_request event.
 * Extracts text content from PDF attachment pages using the PDF extraction service.
 */
export async function handleZoteroAttachmentPagesRequest(
    request: WSZoteroAttachmentPagesRequest
): Promise<WSZoteroAttachmentPagesResponse> {
    const { attachment, start_page, end_page, skip_local_limits, request_id } = request;

    // Helper to create error response
    const errorResponse = (
        error: string, 
        error_code: AttachmentPagesErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentPagesResponse => ({
        type: 'zotero_attachment_pages',
        request_id,
        attachment,
        pages: [],
        total_pages,
        error,
        error_code,
    });

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id, 
            attachment.zotero_key
        );
        
        if (!zoteroItem) {
            return errorResponse(
                `Attachment not found: ${attachment.library_id}-${attachment.zotero_key}`,
                'not_found'
            );
        }

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {
            return errorResponse(
                'Item is not an attachment',
                'not_pdf'
            );
        }

        if (!zoteroItem.isPDFAttachment()) {
            const contentType = zoteroItem.attachmentContentType || 'unknown';
            return errorResponse(
                `Attachment is not a PDF (type: ${contentType})`,
                'not_pdf'
            );
        }

        // 3. Get the file path
        const filePath = await zoteroItem.getFilePathAsync();
        if (!filePath) {
            const isFileAvailableOnServer = isAttachmentOnServer(zoteroItem);
            const errorMessage = isFileAvailableOnServer
                ? 'PDF file is not available locally. It may be in remote storage, which cannot be accessed by Beaver.'
                : 'PDF file is not available locally';
            return errorResponse(
                errorMessage,
                'file_missing'
            );
        }

        // 4. Verify file exists
        const fileExists = await zoteroItem.fileExists();
        if (!fileExists) {
            return errorResponse(
                'PDF file does not exist at expected location',
                'file_missing'
            );
        }

        // 5. Check file size before reading (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxFileSizeMB = getPref('maxFileSizeMB');
            const fileSize = await Zotero.Attachments.getTotalFileSize(zoteroItem);
            
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                
                if (fileSizeInMB > maxFileSizeMB) {
                    return errorResponse(
                        `PDF file size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // 6. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 7. Create extractor and get page count first
        const extractor = new PDFExtractor();
        let totalPages: number;
        
        try {
            totalPages = await extractor.getPageCount(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    return errorResponse(
                        'PDF is password-protected',
                        'encrypted'
                    );
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    return errorResponse(
                        'PDF file is invalid or corrupted',
                        'invalid_pdf'
                    );
                }
            }
            throw error;
        }

        // 8. Check page count limit (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxPageCount = getPref('maxPageCount');
            
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `PDF has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 9. Validate page range (convert 1-indexed to 0-indexed)
        const startPage = start_page ?? 1;
        const endPage = end_page ?? totalPages;

        if (startPage < 1 || startPage > totalPages) {
            return errorResponse(
                `Start page ${startPage} is out of range (document has ${totalPages} pages)`,
                'page_out_of_range',
                totalPages
            );
        }

        if (endPage < startPage || endPage > totalPages) {
            return errorResponse(
                `End page ${endPage} is out of range (document has ${totalPages} pages)`,
                'page_out_of_range',
                totalPages
            );
        }

        // 10. Build page indices (0-indexed for extraction)
        const pageIndices: number[] = [];
        for (let i = startPage - 1; i < endPage; i++) {
            pageIndices.push(i);
        }

        // 11. Extract pages with OCR check enabled
        const result = await extractor.extract(pdfData, {
            pages: pageIndices,
            checkTextLayer: true, // Fail if PDF needs OCR
        });

        // 12. Build response
        const pages: WSPageContent[] = result.pages.map((page) => ({
            page_number: page.index + 1, // Convert back to 1-indexed
            content: page.content,
        }));

        return {
            type: 'zotero_attachment_pages',
            request_id,
            attachment,
            pages,
            total_pages: totalPages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentPagesRequest: Extraction failed: ${error}`, 1);

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse('PDF is password-protected', 'encrypted');
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return errorResponse('PDF requires OCR (no text layer)', 'no_text_layer');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse('Requested pages are out of range', 'page_out_of_range');
                default:
                    return errorResponse(
                        `Extraction failed: ${error.message}`,
                        'extraction_failed'
                    );
            }
        }

        // Unknown error
        return errorResponse(
            `Failed to extract PDF content: ${error instanceof Error ? error.message : String(error)}`,
            'extraction_failed'
        );
    }
}


/**
 * Handle zotero_attachment_page_images_request event.
 * Renders PDF attachment pages as images using the PDF extraction service.
 */
export async function handleZoteroAttachmentPageImagesRequest(
    request: WSZoteroAttachmentPageImagesRequest
): Promise<WSZoteroAttachmentPageImagesResponse> {
    const { attachment, pages, scale, dpi, format, jpeg_quality, skip_local_limits, request_id } = request;

    // Helper to create error response
    const errorResponse = (
        error: string, 
        error_code: AttachmentPageImagesErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentPageImagesResponse => ({
        type: 'zotero_attachment_page_images',
        request_id,
        attachment,
        pages: [],
        total_pages,
        error,
        error_code,
    });

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id, 
            attachment.zotero_key
        );
        
        if (!zoteroItem) {
            return errorResponse(
                `Attachment not found: ${attachment.library_id}-${attachment.zotero_key}`,
                'not_found'
            );
        }

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {
            return errorResponse(
                'Item is not an attachment',
                'not_pdf'
            );
        }

        if (!zoteroItem.isPDFAttachment()) {
            const contentType = zoteroItem.attachmentContentType || 'unknown';
            return errorResponse(
                `Attachment is not a PDF (type: ${contentType})`,
                'not_pdf'
            );
        }

        // 3. Get the file path
        const filePath = await zoteroItem.getFilePathAsync();
        if (!filePath) {
            const isFileAvailableOnServer = isAttachmentOnServer(zoteroItem);
            const errorMessage = isFileAvailableOnServer
                ? 'PDF file is not available locally. It may be in remote storage, which cannot be accessed by Beaver.'
                : 'PDF file is not available locally';
            return errorResponse(
                errorMessage,
                'file_missing'
            );
        }

        // 4. Verify file exists
        const fileExists = await zoteroItem.fileExists();
        if (!fileExists) {
            return errorResponse(
                'PDF file does not exist at expected location',
                'file_missing'
            );
        }

        // 5. Check file size before reading (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxFileSizeMB = getPref('maxFileSizeMB');
            const fileSize = await Zotero.Attachments.getTotalFileSize(zoteroItem);
            
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                
                if (fileSizeInMB > maxFileSizeMB) {
                    return errorResponse(
                        `PDF file size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // 6. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 7. Create extractor and get page count first
        const extractor = new PDFExtractor();
        let totalPages: number;
        
        try {
            totalPages = await extractor.getPageCount(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    return errorResponse(
                        'PDF is password-protected',
                        'encrypted'
                    );
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    return errorResponse(
                        'PDF file is invalid or corrupted',
                        'invalid_pdf'
                    );
                }
            }
            throw error;
        }

        // 8. Check page count limit (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxPageCount = getPref('maxPageCount');
            
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `PDF has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 9. Determine which pages to render
        let pageIndices: number[];
        if (pages && pages.length > 0) {
            // Convert 1-indexed page numbers to 0-indexed
            pageIndices = pages.map(p => p - 1);
            
            // Validate page numbers are in range
            for (const pageNum of pages) {
                if (pageNum < 1 || pageNum > totalPages) {
                    return errorResponse(
                        `Page ${pageNum} is out of range (document has ${totalPages} pages)`,
                        'page_out_of_range',
                        totalPages
                    );
                }
            }
        } else {
            // Default to all pages
            pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        }

        // 10. Build render options
        const renderOptions = {
            scale: scale ?? 1.0,
            dpi: dpi ?? 0,
            format: format ?? 'png' as const,
            jpegQuality: jpeg_quality ?? 85,
        };

        // 11. Render pages
        const renderResults = await extractor.renderPagesToImages(pdfData, pageIndices, renderOptions);

        // 12. Convert to base64 and build response
        const pageImages: WSPageImage[] = renderResults.map((result) => {
            // Convert Uint8Array to base64
            const binaryStr = Array.from(result.data)
                .map(byte => String.fromCharCode(byte))
                .join('');
            const base64Data = btoa(binaryStr);
            
            return {
                page_number: result.pageIndex + 1, // Convert back to 1-indexed
                image_data: base64Data,
                format: result.format,
                width: result.width,
                height: result.height,
            };
        });

        return {
            type: 'zotero_attachment_page_images',
            request_id,
            attachment,
            pages: pageImages,
            total_pages: totalPages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentPageImagesRequest: Rendering failed: ${error}`, 1);

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse('PDF is password-protected', 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse('Requested pages are out of range', 'page_out_of_range');
                default:
                    return errorResponse(
                        `Rendering failed: ${error.message}`,
                        'render_failed'
                    );
            }
        }

        // Unknown error
        return errorResponse(
            `Failed to render PDF pages: ${error instanceof Error ? error.message : String(error)}`,
            'render_failed'
        );
    }
}


/**
 * Handle zotero_attachment_search_request event.
 * Searches for text within a PDF attachment using the PDF search service.
 */
export async function handleZoteroAttachmentSearchRequest(
    request: WSZoteroAttachmentSearchRequest
): Promise<WSZoteroAttachmentSearchResponse> {
    const { attachment, query, max_hits_per_page, skip_local_limits, request_id } = request;

    // Helper to create error response
    const errorResponse = (
        error: string, 
        error_code: AttachmentSearchErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentSearchResponse => ({
        type: 'zotero_attachment_search',
        request_id,
        attachment,
        query,
        total_matches: 0,
        pages_with_matches: 0,
        total_pages,
        pages: [],
        error,
        error_code,
    });

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id, 
            attachment.zotero_key
        );
        
        if (!zoteroItem) {
            return errorResponse(
                `Attachment not found: ${attachment.library_id}-${attachment.zotero_key}`,
                'not_found'
            );
        }

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {
            return errorResponse(
                'Item is not an attachment',
                'not_pdf'
            );
        }

        if (!zoteroItem.isPDFAttachment()) {
            const contentType = zoteroItem.attachmentContentType || 'unknown';
            return errorResponse(
                `Attachment is not a PDF (type: ${contentType})`,
                'not_pdf'
            );
        }

        // 3. Get the file path
        const filePath = await zoteroItem.getFilePathAsync();
        if (!filePath) {
            const isFileAvailableOnServer = isAttachmentOnServer(zoteroItem);
            const errorMessage = isFileAvailableOnServer
                ? 'PDF file is not available locally. It may be in remote storage, which cannot be accessed by Beaver.'
                : 'PDF file is not available locally';
            return errorResponse(
                errorMessage,
                'file_missing'
            );
        }

        // 4. Verify file exists
        const fileExists = await zoteroItem.fileExists();
        if (!fileExists) {
            return errorResponse(
                'PDF file does not exist at expected location',
                'file_missing'
            );
        }

        // 5. Check file size before reading (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxFileSizeMB = getPref('maxFileSizeMB');
            const fileSize = await Zotero.Attachments.getTotalFileSize(zoteroItem);
            
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                
                if (fileSizeInMB > maxFileSizeMB) {
                    return errorResponse(
                        `PDF file size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // 6. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 7. Create extractor and get page count first
        const extractor = new PDFExtractor();
        let totalPages: number;
        
        try {
            totalPages = await extractor.getPageCount(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    return errorResponse(
                        'PDF is password-protected',
                        'encrypted'
                    );
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    return errorResponse(
                        'PDF file is invalid or corrupted',
                        'invalid_pdf'
                    );
                }
            }
            throw error;
        }

        // 8. Check page count limit (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxPageCount = getPref('maxPageCount');
            
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `PDF has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 9. Perform search
        const searchResult = await extractor.search(pdfData, query, {
            maxHitsPerPage: max_hits_per_page ?? 100,
        });

        // 10. Convert to response format
        const pages: WSPageSearchResult[] = searchResult.pages.map((page) => ({
            page_index: page.pageIndex,
            label: page.label,
            match_count: page.matchCount,
            score: page.score,
            text_length: page.textLength,
            hits: page.hits.map((hit): WSSearchHit => ({
                bbox: hit.bbox,
                role: hit.role,
                weight: hit.weight,
                matched_text: hit.matchedText,
            })),
        }));

        return {
            type: 'zotero_attachment_search',
            request_id,
            attachment,
            query,
            total_matches: searchResult.totalMatches,
            pages_with_matches: searchResult.pagesWithMatches,
            total_pages: totalPages,
            pages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentSearchRequest: Search failed: ${error}`, 1);

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse('PDF is password-protected', 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                default:
                    return errorResponse(
                        `Search failed: ${error.message}`,
                        'search_failed'
                    );
            }
        }

        // Unknown error
        return errorResponse(
            `Failed to search PDF: ${error instanceof Error ? error.message : String(error)}`,
            'search_failed'
        );
    }
}


/**
 * Handle external_reference_check_request event.
 * 
 * Uses batch lookups for optimal performance:
 * - Phase 1: Batch DOI/ISBN lookup across all libraries in 2 queries
 * - Phase 2: Batch title candidate collection in 1 query
 * - Phase 3: Single batch load of all candidate item data
 * - Phase 4: In-memory fuzzy matching
 * 
 * If library_ids is provided, only search those libraries.
 * If library_ids is not provided or empty, search all accessible libraries.
 */
export async function handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<WSExternalReferenceCheckResponse> {
    // Determine which libraries to search
    const libraryIds: number[] = request.library_ids && request.library_ids.length > 0
        ? request.library_ids
        : Zotero.Libraries.getAll().map(lib => lib.libraryID);

    // Convert request items to batch format
    const batchItems: BatchReferenceCheckItem[] = request.items.map(item => ({
        id: item.id,
        data: {
            title: item.title,
            date: item.date,
            DOI: item.doi,
            ISBN: item.isbn,
            creators: item.creators
        }
    }));

    // Use batch lookup for all items at once
    let batchResults;
    try {
        batchResults = await batchFindExistingReferences(batchItems, libraryIds);
    } catch (error) {
        logger(`AgentService: Batch reference check failed: ${error}`, 1);
        // Return all as not found on error
        batchResults = batchItems.map(item => ({ id: item.id, item: null }));
    }

    // Convert batch results to response format
    const results: ExternalReferenceCheckResult[] = batchResults.map(result => {
        if (result.item) {
            return {
                id: result.id,
                exists: true,
                item: {
                    library_id: result.item.libraryID,
                    zotero_key: result.item.key
                }
            };
        } else {
            return {
                id: result.id,
                exists: false
            };
        }
    });

    const response: WSExternalReferenceCheckResponse = {
        type: 'external_reference_check',
        request_id: request.request_id,
        results
    };

    return response;
}


/**
 * Handle item_search_by_metadata_request event.
 * Searches the user's Zotero library by metadata and returns matching items with attachments.
 * 
 * Algorithm:
 * 1. Validate: At least one query parameter must be provided
 * 2. Apply query matching (AND logic between different query types):
 *    - title_query: search title field (substring match)
 *    - author_query: search creator names
 *    - publication_query: search publication/journal name
 * 3. Apply filters to narrow results (year, type, libraries, tags, collections)
 * 4. Return items with attachments
 */
export async function handleItemSearchByMetadataRequest(
    request: WSItemSearchByMetadataRequest
): Promise<WSItemSearchByMetadataResponse> {
    // Validate: at least one query parameter must be provided
    const hasQuery = !!request.title_query ||
                     !!request.author_query ||
                     !!request.publication_query;

    if (!hasQuery) {
        logger('handleItemSearchByMetadataRequest: No query parameters provided', 1);
        return {
            type: 'item_search_by_metadata',
            request_id: request.request_id,
            items: [],
        };
    }

    // Apply libraries_filter if provided
    const libraryIds: number[] = [];
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        // Convert library names/IDs to library IDs
        for (const libraryFilter of request.libraries_filter) {
            if (typeof libraryFilter === 'number') {
                libraryIds.push(libraryFilter);
            } else if (typeof libraryFilter === 'string') {
                // Could be a library ID as string or a library name
                const libraryIdNum = parseInt(libraryFilter, 10);
                if (!isNaN(libraryIdNum)) {
                    // It's a number as string
                    libraryIds.push(libraryIdNum);
                } else {
                    // It's a library name - find matching libraries
                    const allLibraries = Zotero.Libraries.getAll();
                    for (const lib of allLibraries) {
                        if (lib.name.toLowerCase().includes(libraryFilter.toLowerCase())) {
                            libraryIds.push(lib.libraryID);
                        }
                    }
                }
            }
        }
    } else {
        const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
        libraryIds.push(...searchableLibraryIds);
    }

    // Convert collections_filter names to keys if needed
    const collectionKeys: string[] = [];
    if (request.collections_filter && request.collections_filter.length > 0) {
        for (const collectionFilter of request.collections_filter) {
            if (typeof collectionFilter === 'string') {
                // Could be a key or a name
                // Check if it looks like a Zotero key (8 alphanumeric characters)
                if (/^[A-Z0-9]{8}$/i.test(collectionFilter)) {
                    collectionKeys.push(collectionFilter);
                } else {
                    // Treat as name, search for matching collections across libraries
                    for (const libraryId of Zotero.Libraries.getAll().map(lib => lib.libraryID)) {
                        const collections = Zotero.Collections.getByLibrary(libraryId);
                        for (const collection of collections) {
                            if (collection.name.toLowerCase().includes(collectionFilter.toLowerCase())) {
                                collectionKeys.push(collection.key);
                            }
                        }
                    }
                }
            } else if (typeof collectionFilter === 'number') {
                // It's a collection ID - convert to key
                const collection = Zotero.Collections.get(collectionFilter);
                if (collection) {
                    collectionKeys.push(collection.key);
                }
            }
        }
    }

    logger('handleItemSearchByMetadataRequest: Metadata search', {
        libraryIds,
        title_query: request.title_query,
        author_query: request.author_query,
        publication_query: request.publication_query,
    }, 1);

    // Collect unique items across all libraries
    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    // Search each library using searchItemsByMetadata
    for (const libraryId of libraryIds) {
        const options: SearchItemsByMetadataOptions = {
            title_query: request.title_query,
            author_query: request.author_query,
            publication_query: request.publication_query,
            year_min: request.year_min,
            year_max: request.year_max,
            item_type: request.item_type_filter,
            tags: request.tags_filter,
            collection_key: collectionKeys.length > 0 ? collectionKeys[0] : undefined,
            limit: request.limit,
            join_mode: 'all', // AND logic between query params
        };

        try {
            const results = await searchItemsByMetadata(libraryId, options);
            for (const item of results) {
                if (item.isRegularItem() && !item.deleted) {
                    const key = makeKey(item.libraryID, item.key);
                    if (!uniqueItems.has(key)) {
                        uniqueItems.set(key, item);
                    }
                }
            }
        } catch (error) {
            logger(`handleItemSearchByMetadataRequest: Error searching library ${libraryId}: ${error}`, 1);
        }

        // Early exit if we have enough results (fetch extra to account for cross-library duplicates)
        const preDedupBuffer = request.limit * 2;
        if (request.limit > 0 && uniqueItems.size >= preDedupBuffer) {
            break;
        }
    }

    // Convert to array
    let items = Array.from(uniqueItems.values());

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    items = deduplicateItems(items, 1);
    
    logger('handleItemSearchByMetadataRequest: Final items', {
        libraryIds,
        items: items.length,
    }, 1);

    // Apply limit
    const limitedItems = request.limit > 0 ? items.slice(0, request.limit) : items;

    // Get sync configuration from store for status computation
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Step 3: Serialize items with attachments (using unified format)
    const resultItems: ItemSearchFrontendResultItem[] = [];
    
    // Load all item data in bulk for efficiency
    if (limitedItems.length > 0) {
        await Zotero.Items.loadDataTypes(limitedItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    for (const item of limitedItems) {
        try {
            const isValidItem = syncingItemFilter(item);
            if (!isValidItem) {
                continue;
            }
            // Serialize the item
            const itemData = await serializeItem(item, undefined);

            // Get and serialize attachments using unified format
            const attachmentIds = item.getAttachments();
            const attachments: AttachmentDataWithStatus[] = [];

            if (attachmentIds.length > 0) {
                const attachmentItems = await Zotero.Items.getAsync(attachmentIds);
                const primaryAttachment = await item.getBestAttachment();
                await Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData"]);

                for (const attachment of attachmentItems) {
                    const isValidAttachment = syncingItemFilter(attachment);
                    if (isValidAttachment) {
                        const attachmentData = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
                        if (attachmentData) {
                            // Compute sync status
                            const status = await computeItemStatus(attachment, searchableLibraryIds, syncWithZotero, userId);
                            
                            // Get file status for this attachment
                            const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
                            const fileStatus = await getAttachmentFileStatus(attachment, isPrimary);
                            
                            // Build unified attachment structure
                            attachments.push({
                                attachment: attachmentData,
                                status,
                                file_status: fileStatus,
                            });
                        }
                    }
                }
            }

            resultItems.push({
                item: itemData,
                attachments,
            });
        } catch (error) {
            logger(`handleItemSearchByMetadataRequest: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    const response: WSItemSearchByMetadataResponse = {
        type: 'item_search_by_metadata',
        request_id: request.request_id,
        items: resultItems,
    };

    return response;
}


/**
 * Handle item_search_by_topic_request event.
 * Searches the user's Zotero library by topic using semantic search and returns matching items.
 * 
 * Algorithm:
 * 1. Use semantic search service to find items by topic similarity
 * 2. Apply filters (year, libraries, etc.)
 * 3. Serialize items with attachments and similarity scores
 * 4. Return items sorted by similarity
 */
export async function handleItemSearchByTopicRequest(
    request: WSItemSearchByTopicRequest
): Promise<WSItemSearchByTopicResponse> {
    // Get database instance from global addon
    const db = Zotero.Beaver?.db as BeaverDB | null;
    if (!db) {
        logger('handleItemSearchByTopicRequest: Database not available', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    // Resolve library IDs from filter
    const libraryIds: number[] = [];
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        for (const libraryFilter of request.libraries_filter) {
            if (typeof libraryFilter === 'number') {
                libraryIds.push(libraryFilter);
            } else if (typeof libraryFilter === 'string') {
                const libraryIdNum = parseInt(libraryFilter, 10);
                if (!isNaN(libraryIdNum)) {
                    libraryIds.push(libraryIdNum);
                } else {
                    // Library name lookup
                    const allLibraries = Zotero.Libraries.getAll();
                    for (const lib of allLibraries) {
                        if (lib.name.toLowerCase().includes(libraryFilter.toLowerCase())) {
                            libraryIds.push(lib.libraryID);
                        }
                    }
                }
            }
        }
    } else {
        // Default to searchable libraries if no filter provided
        const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
        libraryIds.push(...searchableLibraryIds);
    }

    // Convert collections_filter names to keys if needed
    const collectionKeys: string[] = [];
    if (request.collections_filter && request.collections_filter.length > 0) {
        for (const collectionFilter of request.collections_filter) {
            if (typeof collectionFilter === 'string') {
                // Could be a key or a name
                // Check if it looks like a Zotero key (8 alphanumeric characters)
                if (/^[A-Z0-9]{8}$/i.test(collectionFilter)) {
                    collectionKeys.push(collectionFilter);
                } else {
                    // Treat as name, search for matching collections across libraries
                    for (const libraryId of libraryIds) {
                        const collections = Zotero.Collections.getByLibrary(libraryId);
                        for (const collection of collections) {
                            if (collection.name.toLowerCase().includes(collectionFilter.toLowerCase())) {
                                collectionKeys.push(collection.key);
                            }
                        }
                    }
                }
            } else if (typeof collectionFilter === 'number') {
                // It's a collection ID - convert to key
                const collection = Zotero.Collections.get(collectionFilter);
                if (collection) {
                    collectionKeys.push(collection.key);
                }
            }
        }
    }

    logger('handleItemSearchByTopicRequest: Searching by topic', {
        topic_query: request.topic_query,
        libraryIds: libraryIds.length > 0 ? libraryIds : 'all',
        collectionKeys: collectionKeys.length > 0 ? collectionKeys : 'all',
        limit: request.limit,
    }, 1);

    // Create search service and run semantic search
    const searchService = new semanticSearchService(db, 512);
    
    let searchResults: SearchResult[];
    try {
        searchResults = await searchService.search(request.topic_query, {
            topK: request.limit * 4, // Fetch extra to account for filtering
            minSimilarity: 0.3,
            libraryIds: libraryIds.length > 0 ? libraryIds : undefined,
        });
    } catch (error) {
        logger(`handleItemSearchByTopicRequest: Semantic search failed: ${error}`, 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    logger(`handleItemSearchByTopicRequest: Semantic search returned ${searchResults.length} results`, 1);

    if (searchResults.length === 0) {
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    // Load items from search results
    const itemIds = searchResults.map(r => r.itemId);
    const items = await Zotero.Items.getAsync(itemIds);
    let validItems = items.filter((item): item is Zotero.Item => item !== null);

    if (validItems.length === 0) {
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    // Load item data (needed for deduplication which checks title, DOI, ISBN, creators)
    await Zotero.Items.loadDataTypes(validItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    validItems = deduplicateItems(validItems, 1);
    const deduplicatedItemIds = new Set(validItems.map(item => item.id));
    
    // Create a map for item lookup by ID
    const itemById = new Map<number, Zotero.Item>();
    for (const item of validItems) {
        itemById.set(item.id, item);
    }
    
    // Filter searchResults to only include items that survived deduplication
    searchResults = searchResults.filter(result => deduplicatedItemIds.has(result.itemId));

    // Create similarity map
    const similarityByItemId = new Map<number, number>();
    for (const result of searchResults) {
        similarityByItemId.set(result.itemId, result.similarity);
    }

    // Get sync configuration from store for status computation
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Serialize items with attachments and similarity
    const resultItems: ItemSearchFrontendResultItem[] = [];

    for (const searchResult of searchResults) {
        const item = itemById.get(searchResult.itemId);
        if (!item) continue;

        // Apply filters
        // Year filter
        if (request.year_min || request.year_max) {
            const yearStr = item.getField('date');
            const yearMatch = yearStr ? String(yearStr).match(/\d{4}/) : null;
            const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
            
            if (year) {
                if (request.year_min && year < request.year_min) continue;
                if (request.year_max && year > request.year_max) continue;
            }
        }

        // Author filter
        if (request.author_filter && request.author_filter.length > 0) {
            const creators = item.getCreators();
            const creatorLastNames = creators.map(c => (c.lastName || '').toLowerCase());
            const matchesAuthor = request.author_filter.some(authorName => 
                creatorLastNames.some(lastName => lastName.includes(authorName.toLowerCase()))
            );
            if (!matchesAuthor) continue;
        }

        // Tags filter
        if (request.tags_filter && request.tags_filter.length > 0) {
            const itemTags = item.getTags().map(t => t.tag.toLowerCase());
            const matchesTag = request.tags_filter.some(tag => 
                itemTags.includes(tag.toLowerCase())
            );
            if (!matchesTag) continue;
        }

        // Collections filter
        if (collectionKeys.length > 0) {
            const itemCollections = item.getCollections();
            const itemCollectionKeys = itemCollections.map(collectionId => {
                const collection = Zotero.Collections.get(collectionId);
                return collection ? collection.key : null;
            }).filter((key): key is string => key !== null);
            
            const matchesCollection = collectionKeys.some(key => 
                itemCollectionKeys.includes(key)
            );
            if (!matchesCollection) continue;
        }

        // Validate item is regular item and not in trash
        const isValidItem = syncingItemFilter(item);
        if (!isValidItem) continue;

        try {
            const itemData = await serializeItem(item, undefined);

            // Get and serialize attachments
            const attachmentIds = item.getAttachments();
            const attachments: AttachmentDataWithStatus[] = [];

            if (attachmentIds.length > 0) {
                const attachmentItems = await Zotero.Items.getAsync(attachmentIds);
                const primaryAttachment = await item.getBestAttachment();
                await Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData"]);

                for (const attachment of attachmentItems) {
                    const isValidAttachment = syncingItemFilter(attachment);
                    if (isValidAttachment) {
                        const attachmentData = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
                        if (attachmentData) {
                            const status = await computeItemStatus(attachment, searchableLibraryIds, syncWithZotero, userId);
                            const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
                            const fileStatus = await getAttachmentFileStatus(attachment, isPrimary);
                            
                            attachments.push({
                                attachment: attachmentData,
                                status,
                                file_status: fileStatus,
                            });
                        }
                    }
                }
            }

            resultItems.push({
                item: itemData,
                attachments,
                similarity: searchResult.similarity,
            });

            // Check limit
            if (request.limit > 0 && resultItems.length >= request.limit) {
                break;
            }
        } catch (error) {
            logger(`handleItemSearchByTopicRequest: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    logger(`handleItemSearchByTopicRequest: Returning ${resultItems.length} items`, 1);

    const response: WSItemSearchByTopicResponse = {
        type: 'item_search_by_topic',
        request_id: request.request_id,
        items: resultItems,
    };

    return response;
}


// =============================================================================
// Library Management Tool Handlers
// =============================================================================

/**
 * Format creators array into a string for display.
 */
function formatCreatorsString(creators: any[] | undefined): string | null {
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
function extractYear(dateStr: string | undefined): number | null {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{4})/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Get library by ID or name, or return the user's default library.
 * 
 * Supports:
 * - Number: Looks up by library ID
 * - String: First tries to parse as ID, then looks up by name
 * - null/undefined: Returns user's default library
 */
function getLibraryByIdOrName(libraryIdOrName: number | string | null | undefined): _ZoteroTypes.Library.LibraryLike {
    if (libraryIdOrName == null) {
        // Default to user's library
        return Zotero.Libraries.userLibrary;
    }
    
    // If it's a number, look up by ID
    if (typeof libraryIdOrName === 'number') {
        const lib = Zotero.Libraries.get(libraryIdOrName);
        if (lib) return lib;
        // Fall back to user library if not found
        return Zotero.Libraries.userLibrary;
    }
    
    // It's a string - try to parse as ID first
    const parsedId = parseInt(libraryIdOrName, 10);
    if (!isNaN(parsedId)) {
        const lib = Zotero.Libraries.get(parsedId);
        if (lib) return lib;
    }
    
    // Look up by name
    const allLibraries = Zotero.Libraries.getAll();
    const libByName = allLibraries.find((l: any) => l.name === libraryIdOrName);
    if (libByName) return libByName;
    
    // Fall back to user library if not found
    return Zotero.Libraries.userLibrary;
}

/**
 * Handle zotero_search request from backend.
 * Uses Zotero's native search API.
 */
export async function handleZoteroSearchRequest(
    request: WSZoteroSearchRequest
): Promise<WSZoteroSearchResponse> {
    logger(`handleZoteroSearchRequest: Processing ${request.conditions.length} conditions`, 1);
    
    try {
        const library = getLibraryByIdOrName(request.library_id);
        
        // Create search object
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;
        
        // Set join mode first (if 'any')
        if (request.join_mode === 'any') {
            search.addCondition('joinMode', 'any', '');
        }
        
        // Add search conditions
        for (const condition of request.conditions) {
            let operator = condition.operator;
            let value = condition.value ?? '';
            
            // Map operator names if needed
            const operatorMap: Record<string, string> = {
                'is': 'is',
                'isNot': 'isNot',
                'contains': 'contains',
                'doesNotContain': 'doesNotContain',
                'beginsWith': 'beginsWith',
                'isLessThan': 'isLessThan',
                'isGreaterThan': 'isGreaterThan',
                'isBefore': 'isBefore',
                'isAfter': 'isAfter',
                'isInTheLast': 'isInTheLast',
            };
            
            operator = operatorMap[operator] || operator;

            // Handle search for empty fields
            if (operator === 'is' && (value === null || value === undefined || value === '')) {
                operator = 'doesNotContain';
                value = '';
            }
            
            try {
                
                search.addCondition(
                    condition.field as _ZoteroTypes.Search.Conditions,
                    operator as _ZoteroTypes.Search.Operator,
                    value as string | number
                );
            } catch (err) {
                logger(`handleZoteroSearchRequest: Invalid condition ${condition.field} ${operator}: ${err}`, 1);
                // Continue with other conditions or throw error
            }
        }

        // Item type: Regular items only
        search.addCondition('itemType', 'isNot', 'attachment');
        search.addCondition('itemType', 'isNot', 'note');
        search.addCondition('itemType', 'isNot', 'annotation');
        
        // Set recursive search
        if (request.recursive) {
            search.addCondition('recursive', 'true', '');
        }
        
        // Exclude child items (attachments and notes)
        if (!request.include_children) {
            search.addCondition('noChildren', 'true', '');
        }
        
        // Execute search - returns array of item IDs
        const itemIds = await search.search();
        const totalCount = itemIds.length;
        
        // Apply pagination on IDs
        const startIndex = request.offset || 0;
        const endIndex = startIndex + (request.limit || 50);
        const paginatedIds = itemIds.slice(startIndex, endIndex);
        
        // Fetch items in batch
        const zoteroItems = await Zotero.Items.getAsync(paginatedIds);
        
        // Build result items
        const items: ZoteroSearchResultItem[] = [];
        
        for (const item of zoteroItems) {
            if (!item) continue;
            
            // Get creators and format
            const creators = item.getCreators();
            const creatorsString = creators
                .map(c => c.lastName || '')
                .filter(n => n)
                .join(', ');
            
            // Get date and extract year
            const dateStr = item.getField('date') as string;
            const year = extractYear(dateStr);
            
            const resultItem: ZoteroSearchResultItem = {
                item_id: `${item.libraryID}-${item.key}`,
                item_type: item.itemType,
                title: item.getField('title') as string,
                creators: creatorsString || null,
                year: year,
            };
            
            // Include extra fields if requested
            if (request.fields && request.fields.length > 0) {
                const extraFields: Record<string, any> = {};
                for (const field of request.fields) {
                    try {
                        extraFields[field] = item.getField(field);
                    } catch (err) {
                        // Field not applicable for this item type
                    }
                }
                if (Object.keys(extraFields).length > 0) {
                    resultItem.extra_fields = extraFields;
                }
            }
            
            items.push(resultItem);
        }
        
        logger(`handleZoteroSearchRequest: Returning ${items.length}/${totalCount} items`, 1);
        
        return {
            type: 'zotero_search',
            request_id: request.request_id,
            items,
            total_count: totalCount,
        };
    } catch (error) {
        logger(`handleZoteroSearchRequest: Error: ${error}`, 1);
        return {
            type: 'zotero_search',
            request_id: request.request_id,
            items: [],
            total_count: 0,
            error: String(error),
            error_code: 'search_failed',
        };
    }
}

/**
 * Handle list_items request from backend.
 * Lists items in a library, collection, or by tag.
 */
export async function handleListItemsRequest(
    request: WSListItemsRequest
): Promise<WSListItemsResponse> {
    logger(`handleListItemsRequest: collection=${request.collection_key}, tag=${request.tag}`, 1);
    
    try {
        const library = getLibraryByIdOrName(request.library_id);
        const libraryName = library.name;
        let collectionName: string | null = null;
        
        // Build search to list items
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID || Zotero.Libraries.userLibraryID;
        
        // Add collection filter if specified (supports both key and name)
        if (request.collection_key) {
            let collection: any = null;
            
            // First try to find by key
            collection = Zotero.Collections.getByLibraryAndKey(library.libraryID, request.collection_key);
            
            // If not found by key, try to find by name
            if (!collection) {
                // getByLibrary with true = recursive (all collections in library)
                const allCollections = Zotero.Collections.getByLibrary(library.libraryID, true);
                collection = allCollections.find((c: any) => c.name === request.collection_key);
            }
            
            if (collection) {
                collectionName = collection.name;
                search.addCondition('collectionID', 'is', String(collection.id));
                search.addCondition('recursive', 'true', '');
            } else {
                return {
                    type: 'list_items',
                    request_id: request.request_id,
                    items: [],
                    total_count: 0,
                    error: `Collection not found: ${request.collection_key}`,
                    error_code: 'collection_not_found',
                };
            }
        }
        
        // Add tag filter if specified
        if (request.tag) {
            search.addCondition('tag', 'is', request.tag);
        }
        
        // Filter by item types
        if (request.item_types && request.item_types.length > 0) {
            for (const itemType of request.item_types) {
                search.addCondition('itemType', 'is', itemType);
            }
        }
        
        // Exclude attachments and notes from top-level results
        search.addCondition('noChildren', 'true', '');
        
        // Execute search
        const itemIds = await search.search();
        const totalCount = itemIds.length;
        
        // Get full items for sorting
        const itemsWithData: { id: number; item: any; sortValue: any }[] = [];
        for (const itemId of itemIds) {
            try {
                const item = await Zotero.Items.getAsync(itemId);
                if (!item) continue;
                
                let sortValue: any;
                switch (request.sort_by) {
                    case 'dateAdded':
                        sortValue = item.dateAdded || '';
                        break;
                    case 'dateModified':
                        sortValue = item.dateModified || '';
                        break;
                    case 'title':
                        sortValue = (item.getField ? item.getField('title') : '') || '';
                        break;
                    case 'creator': {
                        const creators = item.getCreators ? item.getCreators() : [];
                        sortValue = creators.length > 0 ? (creators[0].lastName || '') : '';
                        break;
                    }
                    case 'year': {
                        const date = item.getField ? (item.getField('date') as string) : '';
                        sortValue = extractYear(date) || 0;
                        break;
                    }
                    case 'itemType':
                        sortValue = item.itemType || '';
                        break;
                    default:
                        sortValue = item.dateModified || '';
                }
                
                itemsWithData.push({ id: itemId, item, sortValue });
            } catch {
                // Skip failed items
            }
        }
        
        // Sort
        itemsWithData.sort((a, b) => {
            if (a.sortValue < b.sortValue) return request.sort_order === 'asc' ? -1 : 1;
            if (a.sortValue > b.sortValue) return request.sort_order === 'asc' ? 1 : -1;
            return 0;
        });
        
        // Apply pagination
        const paginatedItems = itemsWithData.slice(request.offset, request.offset + request.limit);
        
        // Build result items
        const items: ListItemsResultItem[] = [];
        for (const { item } of paginatedItems) {
            const creators = item.getCreators ? item.getCreators() : undefined;
            const date = item.getField ? (item.getField('date') as string) : undefined;
            
            const resultItem: ListItemsResultItem = {
                item_id: `${library.libraryID}-${item.key}`,
                item_type: item.itemType,
                title: item.getField ? (item.getField('title') as string) : undefined,
                creators: formatCreatorsString(creators),
                year: extractYear(date),
                date_added: item.dateAdded,
                date_modified: item.dateModified,
            };
            
            // Include extra fields if requested
            if (request.fields && request.fields.length > 0) {
                const extraFields: Record<string, any> = {};
                for (const field of request.fields) {
                    if (item.getField) {
                        try {
                            extraFields[field] = item.getField(field);
                        } catch {
                            // Field not applicable
                        }
                    }
                }
                if (Object.keys(extraFields).length > 0) {
                    resultItem.extra_fields = extraFields;
                }
            }
            
            items.push(resultItem);
        }
        
        logger(`handleListItemsRequest: Returning ${items.length}/${totalCount} items`, 1);
        
        return {
            type: 'list_items',
            request_id: request.request_id,
            items,
            total_count: totalCount,
            library_name: libraryName,
            collection_name: collectionName,
        };
    } catch (error) {
        logger(`handleListItemsRequest: Error: ${error}`, 1);
        return {
            type: 'list_items',
            request_id: request.request_id,
            items: [],
            total_count: 0,
            error: String(error),
            error_code: 'list_failed',
        };
    }
}

/**
 * Handle get_metadata request from backend.
 * Returns full Zotero metadata for specific items.
 */
export async function handleGetMetadataRequest(
    request: WSGetMetadataRequest
): Promise<WSGetMetadataResponse> {
    logger(`handleGetMetadataRequest: Getting metadata for ${request.item_ids.length} items`, 1);
    
    const items: Record<string, any>[] = [];
    const notFound: string[] = [];
    
    for (const itemId of request.item_ids) {
        try {
            // Parse item_id format: "<library_id>-<zotero_key>"
            const dashIndex = itemId.indexOf('-');
            if (dashIndex === -1) {
                notFound.push(itemId);
                continue;
            }
            
            const libraryId = parseInt(itemId.substring(0, dashIndex), 10);
            const key = itemId.substring(dashIndex + 1);
            
            if (isNaN(libraryId) || !key) {
                notFound.push(itemId);
                continue;
            }
            
            // Get the item
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, key);
            if (!item) {
                notFound.push(itemId);
                continue;
            }
            
            // Get full item data via toJSON()
            const itemData: Record<string, any> = item.toJSON ? item.toJSON() : {};
            itemData.item_id = itemId;
            
            // Handle field filtering
            if (request.fields && request.fields.length > 0) {
                const filteredData: Record<string, any> = {
                    item_id: itemId,
                    itemType: itemData.itemType,
                    key: itemData.key,
                };
                for (const field of request.fields) {
                    if (field in itemData) {
                        filteredData[field] = itemData[field];
                    }
                }
                // Include tags if requested
                if (request.include_tags && 'tags' in itemData) {
                    filteredData.tags = itemData.tags;
                }
                items.push(filteredData);
            } else {
                // Return all fields, but optionally exclude some
                const result = { ...itemData };
                
                if (!request.include_tags) {
                    delete result.tags;
                }
                if (!request.include_collections) {
                    delete result.collections;
                }
                
                items.push(result);
            }
            
            // Handle attachments if requested
            if (request.include_attachments && item.isRegularItem && item.isRegularItem()) {
                const attachmentIds = item.getAttachments ? item.getAttachments() : [];
                const attachments: any[] = [];
                
                for (const attachmentId of attachmentIds) {
                    try {
                        const attachment = await Zotero.Items.getAsync(attachmentId);
                        if (attachment) {
                            attachments.push({
                                attachment_id: `${libraryId}-${attachment.key}`,
                                title: attachment.getField ? attachment.getField('title') : null,
                                filename: attachment.attachmentFilename,
                                contentType: attachment.attachmentContentType,
                                path: attachment.getFilePath ? await attachment.getFilePath() : null,
                                url: attachment.getField ? attachment.getField('url') : null,
                            });
                        }
                    } catch {
                        // Skip failed attachments
                    }
                }
                
                if (attachments.length > 0) {
                    // Add to the last item we pushed
                    items[items.length - 1].attachments = attachments;
                }
            }
            
            // Handle notes if requested
            if (request.include_notes && item.isRegularItem && item.isRegularItem()) {
                const noteIds = item.getNotes ? item.getNotes() : [];
                const notes: any[] = [];
                
                for (const noteId of noteIds) {
                    try {
                        const note = await Zotero.Items.getAsync(noteId);
                        if (note && note.isNote && note.isNote()) {
                            notes.push({
                                note_id: `${libraryId}-${note.key}`,
                                title: note.getDisplayTitle ? note.getDisplayTitle() : null,
                                note: note.getNote ? note.getNote() : '',
                            });
                        }
                    } catch {
                        // Skip failed notes
                    }
                }
                
                if (notes.length > 0) {
                    items[items.length - 1].notes = notes;
                }
            }
            
        } catch (error) {
            logger(`handleGetMetadataRequest: Failed to get item ${itemId}: ${error}`, 1);
            notFound.push(itemId);
        }
    }
    
    logger(`handleGetMetadataRequest: Returning ${items.length} items, ${notFound.length} not found`, 1);
    
    return {
        type: 'get_metadata',
        request_id: request.request_id,
        items,
        not_found: notFound,
    };
}