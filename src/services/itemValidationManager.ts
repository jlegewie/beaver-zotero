import { attachmentsService, ValidationResponse } from './attachmentsService';
import { fileUploader } from './FileUploader';
import { isValidZoteroItem } from '../../react/utils/sourceUtils';
import { getMimeType } from '../utils/zoteroUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/store';
import { planFeaturesAtom } from '../../react/atoms/profile';
import { isAttachmentOnServer } from '../utils/webAPI';

/**
 * Types of source validation
 */
export enum ItemValidationType {
    LOCAL_ONLY = 'local_only',          // only local validation
    PROCESSED_FILE = 'processed_file',  // processed file suffices (file_exists OR processed passes)
    FULL_FILE = 'full_file',            // requires full file (upload if missing)
    CACHED = 'cached',                  // use any available cached result (FULL_FILE > PROCESSED_FILE > LOCAL_ONLY), fallback to LOCAL_ONLY
}

/**
 * Result of source validation
 */
export interface ItemValidationResult {
    isValid: boolean;
    reason?: string;
    validationType: ItemValidationType;
    backendChecked: boolean;
    uploaded: boolean;
    isValidating: boolean;
    canUpload?: boolean;
    requiresUpload?: boolean;
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
 * Manages item validation with backend integration and file upload capabilities
 */
class ItemValidationManager {
    private validationCache = new Map<string, ValidationCacheEntry>();
    private pendingValidations = new Map<string, Promise<ItemValidationResult>>();
    
    // Cache settings
    private readonly CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
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
     * Perform local validation checks
     */
    private async performLocalValidation(item: Zotero.Item): Promise<{ isValid: boolean; reason?: string }> {
        // 1. Use existing frontend validation
        const localValidation = await isValidZoteroItem(item);
        if (!localValidation.valid) {
            return { isValid: false, reason: localValidation.error };
        }

        // 2. Get the Zotero item for file size validation
        if (!item || !item.isAttachment()) {
            return { isValid: true }; // Non-attachments pass local validation
        }

        // 3. Check file size limits (same logic as FileUploader)
        const isLocalFile = await item.fileExists();
        const isServerFile = isAttachmentOnServer(item);
        
        // If file is not available locally or on server, it is invalid
        if (!isLocalFile && !isServerFile) {
            return { isValid: false, reason: 'File not available locally or on server' };
        }

        // Skip file size check if file is on server only
        if (!isLocalFile && isServerFile) return { isValid: true };

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
     */
    private async performBackendValidation(
        item: Zotero.Item, 
        validationType: ItemValidationType,
        fileHash: string
    ): Promise<{ backendResponse: ValidationResponse; shouldUpload: boolean }> {
        const requestUrl = validationType === ItemValidationType.FULL_FILE;
        
        try {
            const backendResponse = await attachmentsService.validateAttachment(
                item.libraryID,
                item.key,
                fileHash,
                requestUrl
            );

            let shouldUpload = false;
            
            if (validationType === ItemValidationType.PROCESSED_FILE) {
                // For processed file validation, we pass if file exists OR is processed
                // No upload required
            } else {
                // For full validation, we need the file to exist
                // If it doesn't exist but we have an upload URL, we should upload
                shouldUpload = !backendResponse.file_exists && !!backendResponse.signed_upload_url;
            }

            return { backendResponse, shouldUpload };
        } catch (error: any) {
            logger(`ItemValidationManager: Backend validation failed for ${item.libraryID}-${item.key}: ${error.message}`, 2);
            throw new Error(`Backend validation failed: ${error.message}`);
        }
    }

    /**
     * Upload file using temporary upload
     */
    private async uploadFile(item: Zotero.Item, uploadUrl: string, storagePath: string, uploadMetadata: Record<string, string>): Promise<void> {
        if (!item || !item.isAttachment()) {
            throw new Error('Cannot upload non-attachment item');
        }

        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            throw new Error('File path not available for upload');
        }

        const mimeType = await getMimeType(item, filePath);

        logger(`ItemValidationManager: Uploading file for ${item.libraryID}-${item.key}`, 3);
        
        await fileUploader.uploadTemporaryFile(
            filePath,
            uploadUrl,
            storagePath,
            uploadMetadata.filehash,
            mimeType,
            uploadMetadata
        );

        logger(`ItemValidationManager: Successfully uploaded file for ${item.libraryID}-${item.key}`, 3);
    }

    /**
     * Check for cached results in priority order for CACHED validation type
     */
    private async checkCachedResultsInPriority(item: Zotero.Item): Promise<ItemValidationResult | null> {
        // Priority order: FULL_FILE -> PROCESSED_FILE -> LOCAL_ONLY
        const priorityOrder = [
            ItemValidationType.FULL_FILE,
            ItemValidationType.PROCESSED_FILE,
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
                // Return the cached result but with the CACHED validation type
                return {
                    ...cachedEntry.result,
                    validationType: ItemValidationType.CACHED
                };
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

        const enableUpload = validationType === ItemValidationType.FULL_FILE;
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
                    // For cached results from backend validation, don't re-check local validation
                    // as it may differ (file exists locally but not in backend)
                    if (cachedEntry.result.validationType === ItemValidationType.LOCAL_ONLY) {
                        const localValidationResult = await this.performLocalValidation(item);
                        if (localValidationResult.isValid == cachedEntry.result.isValid) {
                            return cachedEntry.result;
                        }
                    } else {
                        // Backend validation results are authoritative
                        return cachedEntry.result;
                    }
                    logger(`ItemValidationManager: Cached validation is different from local validation for ${item.libraryID}-${item.key}`, 4);
                }
            }
        }

        // Deduplicate concurrent requests
        if (this.pendingValidations.has(cacheKey)) {
            logger(`ItemValidationManager: Returning pending validation for ${item.libraryID}-${item.key}`, 4);
            return this.pendingValidations.get(cacheKey)!;
        }

        // Start new validation
        const validationPromise = this.performValidation(item, validationType, enableUpload);
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
        validationType: ItemValidationType,
        enableUpload: boolean
    ): Promise<ItemValidationResult> {
        const baseResult: ItemValidationResult = {
            isValid: false,
            validationType,
            backendChecked: false,
            uploaded: false,
            isValidating: true
        };

        try {
            // ------ Step 1: Local validation ------
            logger(`ItemValidationManager: Starting local validation for ${item.libraryID}-${item.key}`, 4);
            const localValidation = await this.performLocalValidation(item);
            
            // Return if local validation is invalid or validation type is local only
            if (!localValidation.isValid || validationType === ItemValidationType.LOCAL_ONLY) {
                return {
                    ...baseResult,
                    isValid: localValidation.isValid,
                    reason: localValidation.reason,
                    isValidating: false
                };
            }

            // ------ Step 2: Backend validation (only for attachments) ------
            if (!item || !item.isAttachment()) {
                // TODO: This sets regular items to valid WITHOUT checking the attachments! Validate all attachments!?
                // Non-attachments that pass local validation are considered valid
                return {
                    ...baseResult,
                    isValid: true,
                    isValidating: false
                };
            }

            // Get file hash for backend validation
            let fileHash: string;
            try {
                // Note: file hash can be undefined for missing files
                fileHash = await item.attachmentHash || '';
            } catch (error: any) {
                logger(`ItemValidationManager: Unable to get file details for ${item.libraryID}-${item.key}: ${error.message}`, 1);
                return {
                    ...baseResult,
                    isValid: false,
                    reason: 'Unable to get file details',
                    isValidating: false
                };
            }

            // Perform backend validation
            logger(`ItemValidationManager: Starting backend validation for ${item.libraryID}-${item.key}`, 4);
            const { backendResponse, shouldUpload } = await this.performBackendValidation(item, validationType, fileHash);

            // Determine if valid based on validation type
            let isValid = false;
            let reason: string | undefined;
            let requiresUpload = false;

            if (validationType === ItemValidationType.PROCESSED_FILE) {
                // Processed file: pass if file is processed
                isValid = backendResponse.processed;
                if (!isValid) {
                    // TODO: "File not synced" response needs a better message. I think it means that the file exists 
                    // in Zotero and should be synced (passes local validation) but doesn't exist in Beaver DB. Sync error?
                    reason = backendResponse.details || 'File not available';
                }
            } else {
                // Require file: require file to exist and be processed
                isValid = backendResponse.file_exists && backendResponse.processed;
                requiresUpload = shouldUpload;
                if (!isValid && !backendResponse.processed) {
                    reason = backendResponse.details || 'File not available';
                } else if (!isValid && !requiresUpload) {
                    reason = 'File upload failed';
                } else if (!isValid && requiresUpload) {
                    reason = 'File upload failed';
                }
            }

            // ------ Step 3: Upload if needed and enabled (only if file is processed) ------
            let uploaded = false;
            if (requiresUpload && enableUpload && backendResponse.signed_upload_url && backendResponse.storage_path && backendResponse.processed) {
                try {
                    logger(`ItemValidationManager: Starting file upload for ${item.libraryID}-${item.key}`, 3);
                    await this.uploadFile(item, backendResponse.signed_upload_url, backendResponse.storage_path, backendResponse.upload_metadata || {});
                    uploaded = true;
                    isValid = true;
                    reason = undefined;
                } catch (uploadError: any) {
                    logger(`ItemValidationManager: Upload failed for ${item.libraryID}-${item.key}: ${uploadError.message}`, 1);
                    reason = 'File upload failed';
                }
            }

            return {
                ...baseResult,
                isValid,
                reason,
                backendChecked: true,
                uploaded,
                isValidating: false,
                canUpload: !!backendResponse.signed_upload_url,
                requiresUpload
            };

        } catch (error: any) {
            logger(`ItemValidationManager: Validation failed for ${item.libraryID}-${item.key}: ${error.message}`, 1);
            return {
                ...baseResult,
                isValid: false,
                reason: `Validation error: ${error.message}`,
                isValidating: false
            };
        }
    }

    /**
     * Invalidate cache for a specific source
     */
    invalidateItem(item: Zotero.Item): void {
        const processedFileKey = this.getCacheKey(item, ItemValidationType.PROCESSED_FILE);
        const requireFileKey = this.getCacheKey(item, ItemValidationType.FULL_FILE);
        
        this.validationCache.delete(processedFileKey);
        this.validationCache.delete(requireFileKey);
        
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
