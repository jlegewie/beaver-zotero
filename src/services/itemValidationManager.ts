import { attachmentsService } from './attachmentsService';
import { itemsService } from './itemsService';
import { isValidZoteroItem } from '../../react/utils/sourceUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/store';
import { planFeaturesAtom, syncLibraryIdsAtom } from '../../react/atoms/profile';
import { isAttachmentOnServer } from '../utils/webAPI';
import { getPref } from '../utils/prefs';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from './pdf';

/**
 * Types of item validation
 */
export enum ItemValidationType {
    LOCAL_ONLY = 'local_only',   // only local validation (fast)
    BACKEND = 'backend',         // check backend processed status
    CACHED = 'cached',           // use cached result if available, fallback to LOCAL_ONLY
    FRONTEND = 'frontend',       // frontend processing mode (comprehensive local checks, no backend)
}

/**
 * Result of item validation
 */
export interface ItemValidationResult {
    isValid: boolean;
    reason?: string;
    backendChecked: boolean;
}

/**
 * Result of validating a single attachment within a regular item
 */
export interface AttachmentValidationResult {
    isValid: boolean;
    reason?: string;
    backendChecked: boolean;
}

/**
 * Result of validating a regular item with all its attachments
 */
export interface RegularItemValidationResult {
    isValid: boolean;
    reason?: string;
    attachmentResults: Map<string, AttachmentValidationResult>;
}

/**
 * Internal validation state for caching
 */
interface ValidationCacheEntry {
    result: ItemValidationResult;
    timestamp: number;
    fileHash?: string;
}

/**
 * Options for validation
 */
export interface ItemValidationOptions {
    validationType: ItemValidationType;
    forceRefresh?: boolean;
}

/**
 * Manages item validation with caching and deduplication
 * 
 * Purpose: Business logic layer for validation
 * - Performs local and backend validation
 * - Caches results with file hash validation
 * - Deduplicates concurrent validation requests
 * 
 * Note: UI state (isValidating, etc.) is managed by atoms
 */
class ItemValidationManager {
    private validationCache = new Map<string, ValidationCacheEntry>();
    private pendingValidations = new Map<string, Promise<ItemValidationResult>>();
    
    // Cache settings
    // private readonly CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
    private readonly CACHE_DURATION_MS = 100;
    private readonly MAX_CACHE_SIZE = 1000;

    /**
     * Generate cache key from source and validation type
     */
    private getCacheKey(item: Zotero.Item, validationType: ItemValidationType): string {
        return `${item.libraryID}-${item.key}-${validationType}`;
    }

    /**
     * Clean expired cache entries and enforce size limit
     */
    private cleanCache(): void {
        const now = Date.now();
        const entries = Array.from(this.validationCache.entries());
        
        // Remove expired entries
        entries.forEach(([key, entry]) => {
            if (now - entry.timestamp > this.CACHE_DURATION_MS) {
                this.validationCache.delete(key);
            }
        });

        // Enforce cache size limit by removing oldest entries
        if (this.validationCache.size > this.MAX_CACHE_SIZE) {
            const sortedEntries = Array.from(this.validationCache.entries())
                .sort(([, a], [, b]) => a.timestamp - b.timestamp);
            
            const entriesToRemove = sortedEntries.slice(0, this.validationCache.size - this.MAX_CACHE_SIZE);
            entriesToRemove.forEach(([key]) => {
                this.validationCache.delete(key);
            });
        }
    }

    /**
     * Check if cached result is still valid
     */
    private isCacheValid(entry: ValidationCacheEntry, currentFileHash?: string): boolean {
        const now = Date.now();
        const isExpired = now - entry.timestamp > this.CACHE_DURATION_MS;
        
        if (isExpired) {
            return false;
        }

        // If we have a file hash, ensure it matches the cached one
        if (currentFileHash && entry.fileHash && entry.fileHash !== currentFileHash) {
            return false;
        }

        return true;
    }

    /**
     * Get a cached validation entry if it is still valid
     * Refreshes the timestamp to extend the cache lifetime when returning a hit
     */
    private async getCachedValidationEntry(
        item: Zotero.Item,
        validationType: ItemValidationType
    ): Promise<ValidationCacheEntry | null> {
        const cacheKey = this.getCacheKey(item, validationType);
        const cachedEntry = this.validationCache.get(cacheKey);

        if (!cachedEntry) {
            return null;
        }

        let currentFileHash: string | undefined;
        try {
            if (item && item.isAttachment()) {
                currentFileHash = await item.attachmentHash;
            }
        } catch {
            // Ignore hash lookup issues for cache validation
        }

        if (!this.isCacheValid(cachedEntry, currentFileHash)) {
            return null;
        }

        const refreshedEntry: ValidationCacheEntry = {
            ...cachedEntry,
            timestamp: Date.now()
        };

        this.validationCache.set(cacheKey, refreshedEntry);

        return refreshedEntry;
    }

    /**
     * Store a validation result in the cache
     */
    private setCacheEntry(
        item: Zotero.Item,
        validationType: ItemValidationType,
        result: ItemValidationResult,
        fileHash?: string
    ): void {
        const cacheKey = this.getCacheKey(item, validationType);
        this.validationCache.set(cacheKey, {
            result,
            timestamp: Date.now(),
            fileHash
        });
    }

    /**
     * Perform local validation checks
     */
    private async performLocalValidation(item: Zotero.Item): Promise<{ isValid: boolean; reason?: string; isServerOnly?: boolean }> {
        // 1. Use existing frontend validation
        const localValidation = await isValidZoteroItem(item);
        if (!localValidation.valid) {
            return { isValid: false, reason: localValidation.error };
        }

        // 2. Get the Zotero item for file size validation
        if (!item || !item.isAttachment()) {
            return { isValid: true }; // Non-attachments pass local validation
        }

        // 3. Check file availability (same logic as syncingItemFilterAsync)
        const isLocalFile = await item.fileExists();
        const isServerFile = isAttachmentOnServer(item);
        
        // If file is not available locally or on server, it is invalid
        if (!isLocalFile && !isServerFile) {
            return { isValid: false, reason: 'File not available locally or on server' };
        }

        // Skip file size check if file is on server only
        // Server-only files will be downloaded during upload process
        if (!isLocalFile && isServerFile) {
            return { isValid: true, isServerOnly: true };
        }

        try {
            const fileSize = await Zotero.Attachments.getTotalFileSize(item);
            const fileSizeInMB = fileSize / 1024 / 1024;
            const planFeatures = store.get(planFeaturesAtom);
            const sizeLimit = planFeatures.uploadFileSizeLimit;

            if (fileSizeInMB > sizeLimit) {
                return { 
                    isValid: false, 
                    reason: `File size (${fileSizeInMB.toFixed(1)}MB) exceeds limit (${sizeLimit}MB)` 
                };
            }
        } catch (error: any) {
            logger(`ItemValidationManager: Error checking file size for ${item.libraryID}-${item.key}: ${error.message}`, 2);
            return { isValid: false, reason: 'Unable to check file size' };
        }

        return { isValid: true };
    }

    /**
     * Perform backend validation
     * Checks if the item has been processed on the backend
     */
    private async performBackendValidation(
        item: Zotero.Item,
        fileHash: string
    ): Promise<{ isValid: boolean; reason?: string }> {
        try {
            const backendResponse = await attachmentsService.validateAttachment(
                item.libraryID,
                item.key,
                fileHash,
                item.dateAdded,
                false // don't request upload URL
            );

            // Item is valid if processed on backend
            const isValid = backendResponse.processed;
            const reason = isValid ? undefined : (backendResponse.details || 'File not processed');

            return { isValid, reason };
        } catch (error: any) {
            logger(`ItemValidationManager: Backend validation failed for ${item.libraryID}-${item.key}: ${error.message}`, 2);
            throw new Error(`Backend validation failed: ${error.message}`);
        }
    }


    /**
     * Perform frontend mode validation for attachments
     * Comprehensive local checks without backend verification.
     * Checks: PDF type, file exists, file size, page count, encryption, OCR needs
     */
    private async performFrontendAttachmentValidation(
        attachment: Zotero.Item
    ): Promise<{ isValid: boolean; reason?: string }> {
        // 1. Must be an attachment
        if (!attachment.isAttachment()) {
            return { isValid: false, reason: 'Item is not an attachment' };
        }

        // 2. Check if in trash
        if (attachment.isInTrash()) {
            return { isValid: false, reason: 'Attachment is in trash' };
        }

        // 3. Must be a PDF attachment
        const contentType = attachment.attachmentContentType;
        if (!attachment.isPDFAttachment()) {
            return { 
                isValid: false, 
                reason: `File type "${contentType || 'unknown'}" is not supported` 
            };
        }

        // 4. Check if file exists locally
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) {
            const isOnServer = isAttachmentOnServer(attachment);
            const reason = isOnServer
                ? 'File not available locally. It may be in remote storage.'
                : 'File is not available locally';
            return { isValid: false, reason };
        }

        const fileExists = await attachment.fileExists();
        if (!fileExists) {
            return { isValid: false, reason: 'File is not available' };
        }

        // 5. Check file size limits
        const maxFileSizeMB = getPref('maxFileSizeMB');
        try {
            const fileSize = await Zotero.Attachments.getTotalFileSize(attachment);
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
                    return { 
                        isValid: false, 
                        reason: `File size (${fileSizeInMB.toFixed(1)}MB) exceeds limit (${maxFileSizeMB}MB)` 
                    };
                }
            }
        } catch (error: any) {
            logger(`ItemValidationManager: Error checking file size: ${error.message}`, 2);
            return { isValid: false, reason: 'Unable to check file size' };
        }

        // 6. Analyze PDF (page count, encryption, OCR needs)
        try {
            const pdfData = await IOUtils.read(filePath);
            const extractor = new PDFExtractor();

            // Get page count (also validates PDF and detects encryption)
            let pageCount: number;
            try {
                pageCount = await extractor.getPageCount(pdfData);
            } catch (error) {
                if (error instanceof ExtractionError) {
                    if (error.code === ExtractionErrorCode.ENCRYPTED) {
                        return { isValid: false, reason: 'PDF is password-protected' };
                    } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                        return { isValid: false, reason: 'PDF file is invalid or corrupted' };
                    }
                }
                throw error;
            }

            // Check page count limit
            const maxPageCount = getPref('maxPageCount');
            if (pageCount > maxPageCount) {
                return { 
                    isValid: false, 
                    reason: `PDF has ${pageCount} pages, exceeds ${maxPageCount}-page limit` 
                };
            }

            // Check if PDF needs OCR
            const ocrAnalysis = await extractor.analyzeOCRNeeds(pdfData);
            if (ocrAnalysis.needsOCR) {
                return { 
                    isValid: false, 
                    reason: 'PDF requires OCR (no text layer)' 
                };
            }

            return { isValid: true };

        } catch (error: any) {
            logger(`ItemValidationManager: Error analyzing PDF: ${error.message}`, 2);
            return { isValid: false, reason: 'Error analyzing PDF' };
        }
    }

    /**
     * Check if item's library is synced with Beaver
     * Simple check for frontend validation
     */
    private checkLibrarySynced(item: Zotero.Item): { isValid: boolean; reason?: string } {
        // Check if library exists
        const library = Zotero.Libraries.get(item.libraryID);
        if (!library) {
            return { isValid: false, reason: 'Library not found' };
        }

        // Check if library is in synced libraries
        const syncedLibraries = store.get(syncLibraryIdsAtom);
        if (!syncedLibraries.includes(item.libraryID)) {
            return { 
                isValid: false, 
                reason: `Library "${library.name}" is excluded from Beaver. You can update this setting in Beaver Preferences.` 
            };
        }

        return { isValid: true };
    }

    /**
     * Perform frontend mode validation
     * For regular items: checks library sync status, existence and trash status
     * For attachments: checks library sync status + comprehensive file validation
     * For annotations: checks type and parent
     */
    private async performFrontendValidation(
        item: Zotero.Item
    ): Promise<{ isValid: boolean; reason?: string }> {
        // Check if library is synced/excluded from Beaver (applies to all item types)
        const libraryCheck = this.checkLibrarySynced(item);
        if (!libraryCheck.isValid) {
            return libraryCheck;
        }

        // Regular items: simple existence and trash check
        if (item.isRegularItem()) {
            if (item.isInTrash()) {
                return { isValid: false, reason: 'Item is in trash' };
            }
            return { isValid: true };
        }

        // Attachments: comprehensive file validation
        if (item.isAttachment()) {
            return this.performFrontendAttachmentValidation(item);
        }

        // Annotations: check type and parent
        if (item.isAnnotation()) {
            // Check annotation type
            const validTypes = ['highlight', 'underline', 'note', 'image'];
            if (!validTypes.includes(item.annotationType)) {
                return { isValid: false, reason: 'Invalid annotation type' };
            }

            // Check if annotation has content
            if ((item.annotationType === 'highlight' || item.annotationType === 'underline') 
                && !item.annotationText && !item.annotationComment) {
                return { isValid: false, reason: 'Annotation is empty' };
            }

            // Check parent exists and is an attachment
            const parent = item.parentItem;
            if (!parent || !parent.isAttachment()) {
                return { isValid: false, reason: 'Parent item is not an attachment' };
            }

            return { isValid: true };
        }

        // Notes not supported
        if (item.isNote()) {
            return { isValid: false, reason: 'Notes not supported' };
        }

        return { isValid: false, reason: 'Invalid item type' };
    }

    /**
     * Check for cached results in priority order for CACHED validation type
     */
    private async checkCachedResultsInPriority(item: Zotero.Item): Promise<ItemValidationResult | null> {
        // Priority order: BACKEND -> LOCAL_ONLY
        const priorityOrder = [
            ItemValidationType.BACKEND,
            ItemValidationType.LOCAL_ONLY
        ];

        // Get current file hash for cache validation
        let currentFileHash: string | undefined;
        try {
            if (item && item.isAttachment()) {
                currentFileHash = await item.attachmentHash;
            }
        } catch (error) {
            // Ignore hash errors for cache validation
        }

        for (const validationType of priorityOrder) {
            const cacheKey = this.getCacheKey(item, validationType);
            const cachedEntry = this.validationCache.get(cacheKey);
            
            if (cachedEntry && this.isCacheValid(cachedEntry, currentFileHash)) {
                logger(`ItemValidationManager: Found cached result for ${item.libraryID}-${item.key} with type ${validationType}`, 4);
                return cachedEntry.result;
            }
        }

        return null;
    }

    /**
     * Main validation method
     */
    async validateItem(item: Zotero.Item, options: ItemValidationOptions): Promise<ItemValidationResult> {
        const { validationType, forceRefresh = false } = options;
        
        // Handle CACHED validation type
        if (validationType === ItemValidationType.CACHED && !forceRefresh) {
            this.cleanCache();
            
            // Check for cached results in priority order
            const cachedResult = await this.checkCachedResultsInPriority(item);
            if (cachedResult) {
                return cachedResult;
            }
            
            // No cached results found, fall back to LOCAL_ONLY validation
            logger(`ItemValidationManager: No cached results found for ${item.libraryID}-${item.key}, falling back to LOCAL_ONLY`, 4);
            return this.validateItem(item, { 
                validationType: ItemValidationType.LOCAL_ONLY,
                forceRefresh: false 
            });
        }

        const cacheKey = this.getCacheKey(item, validationType);

        // Clean cache periodically
        this.cleanCache();

        // Check cache first (unless force refresh)
        if (!forceRefresh) {
            const cachedEntry = this.validationCache.get(cacheKey);
            if (cachedEntry) {
                // Get current file hash for cache validation
                let currentFileHash: string | undefined;
                try {
                    if (item && item.isAttachment()) {
                        currentFileHash = await item.attachmentHash;
                    }
                } catch (error) {
                    // Ignore hash errors for cache validation
                }

                if (this.isCacheValid(cachedEntry, currentFileHash)) {
                    // For local-only cached results, re-check to ensure still valid
                    // Backend validation results are authoritative and don't need re-checking
                    if (!cachedEntry.result.backendChecked) {
                        const localValidationResult = await this.performLocalValidation(item);
                        if (localValidationResult.isValid === cachedEntry.result.isValid) {
                            return cachedEntry.result;
                        }
                        logger(`ItemValidationManager: Cached local validation changed for ${item.libraryID}-${item.key}`, 4);
                    } else {
                        // Backend validation results are authoritative
                        return cachedEntry.result;
                    }
                }
            }
        }

        // Deduplicate concurrent requests
        if (this.pendingValidations.has(cacheKey)) {
            logger(`ItemValidationManager: Returning pending validation for ${item.libraryID}-${item.key}`, 4);
            return this.pendingValidations.get(cacheKey)!;
        }

        // Start new validation
        const validationPromise = this.performValidation(item, validationType);
        this.pendingValidations.set(cacheKey, validationPromise);

        try {
            const result = await validationPromise;
            
            // Cache the result
            let fileHash: string | undefined;
            try {
                if (item && item.isAttachment()) {
                    fileHash = await item.attachmentHash;
                }
            } catch (error) {
                // Ignore hash errors for caching
            }

            this.validationCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
                fileHash
            });

            return result;
        } finally {
            this.pendingValidations.delete(cacheKey);
        }
    }

    /**
     * Internal validation logic
     */
    private async performValidation(
        item: Zotero.Item, 
        validationType: ItemValidationType
    ): Promise<ItemValidationResult> {
        try {
            // ------ FRONTEND validation mode ------
            if (validationType === ItemValidationType.FRONTEND) {
                logger(`ItemValidationManager: Starting frontend validation for ${item.libraryID}-${item.key}`, 4);
                const frontendValidation = await this.performFrontendValidation(item);
                return {
                    isValid: frontendValidation.isValid,
                    reason: frontendValidation.reason,
                    backendChecked: false
                };
            }

            // ------ Step 1: Local validation (for LOCAL_ONLY and BACKEND modes) ------
            logger(`ItemValidationManager: Starting local validation for ${item.libraryID}-${item.key}`, 4);
            const localValidation = await this.performLocalValidation(item);
            
            // Return if local validation fails or validation type is local only
            if (!localValidation.isValid || validationType === ItemValidationType.LOCAL_ONLY) {
                return {
                    isValid: localValidation.isValid,
                    reason: localValidation.reason,
                    backendChecked: false
                };
            }

            // ------ Step 2: Backend validation (only for attachments) ------
            if (!item || !item.isAttachment()) {
                // TODO: This sets regular items to valid WITHOUT checking the attachments! Validate all attachments!?
                // Non-attachments that pass local validation are considered valid
                return {
                    isValid: true,
                    backendChecked: false
                };
            }

            // Get file hash for backend validation
            // For server-only files, use the synced hash instead of local hash
            let fileHash: string;
            try {
                const localHash = await item.attachmentHash;
                const serverHash = item.attachmentSyncedHash;
                
                // Prefer local hash, fall back to server hash for server-only files
                fileHash = localHash || serverHash || '';
            } catch (error: any) {
                logger(`ItemValidationManager: Unable to get file hash for ${item.libraryID}-${item.key}: ${error.message}`, 1);
                return {
                    isValid: false,
                    reason: 'Unable to get file details',
                    backendChecked: false
                };
            }

            // Check if file hash is missing (file doesn't exist locally or on server)
            if (!fileHash) {
                logger(`ItemValidationManager: Attachment ${item.libraryID}-${item.key} has no file hash (file is missing)`, 4);
                return {
                    isValid: false,
                    reason: 'File is missing',
                    backendChecked: false
                };
            }

            // Perform backend validation
            logger(`ItemValidationManager: Starting backend validation for ${item.libraryID}-${item.key}`, 4);
            const { isValid, reason } = await this.performBackendValidation(item, fileHash);

            return {
                isValid,
                reason,
                backendChecked: true
            };

        } catch (error: any) {
            logger(`ItemValidationManager: Validation failed for ${item.libraryID}-${item.key}: ${error.message}`, 1);
            return {
                isValid: false,
                reason: `Unexpected error`,
                backendChecked: false
            };
        }
    }

    /**
     * Invalidate cache for a specific item
     */
    invalidateItem(item: Zotero.Item): void {
        const localKey = this.getCacheKey(item, ItemValidationType.LOCAL_ONLY);
        const backendKey = this.getCacheKey(item, ItemValidationType.BACKEND);
        const frontendKey = this.getCacheKey(item, ItemValidationType.FRONTEND);
        
        this.validationCache.delete(localKey);
        this.validationCache.delete(backendKey);
        this.validationCache.delete(frontendKey);
        
        logger(`ItemValidationManager: Invalidated cache for ${item.libraryID}-${item.key}`, 4);
    }

    /**
     * Clear all cached validation results
     */
    clearCache(): void {
        this.validationCache.clear();
        this.pendingValidations.clear();
        logger('ItemValidationManager: Cleared all cached validation results', 3);
    }

    /**
     * Validate a regular item along with all its attachments
     * This performs local validation on all items, then batch validates with backend
     * 
     * @param item A regular Zotero item (not an attachment)
     * @returns Result containing overall validity and per-attachment results
     */
    async validateRegularItem(item: Zotero.Item): Promise<RegularItemValidationResult> {
        if (!item.isRegularItem()) {
            throw new Error('validateRegularItem can only be called on regular items');
        }

        this.cleanCache();

        // Step 1: Local validation for the regular item itself
        logger(`ItemValidationManager: Starting local validation for regular item ${item.libraryID}-${item.key}`, 4);
        const itemLocalValidation = await this.performLocalValidation(item);
        
        if (!itemLocalValidation.isValid) {
            logger(`ItemValidationManager: Regular item failed local validation: ${itemLocalValidation.reason}`, 3);
            return {
                isValid: false,
                reason: itemLocalValidation.reason,
                attachmentResults: new Map()
            };
        }

        // Step 2: Get all attachments
        const attachmentIDs = item.getAttachments();
        if (attachmentIDs.length === 0) {
            logger(`ItemValidationManager: Regular item has no attachments`, 4);
            return {
                isValid: true,
                reason: undefined,
                attachmentResults: new Map()
            };
        }

        const attachments = (await Zotero.Items.getAsync(attachmentIDs))
            .filter((attachment): attachment is Zotero.Item => Boolean(attachment));

        // Step 3: Validate attachments using cache-aware local/backend checks
        logger(`ItemValidationManager: Validating ${attachments.length} attachments`, 4);
        const attachmentResults = new Map<string, AttachmentValidationResult>();
        const backendCandidates: Array<{
            item: Zotero.Item;
            fileHash: string;
        }> = [];

        for (const attachment of attachments) {
            const attachmentKey = `${attachment.libraryID}-${attachment.key}`;

            // Prefer cached backend results when available
            const cachedBackendEntry = await this.getCachedValidationEntry(
                attachment,
                ItemValidationType.BACKEND
            );

            if (cachedBackendEntry) {
                logger(`ItemValidationManager: Using cached backend validation for ${attachmentKey}`, 4);
                attachmentResults.set(attachmentKey, {
                    ...cachedBackendEntry.result
                });
                continue;
            }

            // Perform local validation
            const localValidation = await this.performLocalValidation(attachment);
            const localResult: AttachmentValidationResult = {
                isValid: localValidation.isValid,
                reason: localValidation.reason,
                backendChecked: false
            };

            if (!localValidation.isValid) {
                logger(`ItemValidationManager: Attachment ${attachmentKey} failed local validation: ${localValidation.reason}`, 4);
                this.setCacheEntry(attachment, ItemValidationType.LOCAL_ONLY, localResult);
                this.setCacheEntry(attachment, ItemValidationType.BACKEND, localResult);
                attachmentResults.set(attachmentKey, localResult);
                continue;
            }

            // Retrieve file hash for backend validation
            // For server-only files, use the synced hash instead of local hash
            let fileHash: string | undefined;
            try {
                const localHash = await attachment.attachmentHash;
                const serverHash = attachment.attachmentSyncedHash;
                
                // Prefer local hash, fall back to server hash for server-only files
                fileHash = localHash || serverHash || '';
            } catch (error: any) {
                logger(`ItemValidationManager: Unable to get file hash for ${attachmentKey}: ${error.message}`, 2);
                const errorResult: AttachmentValidationResult = {
                    isValid: false,
                    reason: 'Unable to get file details',
                    backendChecked: false
                };
                this.setCacheEntry(attachment, ItemValidationType.LOCAL_ONLY, errorResult);
                this.setCacheEntry(attachment, ItemValidationType.BACKEND, errorResult);
                attachmentResults.set(attachmentKey, errorResult);
                continue;
            }

            if (!fileHash) {
                logger(`ItemValidationManager: Attachment ${attachmentKey} has no file hash (file is missing)`, 4);
                const missingHashResult: AttachmentValidationResult = {
                    isValid: false,
                    reason: 'File is missing',
                    backendChecked: false
                };
                this.setCacheEntry(attachment, ItemValidationType.LOCAL_ONLY, missingHashResult);
                this.setCacheEntry(attachment, ItemValidationType.BACKEND, missingHashResult);
                attachmentResults.set(attachmentKey, missingHashResult);
                continue;
            }

            // Cache successful local validation result
            this.setCacheEntry(attachment, ItemValidationType.LOCAL_ONLY, localResult, fileHash);

            backendCandidates.push({
                item: attachment,
                fileHash
            });
        }

        if (backendCandidates.length > 0) {
            logger(`ItemValidationManager: Starting backend validation for ${backendCandidates.length} attachments`, 4);
            try {
                const backendResponse = await itemsService.validateRegularItemBatch(
                    item,
                    backendCandidates.map(candidate => ({
                        item: candidate.item,
                        fileHash: candidate.fileHash
                    }))
                );

                // Check if the regular item exists in the backend
                if (!backendResponse.item.exists) {
                    logger(`ItemValidationManager: Regular item not found in backend: ${backendResponse.item.details || 'Item does not exist'}`, 3);
                    return {
                        isValid: false,
                        reason: backendResponse.item.details || 'Item not found in Beaver',
                        attachmentResults: new Map()
                    };
                }

                const backendResultsMap = new Map<string, typeof backendResponse.attachments[number]>();
                for (const backendAttachment of backendResponse.attachments) {
                    const key = `${backendAttachment.library_id}-${backendAttachment.zotero_key}`;
                    backendResultsMap.set(key, backendAttachment);
                }

                for (const candidate of backendCandidates) {
                    const key = `${candidate.item.libraryID}-${candidate.item.key}`;
                    const backendData = backendResultsMap.get(key);

                    if (!backendData) {
                        logger(`ItemValidationManager: Missing backend response for ${key}`, 2);
                        const fallbackResult: AttachmentValidationResult = {
                            isValid: false,
                            reason: 'Unexpected error',
                            backendChecked: false
                        };
                        attachmentResults.set(key, fallbackResult);
                        this.setCacheEntry(candidate.item, ItemValidationType.BACKEND, fallbackResult, candidate.fileHash);
                        continue;
                    }

                    const backendResult: AttachmentValidationResult = {
                        isValid: backendData.processed,
                        reason: backendData.processed ? undefined : (backendData.details || 'File not processed'),
                        backendChecked: true
                    };

                    attachmentResults.set(key, backendResult);
                    this.setCacheEntry(candidate.item, ItemValidationType.BACKEND, backendResult, candidate.fileHash);
                }
            } catch (error: any) {
                logger(`ItemValidationManager: Backend validation failed for regular item ${item.libraryID}-${item.key}: ${error.message}`, 2);

                for (const candidate of backendCandidates) {
                    const key = `${candidate.item.libraryID}-${candidate.item.key}`;
                    const errorResult: AttachmentValidationResult = {
                        isValid: false,
                        reason: 'Unexpected error',
                        backendChecked: false
                    };
                    attachmentResults.set(key, errorResult);
                    this.setCacheEntry(candidate.item, ItemValidationType.BACKEND, errorResult, candidate.fileHash);
                }
            }
        }

        // Ensure every attachment has a result (cached entries already handled)
        for (const attachment of attachments) {
            const key = `${attachment.libraryID}-${attachment.key}`;
            if (!attachmentResults.has(key)) {
                attachmentResults.set(key, {
                    isValid: true,
                    backendChecked: false
                });
            }
        }

        logger(`ItemValidationManager: Regular item validation complete. Attachments processed: ${attachmentResults.size}`, 4);

        return {
            isValid: true,
            reason: undefined,
            attachmentResults
        };
    }

    /**
     * Validate a regular item using frontend mode (no backend calls)
     * For regular items: checks existence and trash status
     * For attachments: comprehensive file validation (size, pages, OCR, etc.)
     * 
     * @param item A regular Zotero item (not an attachment)
     * @returns Result containing overall validity and per-attachment results
     */
    async validateRegularItemFrontend(item: Zotero.Item): Promise<RegularItemValidationResult> {
        if (!item.isRegularItem()) {
            throw new Error('validateRegularItemFrontend can only be called on regular items');
        }

        this.cleanCache();

        // Step 1: Frontend validation for the regular item itself
        logger(`ItemValidationManager: Starting frontend validation for regular item ${item.libraryID}-${item.key}`, 4);
        const itemValidation = await this.performFrontendValidation(item);
        
        if (!itemValidation.isValid) {
            logger(`ItemValidationManager: Regular item failed frontend validation: ${itemValidation.reason}`, 3);
            return {
                isValid: false,
                reason: itemValidation.reason,
                attachmentResults: new Map()
            };
        }

        // Step 2: Get all attachments
        const attachmentIDs = item.getAttachments();
        if (attachmentIDs.length === 0) {
            logger(`ItemValidationManager: Regular item has no attachments`, 4);
            return {
                isValid: true,
                reason: undefined,
                attachmentResults: new Map()
            };
        }

        const attachments = (await Zotero.Items.getAsync(attachmentIDs))
            .filter((attachment): attachment is Zotero.Item => Boolean(attachment));

        // Step 3: Validate each attachment using frontend validation
        logger(`ItemValidationManager: Frontend validating ${attachments.length} attachments`, 4);
        const attachmentResults = new Map<string, AttachmentValidationResult>();

        for (const attachment of attachments) {
            const attachmentKey = `${attachment.libraryID}-${attachment.key}`;

            // Check cache first
            const cachedEntry = await this.getCachedValidationEntry(
                attachment,
                ItemValidationType.FRONTEND
            );

            if (cachedEntry) {
                logger(`ItemValidationManager: Using cached frontend validation for ${attachmentKey}`, 4);
                attachmentResults.set(attachmentKey, { ...cachedEntry.result });
                continue;
            }

            // Perform frontend validation
            const frontendValidation = await this.performFrontendAttachmentValidation(attachment);
            const result: AttachmentValidationResult = {
                isValid: frontendValidation.isValid,
                reason: frontendValidation.reason,
                backendChecked: false
            };

            // Cache the result
            let fileHash: string | undefined;
            try {
                fileHash = await attachment.attachmentHash || '';
            } catch {
                // Ignore hash errors for caching
            }
            this.setCacheEntry(attachment, ItemValidationType.FRONTEND, result, fileHash);
            
            attachmentResults.set(attachmentKey, result);
            logger(`ItemValidationManager: Attachment ${attachmentKey} frontend validation: ${result.isValid ? 'valid' : result.reason}`, 4);
        }

        logger(`ItemValidationManager: Regular item frontend validation complete. Attachments processed: ${attachmentResults.size}`, 4);

        return {
            isValid: true,
            reason: undefined,
            attachmentResults
        };
    }

    /**
     * Get cache statistics for debugging
     */
    getCacheStats(): { size: number; pendingValidations: number } {
        return {
            size: this.validationCache.size,
            pendingValidations: this.pendingValidations.size
        };
    }
}

// Export singleton instance
export const itemValidationManager = new ItemValidationManager();
