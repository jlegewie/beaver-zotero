import { logger } from '../utils/logger';
import { store } from '../../react/store';
import { searchableLibraryIdsAtom } from '../../react/atoms/profile';
import { isAttachmentOnServer } from '../utils/webAPI';
import { getPref } from '../utils/prefs';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from './pdf';
import { safeFileExists } from '../utils/zoteroUtils';

/**
 * Result of item validation
 */
export interface ItemValidationResult {
    isValid: boolean;
    reason?: string;
}

/**
 * Result of validating a single attachment within a regular item
 */
export interface AttachmentValidationResult {
    isValid: boolean;
    reason?: string;
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
    forceRefresh?: boolean;
}

/**
 * Manages item validation with caching and deduplication
 *
 * Purpose: Business logic layer for validation
 * - Performs comprehensive local validation (frontend path)
 * - Caches results with file hash validation
 * - Deduplicates concurrent validation requests
 *
 * Note: UI state (isValidating, etc.) is managed by atoms
 */
class ItemValidationManager {
    private validationCache = new Map<string, ValidationCacheEntry>();
    private pendingValidations = new Map<string, Promise<ItemValidationResult>>();

    // Cache settings
    private readonly CACHE_DURATION_MS = 1 * 60 * 1000; // 1 minute
    private readonly MAX_CACHE_SIZE = 1000;

    /**
     * Generate cache key from item
     */
    private getCacheKey(item: Zotero.Item): string {
        return `${item.libraryID}-${item.key}`;
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

        const fileExists = await safeFileExists(attachment);
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
    private checkLibrarySearchable(item: Zotero.Item): { isValid: boolean; reason?: string } {
        // Check if library exists
        const library = Zotero.Libraries.get(item.libraryID);
        if (!library) {
            return { isValid: false, reason: 'Library not found' };
        }

        // Check if library is in searchable libraries
        const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
        if (!searchableLibraryIds.includes(item.libraryID)) {
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
        // Check if library is searchable for Beaver (applies to all item types)
        const libraryCheck = this.checkLibrarySearchable(item);
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
     * Main validation method
     */
    async validateItem(item: Zotero.Item, options?: ItemValidationOptions): Promise<ItemValidationResult> {
        const { forceRefresh = false } = options || {};

        const cacheKey = this.getCacheKey(item);

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
                    return cachedEntry.result;
                }
            }
        }

        // Deduplicate concurrent requests
        if (this.pendingValidations.has(cacheKey)) {
            logger(`ItemValidationManager: Returning pending validation for ${item.libraryID}-${item.key}`, 4);
            return this.pendingValidations.get(cacheKey)!;
        }

        // Start new validation
        const validationPromise = this.performValidation(item);
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
        item: Zotero.Item
    ): Promise<ItemValidationResult> {
        try {
            logger(`ItemValidationManager: Starting validation for ${item.libraryID}-${item.key}`, 4);
            const validation = await this.performFrontendValidation(item);
            return {
                isValid: validation.isValid,
                reason: validation.reason
            };
        } catch (error: any) {
            logger(`ItemValidationManager: Validation failed for ${item.libraryID}-${item.key}: ${error.message}`, 1);
            return {
                isValid: false,
                reason: `Unexpected error`
            };
        }
    }

    /**
     * Invalidate cache for a specific item
     */
    invalidateItem(item: Zotero.Item): void {
        const cacheKey = this.getCacheKey(item);
        this.validationCache.delete(cacheKey);

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
     * Performs frontend validation on all items (comprehensive local checks)
     *
     * @param item A regular Zotero item (not an attachment)
     * @returns Result containing overall validity and per-attachment results
     */
    async validateRegularItem(item: Zotero.Item): Promise<RegularItemValidationResult> {
        if (!item.isRegularItem()) {
            throw new Error('validateRegularItem can only be called on regular items');
        }

        this.cleanCache();

        // Step 1: Frontend validation for the regular item itself
        logger(`ItemValidationManager: Starting validation for regular item ${item.libraryID}-${item.key}`, 4);
        const itemValidation = await this.performFrontendValidation(item);

        if (!itemValidation.isValid) {
            logger(`ItemValidationManager: Regular item failed validation: ${itemValidation.reason}`, 3);
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
        logger(`ItemValidationManager: Validating ${attachments.length} attachments`, 4);
        const attachmentResults = new Map<string, AttachmentValidationResult>();

        for (const attachment of attachments) {
            const attachmentKey = `${attachment.libraryID}-${attachment.key}`;

            // Check cache first
            const cacheKey = this.getCacheKey(attachment);
            const cachedEntry = this.validationCache.get(cacheKey);

            if (cachedEntry) {
                let currentFileHash: string | undefined;
                try {
                    if (attachment.isAttachment()) {
                        currentFileHash = await attachment.attachmentHash;
                    }
                } catch {
                    // Ignore hash errors
                }

                if (this.isCacheValid(cachedEntry, currentFileHash)) {
                    logger(`ItemValidationManager: Using cached validation for ${attachmentKey}`, 4);
                    attachmentResults.set(attachmentKey, { ...cachedEntry.result });
                    continue;
                }
            }

            // Perform frontend validation
            const frontendValidation = await this.performFrontendAttachmentValidation(attachment);
            const result: AttachmentValidationResult = {
                isValid: frontendValidation.isValid,
                reason: frontendValidation.reason
            };

            // Cache the result
            let fileHash: string | undefined;
            try {
                fileHash = await attachment.attachmentHash || '';
            } catch {
                // Ignore hash errors for caching
            }
            this.validationCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
                fileHash
            });

            attachmentResults.set(attachmentKey, result);
            logger(`ItemValidationManager: Attachment ${attachmentKey} validation: ${result.isValid ? 'valid' : result.reason}`, 4);
        }

        logger(`ItemValidationManager: Regular item validation complete. Attachments processed: ${attachmentResults.size}`, 4);

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
