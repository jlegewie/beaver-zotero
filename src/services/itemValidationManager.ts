import { logger } from '../utils/logger';
import { store } from '../../react/store';
import { searchableLibraryIdsAtom } from '../../react/atoms/profile';
import { selectedModelAtom } from '../../react/atoms/models';
import { isAttachmentOnServer } from '../utils/webAPI';
import { getPref } from '../utils/prefs';
import { BeaverExtractor, ExtractionError, ExtractionErrorCode } from '../beaver-extract';
import { safeFileExists } from '../utils/zoteroUtils';
import { isRemoteAccessAvailable } from './agentDataProvider/utils';
import { getReadableContentKind } from './documentExtraction/attachmentResolution';
import type { DocumentCacheMetadata } from './documentCache';
import { effectiveMaxFileSizeMB, effectiveMaxPageCount } from './attachmentLimits';

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

const REMOTE_DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Manages item validation with caching and deduplication
 * 
 * Purpose: Business logic layer for validation
 * - Performs local validation
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
     * Generate cache key from source.
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
     * Get a cached validation entry if it is still valid
     * Refreshes the timestamp to extend the cache lifetime when returning a hit
     */
    private async getCachedValidationEntry(
        item: Zotero.Item,
    ): Promise<ValidationCacheEntry | null> {
        const cacheKey = this.getCacheKey(item);
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
        result: ItemValidationResult,
        fileHash?: string
    ): void {
        const cacheKey = this.getCacheKey(item);
        this.validationCache.set(cacheKey, {
            result,
            timestamp: Date.now(),
            fileHash
        });
    }

    /**
     * Whether the client can handle OCR-only PDFs without backend text extraction.
     * True when the selected model supports vision OR plus tools (server-side OCR) are enabled.
     */
    private canHandleOCRLocally(): boolean {
        const selectedModel = store.get(selectedModelAtom);
        const supportsVision = selectedModel?.supports_vision === true;
        const requestPlusTools = getPref('requestPlusTools');
        return supportsVision || requestPlusTools;
    }

    /**
     * Convert fresh document-cache metadata into a frontend validation result.
     * Returns null when the metadata is not decisive enough to skip parser work.
     */
    private frontendValidationFromCachedMetadata(
        metadata: DocumentCacheMetadata | null
    ): { isValid: boolean; reason?: string } | null {
        // PDF-only reader: a non-PDF row (e.g. EPUB, with null errorCode and
        // pageCount) must not be interpreted through the PDF fields.
        if (!metadata || metadata.contentKind !== 'pdf') return null;

        if (metadata.errorCode === 'encrypted') {
            return { isValid: false, reason: 'PDF is password-protected' };
        }
        if (metadata.errorCode === 'invalid_pdf') {
            return { isValid: false, reason: 'PDF file is invalid or corrupted' };
        }
        if (metadata.errorCode === 'no_text_layer') {
            if (this.canHandleOCRLocally()) {
                return { isValid: true };
            }
            return {
                isValid: false,
                reason: 'PDF requires OCR (no text layer). Use a model with vision support or enable plus tools under Settings > API Keys.'
            };
        }

        if (metadata.pageCount === 0) {
            return { isValid: false, reason: 'PDF has no readable pages' };
        }
        if (metadata.pageCount != null) {
            const maxPageCount = effectiveMaxPageCount();
            if (metadata.pageCount > maxPageCount) {
                return {
                    isValid: false,
                    reason: `PDF has ${metadata.pageCount} pages, which exceeds the ${maxPageCount}-page limit.`,
                };
            }
        }

        // Successful extraction metadata proves page readability and text-layer status.
        if (metadata.errorCode === null && metadata.pageCount != null) {
            return { isValid: true };
        }

        return null;
    }

    /**
     * Frontend validation for EPUB attachments from document-cache metadata.
     * A cached successful extraction proves readability. A cache miss (or a
     * row of another kind) is treated as valid — EPUB extraction is too heavy
     * to run on the validation path, so cold EPUBs are admitted after the
     * shared existence and size checks.
     */
    private frontendValidationFromCachedEpubMetadata(
        metadata: DocumentCacheMetadata | null
    ): { isValid: boolean; reason?: string } {
        if (!metadata || metadata.contentKind !== 'epub') {
            return { isValid: true };
        }
        if (metadata.errorCode) {
            return { isValid: false, reason: 'EPUB could not be read by the local extractor' };
        }
        const epubMetadata = metadata.documentMetadata;
        if (epubMetadata?.content_kind === 'epub' && epubMetadata.sectionCount === 0) {
            return { isValid: false, reason: 'EPUB has no readable sections' };
        }
        // Image-only/scanned EPUBs have sections but zero extracted text; the
        // read path rejects them as no_text_layer, so don't admit them here.
        // Rows without the diagnostics field stay valid — unknown is not zero.
        if (epubMetadata?.content_kind === 'epub' && epubMetadata.extractedTextChars === 0) {
            return { isValid: false, reason: 'EPUB contains no extractable text' };
        }
        return { isValid: true };
    }

    /**
     * Perform frontend mode validation for attachments
     * Comprehensive local checks without backend verification.
     * Checks: readable kind (PDF/EPUB/text), file exists, file size, and for
     * PDFs page count, encryption, and OCR needs
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

        // 3. Must be a readable attachment kind (PDF, EPUB, plain text, or image)
        const contentType = attachment.attachmentContentType;
        const contentKind = getReadableContentKind(attachment);
        if (contentKind !== 'pdf' && contentKind !== 'epub' && contentKind !== 'text' && contentKind !== 'image') {
            return {
                isValid: false,
                reason: `File type "${contentType || 'unknown'}" is not supported`
            };
        }

        // 4. Check if file exists locally; download from remote storage when possible
        let filePath = await attachment.getFilePathAsync();
        if (!filePath) {
            if (!isRemoteAccessAvailable(attachment)) {
                const isOnServer = isAttachmentOnServer(attachment);
                const reason = isOnServer
                    ? 'File not available locally and remote file access is disabled in settings.'
                    : 'File is not available locally';
                return { isValid: false, reason };
            }

            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
                const timeoutPromise = new Promise<'timeout'>((resolve) => {
                    timeoutId = setTimeout(() => resolve('timeout'), REMOTE_DOWNLOAD_TIMEOUT_MS);
                });
                const result = await Promise.race([
                    Zotero.Sync.Runner.downloadFile(attachment),
                    timeoutPromise,
                ]);
                if (result === 'timeout') {
                    logger(`ItemValidationManager: Remote download timed out after ${REMOTE_DOWNLOAD_TIMEOUT_MS}ms for ${attachment.libraryID}-${attachment.key}`, 2);
                    return { isValid: false, reason: 'Unable to download file from remote storage.' };
                }
                if (!result || !result.localChanges) {
                    return { isValid: false, reason: 'Failed to download file from remote storage' };
                }
            } catch (error: any) {
                logger(`ItemValidationManager: Remote download failed for ${attachment.libraryID}-${attachment.key}: ${error?.message ?? error}`, 2);
                return { isValid: false, reason: 'Failed to download file from remote storage' };
            } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
            }

            filePath = await attachment.getFilePathAsync();
            if (!filePath) {
                return { isValid: false, reason: 'File is not available after remote download' };
            }
        }

        const fileExists = await safeFileExists(attachment);
        if (!fileExists) {
            return { isValid: false, reason: 'File is not available' };
        }

        // 5. Check file size limits
        const maxFileSizeMB = effectiveMaxFileSizeMB();
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

        // Text: no parser-level analysis needed — extraction is a plain UTF-8
        // read, so existence and size (checked above) are sufficient.
        if (contentKind === 'text') {
            return { isValid: true };
        }

        const cachedMetadata = await Zotero.Beaver?.documentCache?.getMetadata(
            { libraryId: attachment.libraryID, zoteroKey: attachment.key },
            filePath,
        );

        // EPUB: cached extraction metadata is the only additional signal —
        // extraction is too heavy to run on the validation path, so a cold
        // cache is valid (existence and size were already checked above).
        if (contentKind === 'epub') {
            return this.frontendValidationFromCachedEpubMetadata(cachedMetadata ?? null);
        }

        const cachedValidation = this.frontendValidationFromCachedMetadata(cachedMetadata ?? null);
        if (cachedValidation) {
            logger(`ItemValidationManager: Using document-cache metadata for frontend validation of ${attachment.libraryID}-${attachment.key}`, 4);
            return cachedValidation;
        }

        // 6. Analyze PDF (page count, encryption, OCR needs)
        try {
            const pdfData = await IOUtils.read(filePath);
            const extractor = new BeaverExtractor();

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
                    } else if (error.code === ExtractionErrorCode.EMPTY_DOCUMENT) {
                        return { isValid: false, reason: 'PDF has no readable pages' };
                    } else if (error.code === ExtractionErrorCode.WASM_ERROR) {
                        return { isValid: false, reason: 'PDF crashes the local PDF parser' };
                    }
                }
                throw error;
            }

            const maxPageCount = effectiveMaxPageCount();
            if (pageCount > maxPageCount) {
                return {
                    isValid: false,
                    reason: `PDF has ${pageCount} pages, which exceeds the ${maxPageCount}-page limit.`,
                };
            }

            // Check if PDF needs OCR
            // Only fail if the selected model can't handle scanned PDFs:
            // no vision support AND plus tools (server-side OCR) disabled.
            if (!this.canHandleOCRLocally()) {
                const ocrAnalysis = await extractor.analyzeOCRNeeds(pdfData);
                if (ocrAnalysis.needsOCR) {
                    return {
                        isValid: false,
                        reason: 'PDF requires OCR (no text layer). Use a model with vision support or enable plus tools under Settings > API Keys.'
                    };
                }
            }

            return { isValid: true };

        } catch (error: any) {
            if (error instanceof ExtractionError && error.code === ExtractionErrorCode.WASM_ERROR) {
                logger(`ItemValidationManager: PDF parser crashed while analyzing ${attachment.libraryID}-${attachment.key}: ${error.message}`, 2);
                return { isValid: false, reason: 'PDF crashes the local PDF parser' };
            }
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

        // Notes: check trash
        if (item.isNote()) {
            if (item.isInTrash()) {
                return { isValid: false, reason: 'Note is in trash' };
            }
            return { isValid: true };
        }

        return { isValid: false, reason: 'Invalid item type' };
    }

    /**
     * Main validation method
     */
    async validateItem(item: Zotero.Item, options: ItemValidationOptions = {}): Promise<ItemValidationResult> {
        const { forceRefresh = false } = options;
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
    private async performValidation(item: Zotero.Item): Promise<ItemValidationResult> {
        try {
            logger(`ItemValidationManager: Starting validation for ${item.libraryID}-${item.key}`, 4);
            const validation = await this.performFrontendValidation(item);
            return {
                isValid: validation.isValid,
                reason: validation.reason,
            };
        } catch (error: any) {
            logger(`ItemValidationManager: Validation failed for ${item.libraryID}-${item.key}: ${error.message}`, 1);
            return {
                isValid: false,
                reason: `Unexpected error`,
            };
        }
    }

    /**
     * Invalidate cache for a specific item
     */
    invalidateItem(item: Zotero.Item): void {
        this.validationCache.delete(this.getCacheKey(item));
        
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
     * Validate a regular item without backend calls.
     * For regular items: checks existence and trash status
     * For attachments: comprehensive file validation (size, pages, OCR, etc.)
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
            const cachedEntry = await this.getCachedValidationEntry(attachment);

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
            };

            // Cache the result
            let fileHash: string | undefined;
            try {
                fileHash = await attachment.attachmentHash || '';
            } catch {
                // Ignore hash errors for caching
            }
            this.setCacheEntry(attachment, result, fileHash);
            
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
