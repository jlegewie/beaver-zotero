import { atom } from "jotai";
import { userAttachmentKeysAtom } from "./threads";
import { createElement } from 'react';
import { logger } from "../../src/utils/logger";
import { addPopupMessageAtom, addRegularItemPopupAtom, addRegularItemsSummaryPopupAtom } from "../utils/popupMessageUtils";
import { ItemValidationType } from "../../src/services/itemValidationManager";
import { getItemValidationAtom } from './itemValidation';
import { InvalidItemsMessageContent } from '../components/ui/popup/InvalidItemsMessageContent';
import { syncingItemFilter } from "../../src/utils/sync";
import { getCurrentReader } from "../utils/readerUtils";


/**
* Current message items
* Items that are currently being added to the message
*/
export const currentMessageItemsAtom = atom<Zotero.Item[]>([]);

/**
* Current reader attachment
*/
export const currentReaderAttachmentAtom = atom<Zotero.Item | null>(null);

/*
* Current reader attachment key
*/
export const currentReaderAttachmentKeyAtom = atom<string | null>((get) => {
    const item = get(currentReaderAttachmentAtom);
    return item?.key || null;
});

/**
* Count of input attachments
* 
* Counts the number of attachments in the current sources and reader attachment.
* The reader attachment is only counted if it's not already in the user-added sources.
* 
*/
export const inputAttachmentCountAtom = atom<number>((get) => {
    // Input attachments
    const itemKeys = get(currentMessageItemsAtom)
        .filter((item => item.isRegularItem() || item.isAttachment()))
        .map((item) => item.key);
    // Reader attachment
    const readerAttachmentKey = get(currentReaderAttachmentKeyAtom);
    if (readerAttachmentKey) {
        itemKeys.push(readerAttachmentKey);
    }
    // Exclude user-added sources already in thread
    const userAddedAttachmentKeys = get(userAttachmentKeysAtom);
    const filteredInputAttachmentKeys = itemKeys.filter((key) => !userAddedAttachmentKeys.includes(key));
    // Return total of attachments
    return [...new Set(filteredInputAttachmentKeys)].length;
});



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
        const preValidatedItems = newItems.filter((i) => syncingItemFilter(i) || i.isAnnotation());

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

/**
* Update sources based on Zotero selection
*/
export const updateMessageItemsFromZoteroSelectionAtom = atom(
    null,
    async (get, set, pinned: boolean = false) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        await set(addItemsToCurrentMessageItemsAtom, items);
    }
);


/**
* Update current reader attachment
*/
export const updateReaderAttachmentAtom = atom(
    null,
    async (_, set, reader?: any) => {
        // also gets the current reader item (parent item)
        // Zotero.getActiveZoteroPane().getSelectedItems()
        // Get current reader
        reader = reader || getCurrentReader();
        if (!reader) {
            set(currentReaderAttachmentAtom, null);
            return;
        }
        // Get reader item
        const item = await Zotero.Items.getAsync(reader.itemID);
        if (item) {
            logger(`Updating reader attachment to ${item.key}`);
            set(currentReaderAttachmentAtom, item);
        }
    }
);
