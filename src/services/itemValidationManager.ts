import { attachmentsService } from './attachmentsService';
import { isValidZoteroItem } from '../../react/utils/sourceUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/store';
import { planFeaturesAtom } from '../../react/atoms/profile';
import { isAttachmentOnServer } from '../utils/webAPI';

/**
 * Types of item validation
 */
export enum ItemValidationType {
    LOCAL_ONLY = 'local_only',   // only local validation (fast)
    BACKEND = 'backend',         // check backend processed status
    CACHED = 'cached',           // use cached result if available, fallback to LOCAL_ONLY
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
            // ------ Step 1: Local validation ------
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
            let fileHash: string;
            try {
                // Note: file hash can be undefined for missing files
                fileHash = await item.attachmentHash || '';
            } catch (error: any) {
                logger(`ItemValidationManager: Unable to get file hash for ${item.libraryID}-${item.key}: ${error.message}`, 1);
                return {
                    isValid: false,
                    reason: 'Unable to get file details',
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
                reason: `Validation error: ${error.message}`,
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
        
        this.validationCache.delete(localKey);
        this.validationCache.delete(backendKey);
        
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
