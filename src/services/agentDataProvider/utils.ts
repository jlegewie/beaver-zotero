import { logger } from '../../utils/logger';
import { ZoteroItemStatus, FrontendFileStatus, AttachmentDataWithStatus } from '../../../react/types/zotero';
import { safeIsInTrash, safeFileExists, isLinkedUrlAttachment } from '../../utils/zoteroUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../../utils/sync';
import { getPref } from '../../utils/prefs';

import { isAttachmentOnServer } from '../../utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../../../react/utils/sourceUtils';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { DeferredToolPreference } from '../agentProtocol';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { serializeAttachment } from '../../utils/zoteroSerializers';
import { getPDFPageCountFromFulltext, getPDFPageCountFromWorker } from '../../../react/utils/pdfUtils';

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
 * Get file status information for an attachment.
 * Determines page count and availability of fulltext/page images.
 * Performs full PDF analysis including OCR detection.
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
 * Lightweight file status check for search results.
 * Skips expensive OCR analysis and uses efficient page count methods.
 * 
 * Uses Zotero's fulltext index for page count (instant database query),
 * falling back to PDFWorker only if needed. Does NOT read the full PDF file.
 * 
 * @param attachment - Zotero attachment item
 * @param isPrimary - Whether this is the primary attachment for the parent item
 * @returns File status information (without OCR analysis)
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
    
    const { contentType } = availabilityCheck;
    
    // Get page count using efficient methods (no full file read)
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
 * Compute sync status information for a Zotero item.
 * Determines why an item might not be available in the backend.
 * 
 * @param item - Zotero item to compute status for
 * @param syncedLibraryIds - List of library IDs configured for sync
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID (for pending sync detection)
 * @returns Status information for the item
 */
export async function computeItemStatus(
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
 * @returns Array of processed attachments with status
 */
export async function processAttachmentsParallel(
    item: Zotero.Item,
    context: AttachmentProcessingContext
): Promise<AttachmentDataWithStatus[]> {
    const attachmentIds = item.getAttachments();
    if (attachmentIds.length === 0) {
        return [];
    }

    // Fetch attachment items and primary attachment in parallel
    const [attachmentItems, primaryAttachment] = await Promise.all([
        Zotero.Items.getAsync(attachmentIds),
        item.getBestAttachment()
    ]);

    // Load data types for all attachments
    await Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData"]);

    // Process all attachments in parallel
    const attachmentPromises = attachmentItems.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
        // Validate attachment
        const isValidAttachment = syncingItemFilter(attachment);
        if (!isValidAttachment) {
            return null;
        }

        // Serialize attachment
        const attachmentData = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
        if (!attachmentData) {
            return null;
        }

        // Compute status and file status in parallel
        // Use lightweight file status to avoid reading full PDFs
        const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
        const [status, fileStatus] = await Promise.all([
            computeItemStatus(attachment, context.searchableLibraryIds, context.syncWithZotero, context.userId),
            getAttachmentFileStatusLightweight(attachment, isPrimary)
        ]);

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
