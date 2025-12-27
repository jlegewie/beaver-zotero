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
import { safeIsInTrash } from '../utils/zoteroUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../utils/sync';
import { syncLibraryIdsAtom, syncWithZoteroAtom } from '../../react/atoms/profile';
import { userIdAtom } from '../../react/atoms/auth';

import { store } from '../../react/store';
import { isAttachmentOnServer } from '../utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../../react/utils/sourceUtils';
import { serializeAttachment, serializeItem } from '../utils/zoteroSerializers';
import { FindReferenceData, findExistingReference } from '../../react/utils/findExistingReference';
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
    WSZoteroItemSearchRequest,
    WSZoteroItemSearchResponse,
    ZoteroItemSearchResultItem,
} from './agentProtocol';
import { searchItemsByTopic, searchItemsByAuthor, searchItemsByPublication, TopicSearchParams, ZoteroItemSearchFilters } from '../../react/utils/searchTools';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from './pdf';

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
 * @param syncLibraryIds - List of library IDs configured for sync
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID (for pending sync detection)
 * @returns Status information for the item
 */
async function computeItemStatus(
    item: Zotero.Item,
    syncLibraryIds: number[],
    syncWithZotero: any,
    userId: string | null
): Promise<ZoteroItemStatus> {
    const isSyncedLibrary = syncLibraryIds.includes(item.libraryID);
    const trashState = safeIsInTrash(item);
    const isInTrash = trashState === true;
    const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
    const passesSyncFilters = availableLocallyOrOnServer && (await syncingItemFilterAsync(item));
    
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
    const syncLibraryIds = store.get(syncLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Track keys to avoid duplicates when including parents/attachments
    const itemKeys = new Set<string>();
    const attachmentKeys = new Set<string>();

    // Collect Zotero items to serialize
    const itemsToSerialize: Zotero.Item[] = [];
    const attachmentsToSerialize: Zotero.Item[] = [];

    const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

    // Phase 1: Collect primary items from request (don't access parentID/getAttachments yet)
    const primaryItems: Zotero.Item[] = [];
    const referenceToItem = new Map<string, Zotero.Item>();
    
    for (const reference of request.items) {
        try {
            const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
            if (!zoteroItem) {
                errors.push({
                    reference,
                    error: 'Item not found in local database',
                    error_code: 'not_found'
                });
                continue;
            }
            primaryItems.push(zoteroItem);
            referenceToItem.set(makeKey(reference.library_id, reference.zotero_key), zoteroItem);
        } catch (error: any) {
            logger(`AgentService: Failed to load zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            errors.push({
                reference,
                error: 'Failed to load item',
                error_code: 'load_failed'
            });
        }
    }

    // Phase 2: Load data types for primary items BEFORE accessing parentID/getAttachments
    if (primaryItems.length > 0) {
        await Zotero.Items.loadDataTypes(primaryItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    // Phase 3: Now expand to parents and children (safe to access parentID/getAttachments)
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue; // Already recorded error in Phase 1

        try {
            if (zoteroItem.isAttachment()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!attachmentKeys.has(key)) {
                    attachmentKeys.add(key);
                    attachmentsToSerialize.push(zoteroItem);
                }

                // Include parent item if requested
                if (request.include_parents && zoteroItem.parentID) {
                    const parentItem = await Zotero.Items.getAsync(zoteroItem.parentID);
                    if (parentItem && !parentItem.isAttachment()) {
                        const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                        if (!itemKeys.has(parentKey)) {
                            itemKeys.add(parentKey);
                            itemsToSerialize.push(parentItem);
                        }
                    }
                }
            } else if (zoteroItem.isRegularItem()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!itemKeys.has(key)) {
                    itemKeys.add(key);
                    itemsToSerialize.push(zoteroItem);
                }

                // Include attachments if requested
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        const attachment = await Zotero.Items.getAsync(attachmentId);
                        if (attachment) {
                            const attKey = makeKey(attachment.libraryID, attachment.key);
                            if (!attachmentKeys.has(attKey)) {
                                attachmentKeys.add(attKey);
                                attachmentsToSerialize.push(attachment);
                            }
                        }
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
            logger(`AgentService: Failed to expand zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed'
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

    // Phase 5: Serialize all items and attachments with status
    const [itemResults, attachmentResults] = await Promise.all([
        Promise.all(itemsToSerialize.map(async (item): Promise<ItemDataWithStatus | null> => {
            const serialized = await serializeItem(item, undefined);
            const status = await computeItemStatus(item, syncLibraryIds, syncWithZotero, userId);
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
            const status = await computeItemStatus(attachment, syncLibraryIds, syncWithZotero, userId);
            
            // Determine if this is the primary attachment for its parent
            let isPrimary = false;
            if (attachment.parentID) {
                const parentItem = await Zotero.Items.getAsync(attachment.parentID);
                if (parentItem) {
                    const primaryAttachment = await parentItem.getBestAttachment();
                    isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
                }
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
    const { attachment, start_page, end_page, request_id } = request;

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
            return errorResponse(
                'PDF file is not available locally',
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

        // 5. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 6. Create extractor and get page count first
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

        // 7. Validate page range (convert 1-indexed to 0-indexed)
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

        // 8. Build page indices (0-indexed for extraction)
        const pageIndices: number[] = [];
        for (let i = startPage - 1; i < endPage; i++) {
            pageIndices.push(i);
        }

        // 9. Extract pages with OCR check enabled
        const result = await extractor.extract(pdfData, {
            pages: pageIndices,
            checkTextLayer: true, // Fail if PDF needs OCR
        });

        // 10. Build response
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
    const { attachment, pages, scale, dpi, format, jpeg_quality, request_id } = request;

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
            return errorResponse(
                'PDF file is not available locally',
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

        // 5. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 6. Create extractor and get page count first
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

        // 7. Determine which pages to render
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

        // 8. Build render options
        const renderOptions = {
            scale: scale ?? 1.0,
            dpi: dpi ?? 0,
            format: format ?? 'png' as const,
            jpegQuality: jpeg_quality ?? 85,
        };

        // 9. Render pages
        const renderResults = await extractor.renderPagesToImages(pdfData, pageIndices, renderOptions);

        // 10. Convert to base64 and build response
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
 * Handle external_reference_check_request event.
 */
export async function handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<WSExternalReferenceCheckResponse> {
    const results: ExternalReferenceCheckResult[] = [];

    // Process all items in parallel for efficiency
    const checkPromises = request.items.map(async (item): Promise<ExternalReferenceCheckResult> => {
        try {
            const referenceData: FindReferenceData = {
                title: item.title,
                date: item.date,
                DOI: item.doi,
                ISBN: item.isbn,
                creators: item.creators
            };

            const existingItem = await findExistingReference(request.library_id, referenceData);

            if (existingItem) {
                return {
                    id: item.id,
                    exists: true,
                    item: {
                        library_id: existingItem.libraryID,
                        zotero_key: existingItem.key
                    }
                };
            }

            return {
                id: item.id,
                exists: false
            };
        } catch (error) {
            logger(`AgentService: Failed to check reference ${item.id}: ${error}`, 1);
            // Return as not found on error
            return {
                id: item.id,
                exists: false
            };
        }
    });

    const resolvedResults = await Promise.all(checkPromises);
    results.push(...resolvedResults);

    const response: WSExternalReferenceCheckResponse = {
        type: 'external_reference_check',
        request_id: request.request_id,
        results
    };

    return response;
}


/**
 * Handle zotero_item_search_request event.
 * Searches the user's Zotero library and returns matching items with attachments.
 * 
 * Algorithm:
 * 1. Validate: At least one query parameter must be provided
 * 2. Apply query matching (AND logic between different query types):
 *    - topic_query: search title+abstract for each phrase (OR within)
 *    - author_query: search creator names
 *    - publication_query: search publication/journal name
 * 3. Apply filters to narrow results (year, type, libraries, tags, collections)
 * 4. Return items with attachments
 */
export async function handleZoteroItemSearchRequest(request: WSZoteroItemSearchRequest): Promise<WSZoteroItemSearchResponse> {
    // Validate: at least one query parameter must be provided
    const hasQuery = (request.topic_query && request.topic_query.length > 0) ||
                     !!request.author_query ||
                     !!request.publication_query;

    if (!hasQuery) {
        logger('handleZoteroItemSearchRequest: No query parameters provided', 1);
        return {
            type: 'zotero_item_search',
            request_id: request.request_id,
            items: [],
        };
    }

    // Get synced library IDs and apply libraries_filter if provided
    // let syncLibraryIds = store.get(syncLibraryIdsAtom);
    
    // if (syncLibraryIds.length === 0) {
    //     logger('handleZoteroItemSearchRequest: No synced libraries configured', 1);
    //     return {
    //         type: 'zotero_item_search',
    //         request_id: request.request_id,
    //         items: [],
    //     };
    // }

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
        libraryIds.push(...Zotero.Libraries.getAll().map(lib => lib.libraryID));
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

    // Build filters from request
    const filters: ZoteroItemSearchFilters = {
        year_min: request.year_min,
        year_max: request.year_max,
        item_type_filter: request.item_type_filter,
        libraries_filter: libraryIds.length > 0 ? libraryIds : undefined,
        collections_filter: collectionKeys.length > 0 ? collectionKeys : undefined,
        tags_filter: request.tags_filter,
        limit: request.limit,
    };

    // Step 1: Execute queries based on what's provided
    let items: Zotero.Item[] = [];

    // Topic query (searches title + abstract)
    if (request.topic_query && request.topic_query.length > 0) {
        logger('handleZoteroItemSearchRequest: Topic query', libraryIds, request.topic_query, filters, 1);
        const topicParams: TopicSearchParams = {
            topic_phrases: request.topic_query,
            author_query: request.author_query,
            publication_query: request.publication_query,
        };
        items = await searchItemsByTopic(libraryIds, topicParams, filters);
    }
    // Author-only query
    else if (request.author_query && !request.publication_query) {
        logger('handleZoteroItemSearchRequest: Author query', {
            libraryIds,
            author_query: request.author_query,
            filters,
        }, 1);
        items = await searchItemsByAuthor(libraryIds, request.author_query, filters);
    }
    // Publication-only query
    else if (request.publication_query && !request.author_query) {
        logger('handleZoteroItemSearchRequest: Publication query', {
            libraryIds,
            publication_query: request.publication_query,
            filters,
        }, 1);
        items = await searchItemsByPublication(libraryIds, request.publication_query, filters);
    }
    // Both author and publication (need to intersect results)
    else if (request.author_query && request.publication_query) {
        logger('handleZoteroItemSearchRequest: Both author and publication query', {
            libraryIds,
            author_query: request.author_query,
            publication_query: request.publication_query,
            filters,
        }, 1);
        // Search by author first
        const authorItems = await searchItemsByAuthor(libraryIds, request.author_query, {
            ...filters,
            limit: 0, // No limit for intermediate result
        });
        
        // Filter by publication
        const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;
        const authorItemKeys = new Set(authorItems.map(item => makeKey(item.libraryID, item.key)));
        
        const publicationItems = await searchItemsByPublication(libraryIds, request.publication_query, {
            ...filters,
            limit: 0, // No limit for intermediate result
        });
        
        // Keep only items that match both
        items = publicationItems.filter(item => 
            authorItemKeys.has(makeKey(item.libraryID, item.key))
        );
    }
    logger('handleZoteroItemSearchRequest: Final items', {
        libraryIds,
        items: items.length,
    }, 1);

    // Step 2: Apply limit
    const limitedItems = request.limit > 0 ? items.slice(0, request.limit) : items;

    // Get sync configuration from store for status computation
    const syncLibraryIds = store.get(syncLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Step 3: Serialize items with attachments (using unified format)
    const resultItems: ZoteroItemSearchResultItem[] = [];
    
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
                            const status = await computeItemStatus(attachment, syncLibraryIds, syncWithZotero, userId);
                            
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
            logger(`handleZoteroItemSearchRequest: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    const response: WSZoteroItemSearchResponse = {
        type: 'zotero_item_search',
        request_id: request.request_id,
        items: resultItems,
    };

    return response;
}