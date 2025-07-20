import { InputSource } from '../../react/types/sources';
import { attachmentsService, ValidationResponse } from './attachmentsService';
import { fileUploader } from './FileUploader';
import { getZoteroItem, isSourceValid } from '../../react/utils/sourceUtils';
import { getMimeType } from '../utils/zoteroUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { planFeaturesAtom } from '../../react/atoms/profile';
import { userIdAtom } from '../../react/atoms/auth';

/**
 * Types of source validation
 */
export enum SourceValidationType {
    LOCAL_ONLY = 'local_only',          // only local validation
    PROCESSED_FILE = 'processed_file',  // processed file suffices (file_exists OR processed passes)
    FULL_FILE = 'full_file',            // requires full file (upload if missing)
    CACHED = 'cached',                  // use any available cached result (FULL_FILE > PROCESSED_FILE > LOCAL_ONLY), fallback to LOCAL_ONLY
}

/**
 * Result of source validation
 */
export interface SourceValidationResult {
    isValid: boolean;
    reason?: string;
    validationType: SourceValidationType;
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
    result: SourceValidationResult;
    timestamp: number;
    fileHash?: string;
}

/**
 * Options for validation
 */
export interface SourceValidationOptions {
    validationType: SourceValidationType;
    forceRefresh?: boolean;
}

/**
 * Manages source validation with backend integration and file upload capabilities
 */
class SourceValidationManager {
    private validationCache = new Map<string, ValidationCacheEntry>();
    private pendingValidations = new Map<string, Promise<SourceValidationResult>>();
    
    // Cache settings
    private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
    private readonly MAX_CACHE_SIZE = 1000;

    /**
     * Generate cache key from source and validation type
     */
    private getCacheKey(source: InputSource, validationType: SourceValidationType): string {
        return `${source.libraryID}-${source.itemKey}-${validationType}`;
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
    private async performLocalValidation(source: InputSource): Promise<{ isValid: boolean; reason?: string }> {
        // 1. Use existing frontend validation
        const localValidation = await isSourceValid(source);
        if (!localValidation.valid) {
            return { isValid: false, reason: localValidation.error };
        }

        // 2. Get the Zotero item for file size validation
        const item = getZoteroItem(source);
        if (!item || !item.isAttachment()) {
            return { isValid: true }; // Non-attachments pass local validation
        }

        // 3. Check file size limits (same logic as FileUploader)
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
            logger(`SourceValidationManager: Error checking file size for ${source.itemKey}: ${error.message}`, 2);
            return { isValid: false, reason: 'Unable to check file size' };
        }

        return { isValid: true };
    }

    /**
     * Perform backend validation
     */
    private async performBackendValidation(
        source: InputSource, 
        validationType: SourceValidationType,
        fileHash: string
    ): Promise<{ backendResponse: ValidationResponse; shouldUpload: boolean }> {
        const requestUrl = validationType === SourceValidationType.FULL_FILE;
        
        try {
            const backendResponse = await attachmentsService.validateAttachment(
                source.libraryID,
                source.itemKey,
                fileHash,
                requestUrl
            );

            let shouldUpload = false;
            
            if (validationType === SourceValidationType.PROCESSED_FILE) {
                // For processed file validation, we pass if file exists OR is processed
                // No upload required
            } else {
                // For full validation, we need the file to exist
                // If it doesn't exist but we have an upload URL, we should upload
                shouldUpload = !backendResponse.file_exists && !!backendResponse.signed_upload_url;
            }

            return { backendResponse, shouldUpload };
        } catch (error: any) {
            logger(`SourceValidationManager: Backend validation failed for ${source.itemKey}: ${error.message}`, 2);
            throw new Error(`Backend validation failed: ${error.message}`);
        }
    }

    /**
     * Upload file using temporary upload
     */
    private async uploadFile(source: InputSource, uploadUrl: string, storagePath: string, uploadMetadata: Record<string, string>): Promise<void> {
        const item = getZoteroItem(source);
        if (!item || !item.isAttachment()) {
            throw new Error('Cannot upload non-attachment item');
        }

        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            throw new Error('File path not available for upload');
        }

        const mimeType = await getMimeType(item, filePath);

        logger(`SourceValidationManager: Uploading file for ${source.itemKey}`, 3);
        
        await fileUploader.uploadTemporaryFile(
            filePath,
            uploadUrl,
            storagePath,
            uploadMetadata.filehash,
            mimeType,
            uploadMetadata
        );

        logger(`SourceValidationManager: Successfully uploaded file for ${source.itemKey}`, 3);
    }

    /**
     * Check for cached results in priority order for CACHED validation type
     */
    private async checkCachedResultsInPriority(source: InputSource): Promise<SourceValidationResult | null> {
        // Priority order: FULL_FILE -> PROCESSED_FILE -> LOCAL_ONLY
        const priorityOrder = [
            SourceValidationType.FULL_FILE,
            SourceValidationType.PROCESSED_FILE,
            SourceValidationType.LOCAL_ONLY
        ];

        // Get current file hash for cache validation
        let currentFileHash: string | undefined;
        try {
            const item = getZoteroItem(source);
            if (item && item.isAttachment()) {
                currentFileHash = await item.attachmentHash;
            }
        } catch (error) {
            // Ignore hash errors for cache validation
        }

        for (const validationType of priorityOrder) {
            const cacheKey = this.getCacheKey(source, validationType);
            const cachedEntry = this.validationCache.get(cacheKey);
            
            if (cachedEntry && this.isCacheValid(cachedEntry, currentFileHash)) {
                logger(`SourceValidationManager: Found cached result for ${source.itemKey} with type ${validationType}`, 4);
                // Return the cached result but with the CACHED validation type
                return {
                    ...cachedEntry.result,
                    validationType: SourceValidationType.CACHED
                };
            }
        }

        return null;
    }

    /**
     * Main validation method
     */
    async validateSource(source: InputSource, options: SourceValidationOptions): Promise<SourceValidationResult> {
        const { validationType, forceRefresh = false } = options;
        
        // Handle CACHED validation type
        if (validationType === SourceValidationType.CACHED && !forceRefresh) {
            this.cleanCache();
            
            // Check for cached results in priority order
            const cachedResult = await this.checkCachedResultsInPriority(source);
            if (cachedResult) {
                return cachedResult;
            }
            
            // No cached results found, fall back to LOCAL_ONLY validation
            logger(`SourceValidationManager: No cached results found for ${source.itemKey}, falling back to LOCAL_ONLY`, 4);
            return this.validateSource(source, { 
                validationType: SourceValidationType.LOCAL_ONLY,
                forceRefresh: false 
            });
        }

        const enableUpload = validationType === SourceValidationType.FULL_FILE;
        const cacheKey = this.getCacheKey(source, validationType);

        // Clean cache periodically
        this.cleanCache();

        // Check cache first (unless force refresh)
        if (!forceRefresh) {
            const cachedEntry = this.validationCache.get(cacheKey);
            if (cachedEntry) {
                // Get current file hash for cache validation
                let currentFileHash: string | undefined;
                try {
                    const item = getZoteroItem(source);
                    if (item && item.isAttachment()) {
                        currentFileHash = await item.attachmentHash;
                    }
                } catch (error) {
                    // Ignore hash errors for cache validation
                }

                if (this.isCacheValid(cachedEntry, currentFileHash)) {
                    logger(`SourceValidationManager: Returning cached validation for ${source.itemKey}`, 4);
                    return cachedEntry.result;
                }
            }
        }

        // Deduplicate concurrent requests
        if (this.pendingValidations.has(cacheKey)) {
            logger(`SourceValidationManager: Returning pending validation for ${source.itemKey}`, 4);
            return this.pendingValidations.get(cacheKey)!;
        }

        // Start new validation
        const validationPromise = this.performValidation(source, validationType, enableUpload);
        this.pendingValidations.set(cacheKey, validationPromise);

        try {
            const result = await validationPromise;
            
            // Cache the result
            const item = getZoteroItem(source);
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
        source: InputSource, 
        validationType: SourceValidationType,
        enableUpload: boolean
    ): Promise<SourceValidationResult> {
        const baseResult: SourceValidationResult = {
            isValid: false,
            validationType,
            backendChecked: false,
            uploaded: false,
            isValidating: true
        };

        try {
            // ------ Step 1: Local validation ------
            logger(`SourceValidationManager: Starting local validation for ${source.itemKey}`, 4);
            const localValidation = await this.performLocalValidation(source);
            
            // Return if local validation is invalid or validation type is local only
            if (!localValidation.isValid || validationType === SourceValidationType.LOCAL_ONLY) {
                return {
                    ...baseResult,
                    isValid: localValidation.isValid,
                    reason: localValidation.reason,
                    isValidating: false
                };
            }

            // ------ Step 2: Backend validation (only for attachments) ------
            const item = getZoteroItem(source);
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
                fileHash = await item.attachmentHash;
                if (!fileHash) {
                    throw new Error('No file hash available');
                }
            } catch (error: any) {
                return {
                    ...baseResult,
                    isValid: false,
                    reason: 'Unable to get file details',
                    isValidating: false
                };
            }

            // Perform backend validation
            logger(`SourceValidationManager: Starting backend validation for ${source.itemKey}`, 4);
            const { backendResponse, shouldUpload } = await this.performBackendValidation(source, validationType, fileHash);

            // Determine if valid based on validation type
            let isValid = false;
            let reason: string | undefined;
            let requiresUpload = false;

            if (validationType === SourceValidationType.PROCESSED_FILE) {
                // Processed file: pass if file exists OR is processed
                isValid = backendResponse.file_exists || backendResponse.processed;
                if (!isValid) {
                    reason = 'File not available';
                }
            } else {
                // Require file: require file to exist
                isValid = backendResponse.file_exists;
                requiresUpload = shouldUpload;
                if (!isValid && !requiresUpload) {
                    reason = 'File upload failed';
                } else if (!isValid && requiresUpload) {
                    reason = 'File upload failed';
                }
            }

            // ------ Step 3: Upload if needed and enabled ------
            let uploaded = false;
            if (requiresUpload && enableUpload && backendResponse.signed_upload_url && backendResponse.storage_path) {
                try {
                    logger(`SourceValidationManager: Starting file upload for ${source.itemKey}`, 3);
                    await this.uploadFile(source, backendResponse.signed_upload_url, backendResponse.storage_path, backendResponse.upload_metadata || {});
                    uploaded = true;
                    isValid = true;
                    reason = undefined;
                } catch (uploadError: any) {
                    logger(`SourceValidationManager: Upload failed for ${source.itemKey}: ${uploadError.message}`, 1);
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
            logger(`SourceValidationManager: Validation failed for ${source.itemKey}: ${error.message}`, 1);
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
    invalidateSource(source: InputSource): void {
        const processedFileKey = this.getCacheKey(source, SourceValidationType.PROCESSED_FILE);
        const requireFileKey = this.getCacheKey(source, SourceValidationType.FULL_FILE);
        
        this.validationCache.delete(processedFileKey);
        this.validationCache.delete(requireFileKey);
        
        logger(`SourceValidationManager: Invalidated cache for ${source.itemKey}`, 4);
    }

    /**
     * Clear all cached validation results
     */
    clearCache(): void {
        this.validationCache.clear();
        this.pendingValidations.clear();
        logger('SourceValidationManager: Cleared all cached validation results', 3);
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
export const sourceValidationManager = new SourceValidationManager();
