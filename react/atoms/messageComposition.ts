import { atom } from "jotai";
import { logger } from "../../src/utils/logger";
import { addPopupMessageAtom } from "../utils/popupMessageUtils";
import { ItemValidationType } from "../../src/services/itemValidationManager";


/**
* Current message items
* Items that are currently being added to the message
*/
export const currentMessageItemsAtom = atom<Zotero.Item[]>([]);

/**
* Add single item to currentMessageItemsAtom
* Validates in background and removes if invalid
*/
export const addItemToCurrentMessageItemsAtom = atom(
    null,
    async (get, set, item: Zotero.Item) => {
        const currentItems = get(currentMessageItemsAtom);
        if(currentItems.some((i) => i.key === item.key)) return;
        
        // Add immediately (optimistic)
        set(currentMessageItemsAtom, [...currentItems, item]);
        
        // Validate in background
        validateItemsInBackground(get, set, [item]);
    }
);

/**
* Add multiple items to currentMessageItemsAtom
* Validates in background and removes if invalid
*/
export const addItemsToCurrentMessageItemsAtom = atom(
    null,
    async (get, set, items: Zotero.Item[]) => {
        // Filter out already added items
        const currentItems = get(currentMessageItemsAtom);
        const newItems = items.filter((i) => 
            !currentItems.some((ci) => ci.key === i.key)
        );
        
        if (newItems.length === 0) return;

        // Add items immediately (optimistic update)
        set(currentMessageItemsAtom, [...currentItems, ...newItems]);

        // Validate items in background (non-blocking)
        // This will update itemValidationResultsAtom as validation progresses
        // SourceButton will show: spinner → checkmark/error
        validateItemsInBackground(get, set, newItems);
    }
);

/**
 * Validate items in background and remove invalid ones
 * This runs asynchronously without blocking the UI
 */
async function validateItemsInBackground(
    get: any,
    set: any,
    items: Zotero.Item[]
) {
    // Import validation atoms (avoid circular dependency issues)
    const { validateItemsAtom } = await import('./itemValidation');
    
    try {
        // Validate all items with BACKEND validation
        // This does local validation first, then backend validation
        await set(validateItemsAtom, {
            items,
            validationType: ItemValidationType.BACKEND,
            forceRefresh: false
        });

        // Check which items failed validation
        const { getItemValidationAtom } = await import('./itemValidation');
        const getValidation = get(getItemValidationAtom);
        
        const invalidItems = items
            .map(item => ({ item, validation: getValidation(item) }))
            .filter(({ validation }) => validation && !validation.isValid);

        // Remove invalid items from currentMessageItemsAtom
        if (invalidItems.length > 0) {
            const currentItems = get(currentMessageItemsAtom);
            const invalidKeys = new Set(invalidItems.map(({ item }) => item.key));
            const validItems = currentItems.filter((item: Zotero.Item) => !invalidKeys.has(item.key));
            set(currentMessageItemsAtom, validItems);

            // Show error message
            const message = invalidItems.length === 1
                ? `Removed invalid item: ${invalidItems[0].validation?.reason || 'Unknown error'}`
                : `Removed ${invalidItems.length} invalid items:\n${
                    invalidItems.map(({ validation }) => 
                        `• ${validation?.reason || 'Unknown error'}`
                    ).join('\n')
                }`;
            
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Items Removed',
                text: message,
                expire: true
            });
        }
    } catch (error: any) {
        logger(`Background validation failed: ${error.message}`, 1);
    }
}

