import { atom } from "jotai";
import { createElement } from 'react';
import { logger } from "../../src/utils/logger";
import { addPopupMessageAtom, addRegularItemPopupAtom } from "../utils/popupMessageUtils";
import { ItemValidationType } from "../../src/services/itemValidationManager";
import { getItemValidationAtom } from './itemValidation';
import { InvalidItemsMessageContent } from '../components/ui/popup/InvalidItemsMessageContent';
import { syncingItemFilter } from "../../src/utils/sync";


/**
* Current message items
* Items that are currently being added to the message
*/
export const currentMessageItemsAtom = atom<Zotero.Item[]>([]);

/**
* Remove item from currentMessageItemsAtom
*/
export const removeItemFromMessageAtom = atom(
    null,
    (get, set, item: Zotero.Item) => {
        const currentItems = get(currentMessageItemsAtom);
        set(currentMessageItemsAtom, currentItems.filter((i) => i.key !== item.key));
    }
);

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

        // Pre-filter items using sync filter to avoid unnecessary state change
        // (validation still runs to show error message)
        // TODO: This excludes annotations
        const preValidatedItems = newItems.filter((i) => syncingItemFilter(i));

        // Add items immediately (optimistic update)
        set(currentMessageItemsAtom, [...currentItems, ...preValidatedItems]);

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
    const getValidation = get(getItemValidationAtom);
    
    try {
        // Items to validate: Regular items and their attachments
        const childItemsPromises = items
            .filter((item) => item.isRegularItem())
            .flatMap((item) => {
                return item.getAttachments().map((id: number) => Zotero.Items.getAsync(id));
            });
        const childItems = await Promise.all(childItemsPromises);
        const itemsToValidate = [...items, ...childItems];
    
        // Validate all items with BACKEND validation
        // This does local validation first, then backend validation
        await set(validateItemsAtom, {
            items: itemsToValidate,
            validationType: ItemValidationType.BACKEND,
            forceRefresh: false
        });
        
        // Remove invalid items from currentMessageItemsAtom
        const invalidItems = items
            .map(item => ({ item, validation: getValidation(item) }))
            .filter(({ validation }) => validation && !validation.isValid);

        if (invalidItems.length > 0) {
            // Remove invalid items from currentMessageItemsAtom
            const currentItems = get(currentMessageItemsAtom);
            const invalidKeys = new Set(invalidItems.map(({ item }) => item.key));
            const validItems = currentItems.filter((item: Zotero.Item) => !invalidKeys.has(item.key));
            set(currentMessageItemsAtom, validItems);

            // Show error message with custom content
            const title = invalidItems.length === 1 
                ? 'Item Removed' 
                : `${invalidItems.length} Items Removed`;
            
            const invalidItemsData = invalidItems.map(({ item, validation }) => ({
                item,
                reason: validation?.reason || 'Unknown error'
            }));
            
            set(addPopupMessageAtom, {
                type: 'error',
                title,
                customContent: createElement(InvalidItemsMessageContent, { 
                    invalidItems: invalidItemsData 
                }),
                expire: true,
                duration: 3000
            });
        }

        // Show popup for regular items with invalid attachments or no PDF attachments
        const invalidItemsWithAttachments = itemsToValidate
            .map(item => ({ item, validation: getValidation(item) }))
            .filter(({ validation }) => validation && !validation.isValid);
        const invalidItemIds = new Set(invalidItemsWithAttachments.map(({ item }) => item.id));
        const regularItems = items.filter((i) => i.isRegularItem() && !invalidItemIds.has(i.id));
        
        // Show individual popup for single item, summary popup for multiple items
        // for (const item of regularItems) set(addRegularItemPopupAtom, { item, getValidation });
        if (regularItems.length === 1) {
            set(addRegularItemPopupAtom, { item: regularItems[0], getValidation });
        } else if (regularItems.length > 1) {
            set(addRegularItemsSummaryPopupAtom, { items: regularItems, getValidation });
        }

        } catch (error: any) {
            logger(`Background validation failed: ${error.message}`, 1);
        }
}

