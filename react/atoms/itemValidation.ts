import { atom } from 'jotai';
import { 
    itemValidationManager, 
    ItemValidationType, 
    ItemValidationResult,
    ItemValidationOptions 
} from '../../src/services/itemValidationManager';
import { logger } from '../../src/utils/logger';
import { processingModeAtom } from './profile';
import { ProcessingMode } from '../types/profile';

/**
 * Generate unique key for a Zotero item
 */
function getItemKey(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

/**
 * Get the appropriate validation type based on processing mode
 * FRONTEND mode -> ItemValidationType.FRONTEND (comprehensive local checks)
 * BACKEND mode -> ItemValidationType.BACKEND (backend verification)
 */
export function getValidationTypeForMode(processingMode: ProcessingMode): ItemValidationType {
    return processingMode === ProcessingMode.FRONTEND 
        ? ItemValidationType.FRONTEND 
        : ItemValidationType.BACKEND;
}

/**
 * Extended validation state that includes UI state (isValidating)
 * Combines manager result with atom-managed state
 */
export interface ItemValidationState extends ItemValidationResult {
    isValidating: boolean;
}

/**
 * Store validation results for items
 * Key: "libraryID-itemKey"
 * Value: ItemValidationState (includes isValidating)
 */
export const itemValidationResultsAtom = atom<Map<string, ItemValidationState>>(new Map());

/**
 * Get validation result for a specific item
 * Returns undefined if not validated yet
 */
export const getItemValidationAtom = atom((get) => (item: Zotero.Item) => {
    const results = get(itemValidationResultsAtom);
    return results.get(getItemKey(item));
});

/**
 * Validate a single item
 * Updates the validation results map
 */
export const validateItemAtom = atom(
    null,
    async (get, set, params: { item: Zotero.Item; validationType: ItemValidationType; forceRefresh?: boolean }) => {
        const { item, validationType, forceRefresh = false } = params;
        const itemKey = getItemKey(item);
        
        // Set validating state (optimistic, assume valid until checked)
        const results = get(itemValidationResultsAtom);
        const newResults = new Map(results);
        newResults.set(itemKey, {
            isValid: true,
            backendChecked: false,
            isValidating: true
        });
        set(itemValidationResultsAtom, newResults);
        
        try {
            const options: ItemValidationOptions = {
                validationType,
                forceRefresh
            };
            
            const result = await itemValidationManager.validateItem(item, options);
            
            // Update with actual result (add isValidating: false)
            const updatedResults = new Map(get(itemValidationResultsAtom));
            updatedResults.set(itemKey, {
                ...result,
                isValidating: false
            });
            set(itemValidationResultsAtom, updatedResults);
            
            logger(`Validated item ${itemKey}: ${result.isValid ? 'valid' : 'invalid'}`, 4);
            
            return result;
        } catch (error: any) {
            logger(`Failed to validate item ${itemKey}: ${error.message}`, 1);
            
            // Update with error result
            const errorResults = new Map(get(itemValidationResultsAtom));
            errorResults.set(itemKey, {
                isValid: false,
                reason: `Validation error: ${error.message}`,
                backendChecked: false,
                isValidating: false
            });
            set(itemValidationResultsAtom, errorResults);
            
            throw error;
        }
    }
);

/**
 * Validate multiple items in parallel
 * Updates the validation results map for all items
 */
export const validateItemsAtom = atom(
    null,
    async (get, set, params: { items: Zotero.Item[]; validationType: ItemValidationType; forceRefresh?: boolean }) => {
        const { items, validationType, forceRefresh = false } = params;
        
        logger(`Validating ${items.length} items with type ${validationType}`, 3);
        
        // Validate all items in parallel
        const validationPromises = items.map(item => 
            set(validateItemAtom, { item, validationType, forceRefresh })
                .catch(error => {
                    logger(`Validation failed for item ${getItemKey(item)}: ${error.message}`, 2);
                    return null;
                })
        );
        
        const results = await Promise.all(validationPromises);
        
        // Return summary
        const validCount = results.filter(r => r?.isValid).length;
        const invalidCount = results.filter(r => r && !r.isValid).length;
        const errorCount = results.filter(r => r === null).length;
        
        logger(`Validation complete: ${validCount} valid, ${invalidCount} invalid, ${errorCount} errors`, 3);
        
        return { validCount, invalidCount, errorCount };
    }
);

/**
 * Validate a regular item with all its attachments using batch validation
 * Updates the validation results map for the item and all its attachments
 */
export const validateRegularItemAtom = atom(
    null,
    async (get, set, item: Zotero.Item) => {
        if (!item.isRegularItem()) {
            throw new Error('validateRegularItemAtom can only be called on regular items');
        }

        const itemKey = getItemKey(item);
        
        // Set validating state for the item
        const results = get(itemValidationResultsAtom);
        const newResults = new Map(results);
        newResults.set(itemKey, {
            isValid: true,
            backendChecked: false,
            isValidating: true
        });
        
        // Get all attachments and set validating state for them
        const attachmentIDs = item.getAttachments();
        const attachments = await Zotero.Items.getAsync(attachmentIDs);
        for (const attachment of attachments) {
            const attachmentKey = getItemKey(attachment);
            newResults.set(attachmentKey, {
                isValid: true,
                backendChecked: false,
                isValidating: true
            });
        }
        set(itemValidationResultsAtom, newResults);
        
        try {
            const result = await itemValidationManager.validateRegularItem(item);
            
            // Update validation results for item and all attachments
            const updatedResults = new Map(get(itemValidationResultsAtom));
            
            // Update item itself
            updatedResults.set(itemKey, {
                isValid: result.isValid,
                reason: result.reason,
                backendChecked: false,
                isValidating: false
            });
            
            // Update all attachments
            for (const [attachmentKey, attachmentResult] of result.attachmentResults) {
                updatedResults.set(attachmentKey, {
                    ...attachmentResult,
                    isValidating: false
                });
            }
            
            set(itemValidationResultsAtom, updatedResults);
            
            logger(`Validated regular item ${itemKey} with ${result.attachmentResults.size} attachments: ${result.isValid ? 'valid' : 'invalid'}`, 4);
            
            return result;
        } catch (error: any) {
            logger(`Failed to validate regular item ${itemKey}: ${error.message}`, 1);
            
            // Update with error result for item and attachments
            const errorResults = new Map(get(itemValidationResultsAtom));
            errorResults.set(itemKey, {
                isValid: false,
                reason: `Validation error: ${error.message}`,
                backendChecked: false,
                isValidating: false
            });
            
            // Mark all attachments as error too
            for (const attachment of attachments) {
                const attachmentKey = getItemKey(attachment);
                errorResults.set(attachmentKey, {
                    isValid: false,
                    reason: `Validation error: ${error.message}`,
                    backendChecked: false,
                    isValidating: false
                });
            }
            
            set(itemValidationResultsAtom, errorResults);
            
            throw error;
        }
    }
);

/**
 * Validate a regular item with all its attachments using frontend mode
 * No backend calls - uses comprehensive local validation
 * Updates the validation results map for the item and all its attachments
 */
export const validateRegularItemFrontendAtom = atom(
    null,
    async (get, set, item: Zotero.Item) => {
        if (!item.isRegularItem()) {
            throw new Error('validateRegularItemFrontendAtom can only be called on regular items');
        }

        const itemKey = getItemKey(item);
        
        // Set validating state for the item
        const results = get(itemValidationResultsAtom);
        const newResults = new Map(results);
        newResults.set(itemKey, {
            isValid: true,
            backendChecked: false,
            isValidating: true
        });
        
        // Get all attachments and set validating state for them
        const attachmentIDs = item.getAttachments();
        const attachments = await Zotero.Items.getAsync(attachmentIDs);
        for (const attachment of attachments) {
            const attachmentKey = getItemKey(attachment);
            newResults.set(attachmentKey, {
                isValid: true,
                backendChecked: false,
                isValidating: true
            });
        }
        set(itemValidationResultsAtom, newResults);
        
        try {
            const result = await itemValidationManager.validateRegularItemFrontend(item);
            
            // Update validation results for item and all attachments
            const updatedResults = new Map(get(itemValidationResultsAtom));
            
            // Update item itself
            updatedResults.set(itemKey, {
                isValid: result.isValid,
                reason: result.reason,
                backendChecked: false,
                isValidating: false
            });
            
            // Update all attachments
            for (const [attachmentKey, attachmentResult] of result.attachmentResults) {
                updatedResults.set(attachmentKey, {
                    ...attachmentResult,
                    isValidating: false
                });
            }
            
            set(itemValidationResultsAtom, updatedResults);
            
            logger(`Frontend validated regular item ${itemKey} with ${result.attachmentResults.size} attachments: ${result.isValid ? 'valid' : 'invalid'}`, 4);
            
            return result;
        } catch (error: any) {
            logger(`Failed to frontend validate regular item ${itemKey}: ${error.message}`, 1);
            
            // Update with error result for item and attachments
            const errorResults = new Map(get(itemValidationResultsAtom));
            errorResults.set(itemKey, {
                isValid: false,
                reason: `Validation error: ${error.message}`,
                backendChecked: false,
                isValidating: false
            });
            
            // Mark all attachments as error too
            for (const attachment of attachments) {
                const attachmentKey = getItemKey(attachment);
                errorResults.set(attachmentKey, {
                    isValid: false,
                    reason: `Validation error: ${error.message}`,
                    backendChecked: false,
                    isValidating: false
                });
            }
            
            set(itemValidationResultsAtom, errorResults);
            
            throw error;
        }
    }
);

/**
 * Validate a regular item using the appropriate mode (frontend or backend)
 * Automatically determines the validation method based on processingModeAtom
 */
export const validateRegularItemWithModeAtom = atom(
    null,
    async (get, set, item: Zotero.Item) => {
        const processingMode = get(processingModeAtom);
        
        if (processingMode === ProcessingMode.FRONTEND) {
            return set(validateRegularItemFrontendAtom, item);
        } else {
            return set(validateRegularItemAtom, item);
        }
    }
);

/**
 * Invalidate cache for a specific item
 * Removes the validation result from the map
 */
export const invalidateItemAtom = atom(
    null,
    (get, set, item: Zotero.Item) => {
        const itemKey = getItemKey(item);
        const results = get(itemValidationResultsAtom);
        const newResults = new Map(results);
        newResults.delete(itemKey);
        set(itemValidationResultsAtom, newResults);
        
        // Also invalidate in the manager's cache
        itemValidationManager.invalidateItem(item);
        
        logger(`Invalidated validation for item ${itemKey}`, 4);
    }
);

/**
 * Clear all validation results
 */
export const clearItemValidationAtom = atom(
    null,
    (get, set) => {
        set(itemValidationResultsAtom, new Map());
        itemValidationManager.clearCache();
        logger('Cleared all item validation results', 3);
    }
);

/**
 * Get validation stats for debugging
 */
export const itemValidationStatsAtom = atom((get) => {
    const results = get(itemValidationResultsAtom);
    const managerStats = itemValidationManager.getCacheStats();
    
    let validCount = 0;
    let invalidCount = 0;
    let validatingCount = 0;
    
    results.forEach(result => {
        if (result.isValidating) validatingCount++;
        else if (result.isValid) validCount++;
        else invalidCount++;
    });
    
    return {
        totalCached: results.size,
        validCount,
        invalidCount,
        validatingCount,
        managerCacheSize: managerStats.size,
        pendingValidations: managerStats.pendingValidations
    };
});