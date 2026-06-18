import { atom } from 'jotai';
import { 
    itemValidationManager, 
    ItemValidationResult,
    ItemValidationOptions 
} from '../../src/services/itemValidationManager';
import { logger } from '../../src/utils/logger';
import { searchableLibraryIdsAtom } from './profile';
import { selectedModelAtom } from './models';
import { getPref } from '../../src/utils/prefs';

/**
 * Generate unique key for a Zotero item
 */
function getItemKey(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

/**
 * Return whether the active client setup can use scanned/OCR-only PDFs.
 */
function canHandleOCRLocally(get: any): boolean {
    const selectedModel = get(selectedModelAtom);
    const supportsVision = selectedModel?.supports_vision === true;
    const requestPlusTools = getPref('requestPlusTools');
    return supportsVision || requestPlusTools;
}

/**
 * Extended validation state that includes atom-managed UI progress.
 */
export type ItemValidationState = (ItemValidationResult | {
    state: 'checking';
    reason?: undefined;
}) & {
    isValidating: boolean;
};

/**
 * Return whether a completed validation result should prevent an item from
 * being attached or sent.
 */
export function isHardBlockedValidation(
    validation: Pick<ItemValidationState, 'state' | 'isValidating'> | undefined | null,
): boolean {
    return !!validation && !validation.isValidating && validation.state === 'blocked';
}

/**
 * Return whether a completed validation result should reject this item.
 * Regular items remain attachable even when none of their child attachments
 * are readable; standalone attachments are rejected when Beaver cannot read
 * the file.
 */
export function isRejectedItemValidation(
    item: Zotero.Item,
    validation: Pick<ItemValidationState, 'state' | 'isValidating'> | undefined | null,
): boolean {
    if (!validation || validation.isValidating) return false;
    if (validation.state === 'blocked') return true;
    return item.isAttachment() && validation.state === 'unreadable';
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
    async (get, set, params: { item: Zotero.Item; forceRefresh?: boolean }) => {
        const { item, forceRefresh = false } = params;
        const itemKey = getItemKey(item);
        
        // Set validating state (optimistic, assume valid until checked)
        const results = get(itemValidationResultsAtom);
        const newResults = new Map(results);
        newResults.set(itemKey, {
            state: 'checking',
            isValidating: true
        });
        set(itemValidationResultsAtom, newResults);
        
        try {
            const options: ItemValidationOptions = {
                forceRefresh,
                searchableLibraryIds: get(searchableLibraryIdsAtom),
                canHandleOCRLocally: canHandleOCRLocally(get),
            };
            
            const result = await itemValidationManager.validateItem(item, options);
            
            // Update with actual result (add isValidating: false)
            const updatedResults = new Map(get(itemValidationResultsAtom));
            updatedResults.set(itemKey, {
                ...result,
                isValidating: false
            });
            set(itemValidationResultsAtom, updatedResults);
            
            logger(`Validated item ${itemKey}: ${result.state}`, 4);
            
            return result;
        } catch (error: any) {
            logger(`Failed to validate item ${itemKey}: ${error.message}`, 1);
            
            // Update with error result
            const errorResults = new Map(get(itemValidationResultsAtom));
            errorResults.set(itemKey, {
                state: 'blocked',
                reason: `Validation error: ${error.message}`,
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
    async (get, set, params: { items: Zotero.Item[]; forceRefresh?: boolean }) => {
        const { items, forceRefresh = false } = params;
        
        logger(`Validating ${items.length} items`, 3);
        
        // Validate all items in parallel
        const validationPromises = items.map(item => 
            set(validateItemAtom, { item, forceRefresh })
                .catch(error => {
                    logger(`Validation failed for item ${getItemKey(item)}: ${error.message}`, 2);
                    return null;
                })
        );
        
        const results = await Promise.all(validationPromises);
        
        // Return summary
        const readableCount = results.filter(r => r?.state === 'readable').length;
        const unreadableCount = results.filter(r => r?.state === 'unreadable').length;
        const blockedCount = results.filter(r => r?.state === 'blocked').length;
        const errorCount = results.filter(r => r === null).length;
        
        logger(`Validation complete: ${readableCount} readable, ${unreadableCount} unreadable, ${blockedCount} blocked, ${errorCount} errors`, 3);
        
        return { readableCount, unreadableCount, blockedCount, errorCount };
    }
);

/**
 * Validate a regular item with all its attachments.
 * Updates the validation results map for the item and all its attachments.
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
            state: 'checking',
            isValidating: true
        });
        
        // Get all attachments and set validating state for them
        const attachmentIDs = item.getAttachments();
        const attachments = await Zotero.Items.getAsync(attachmentIDs);
        for (const attachment of attachments) {
            const attachmentKey = getItemKey(attachment);
            newResults.set(attachmentKey, {
                state: 'checking',
                isValidating: true
            });
        }
        set(itemValidationResultsAtom, newResults);
        
        try {
            const result = await itemValidationManager.validateRegularItem(item, {
                searchableLibraryIds: get(searchableLibraryIdsAtom),
                canHandleOCRLocally: canHandleOCRLocally(get),
            });
            
            // Update validation results for item and all attachments
            const updatedResults = new Map(get(itemValidationResultsAtom));
            
            // Update item itself
            updatedResults.set(itemKey, {
                state: result.state,
                reason: result.reason,
                statusCode: result.statusCode,
                contentKind: result.contentKind,
                pageCount: result.pageCount,
                attachmentInfo: result.attachmentInfo,
                isValidating: false
            });
            
            // Update all attachments
            for (const [attachmentKey, attachmentResult] of result.attachmentResults) {
                updatedResults.set(attachmentKey, {
                    ...attachmentResult,
                    isValidating: false
                });
            }
            for (const attachment of attachments) {
                const attachmentKey = getItemKey(attachment);
                if (!result.attachmentResults.has(attachmentKey)) {
                    updatedResults.set(attachmentKey, {
                        state: 'blocked',
                        reason: 'Unable to validate attachment',
                        isValidating: false
                    });
                }
            }
            
            set(itemValidationResultsAtom, updatedResults);
            
            logger(`Validated regular item ${itemKey} with ${result.attachmentResults.size} attachments: ${result.state}`, 4);
            
            return result;
        } catch (error: any) {
            logger(`Failed to validate regular item ${itemKey}: ${error.message}`, 1);
            
            // Update with error result for item and attachments
            const errorResults = new Map(get(itemValidationResultsAtom));
            errorResults.set(itemKey, {
                state: 'blocked',
                reason: `Validation error: ${error.message}`,
                isValidating: false
            });
            
            // Mark all attachments as error too
            for (const attachment of attachments) {
                const attachmentKey = getItemKey(attachment);
                errorResults.set(attachmentKey, {
                    state: 'blocked',
                    reason: `Validation error: ${error.message}`,
                    isValidating: false
                });
            }
            
            set(itemValidationResultsAtom, errorResults);
            
            throw error;
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
    
    let readableCount = 0;
    let unreadableCount = 0;
    let blockedCount = 0;
    let validatingCount = 0;
    
    results.forEach(result => {
        if (result.isValidating) validatingCount++;
        else if (result.state === 'readable') readableCount++;
        else if (result.state === 'unreadable') unreadableCount++;
        else if (result.state === 'blocked') blockedCount++;
    });
    
    return {
        totalCached: results.size,
        readableCount,
        unreadableCount,
        blockedCount,
        validatingCount,
        managerCacheSize: managerStats.size,
        pendingValidations: managerStats.pendingValidations
    };
});
