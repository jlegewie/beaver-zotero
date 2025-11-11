import { atom } from "jotai";
import { truncateText } from "../utils/stringUtils";
import { userAttachmentKeysAtom } from "./threads";
import { createElement } from 'react';
import { logger } from "../../src/utils/logger";
import { addPopupMessageAtom, addRegularItemPopupAtom, addRegularItemsSummaryPopupAtom, removePopupMessageAtom } from "../utils/popupMessageUtils";
import { ItemValidationType } from "../../src/services/itemValidationManager";
import { getItemValidationAtom, validateItemsAtom, validateRegularItemAtom } from './itemValidation';
import { InvalidItemsMessageContent } from '../components/ui/popup/InvalidItemsMessageContent';
import { syncingItemFilter } from "../../src/utils/sync";
import { getCurrentReader } from "../utils/readerUtils";
import { TextSelection } from "../types/attachments/apiTypes";
import { ZoteroTag } from "../types/zotero";


/**
* Current message filters
* Controls search scoping by library, collection, and tag selections.
* 
* Note: Filters are mutually exclusive - selecting a library clears collections/tags,
* selecting a collection clears libraries/tags, etc. This ensures clear, predictable
* search scoping behavior.
* 
* Empty arrays mean no filtering is applied for that dimension.
*/
export interface MessageFiltersState {
    libraryIds: number[];
    collectionIds: number[];
    tagSelections: ZoteroTag[];
}

/**
* Create default (empty) message filters
* Exported for use in tests and reset operations
*/
export const createDefaultMessageFilters = (): MessageFiltersState => ({
    libraryIds: [],
    collectionIds: [],
    tagSelections: []
});

export const currentMessageFiltersAtom = atom<MessageFiltersState>(createDefaultMessageFilters());

/**
* Reset message filters to default (empty) state
*/
export const resetMessageFiltersAtom = atom(
    null,
    (_, set) => {
        set(currentMessageFiltersAtom, createDefaultMessageFilters());
    }
);

/**
* Validate and clean up message filters
* Removes any library or collection references that no longer exist in Zotero
*/
export const validateFiltersAtom = atom((get) => {
    const filters = get(currentMessageFiltersAtom);
    
    // Validate library IDs
    const validLibraryIds = filters.libraryIds.filter(id => 
        Zotero.Libraries.exists(id)
    );
    
    // Validate collection IDs
    const validCollectionIds = filters.collectionIds.filter(id => {
        try {
            return !!Zotero.Collections.get(id);
        } catch {
            return false;
        }
    });
    
    // Tags don't need validation as they're stored as complete objects
    // If a tag is deleted, it won't match anything in searches but won't cause errors
    
    return {
        ...filters,
        libraryIds: validLibraryIds,
        collectionIds: validCollectionIds
    };
});

/**
* Current user message and sources
*/
export const currentMessageContentAtom = atom<string>('');

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
 * Current reader text selection
*/
export const readerTextSelectionAtom = atom<TextSelection | null>(null);

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
* Remove a library from the current selection
* Also removes any collections that belong to the removed library (cascading cleanup)
*/
export const removeLibraryIdAtom = atom(
    null,
    (get, set, libraryId: number) => {
        const filters = get(currentMessageFiltersAtom);
        const updatedLibraryIds = filters.libraryIds.filter(id => id !== libraryId);
        
        // Cascade: Remove collections that belong to the removed library
        const updatedCollectionIds = filters.collectionIds.filter((collectionId) => {
            try {
                const collection = Zotero.Collections.get(collectionId);
                return !collection || collection.libraryID !== libraryId;
            } catch {
                return true;
            }
        });

        set(currentMessageFiltersAtom, {
            ...filters,
            libraryIds: updatedLibraryIds,
            collectionIds: updatedCollectionIds
        });
    }
);

/**
* Remove a collection from the current selection
*/
export const removeCollectionIdAtom = atom(
    null,
    (get, set, collectionId: number) => {
        const filters = get(currentMessageFiltersAtom);
        set(currentMessageFiltersAtom, {
            ...filters,
            collectionIds: filters.collectionIds.filter(id => id !== collectionId)
        });
    }
);

/**
* Remove a tag from the current selection
*/
export const removeTagIdAtom = atom(
    null,
    (get, set, tagId: number) => {
        const filters = get(currentMessageFiltersAtom);
        set(currentMessageFiltersAtom, {
            ...filters,
            tagSelections: filters.tagSelections.filter(tag => tag.id !== tagId)
        });
    }
);

/**
* Remove item from currentMessageItemsAtom
*/
export const removeItemFromMessageAtom = atom(
    null,
    (_, set, item: Zotero.Item) => {
        set(currentMessageItemsAtom, (prevItems) =>
            prevItems.filter((i) => i.key !== item.key)
        );
        set(removePopupMessageAtom, item.key);
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
 * 
 * Uses batch validation for regular items (validates item + all attachments together)
 * and individual validation for standalone attachments and annotations
 */
async function validateItemsInBackground(
    get: any,
    set: any,
    items: Zotero.Item[],
    isReaderAttachment: boolean = false
) {
    const getValidation = get(getItemValidationAtom);
    
    try {
        // Separate regular items from standalone attachments and annotations
        const regularItems = items.filter((item) => item.isRegularItem());
        const attachments = items.filter((item) => item.isAttachment());
        const annotations = items.filter((item) => item.isAnnotation());
        
        // Validate regular items using batch validation (item + all attachments)
        const regularItemValidationPromises = regularItems.map((item) => 
            set(validateRegularItemAtom, item).catch((error: any) => {
                logger(`Batch validation failed for regular item ${item.key}: ${error.message}`, 2);
                return null;
            })
        );
        
        // Validate attachments individually
        const attachmentValidationPromises = attachments.map((item) =>
            set(validateItemsAtom, {
                items: [item],
                validationType: ItemValidationType.BACKEND,
                forceRefresh: false
            }).catch((error: any) => {
                logger(`Validation failed for standalone attachment ${item.key}: ${error.message}`, 2);
                return null;
            })
        );
        
        // Validate parent items of annotations
        const parentItems = annotations
            .map((item) => item.parentItem ?? null)
            .filter((item): item is Zotero.Item => item !== null);
        
        const parentItemValidationPromises = parentItems.map((item) =>
            set(validateItemsAtom, {
                items: [item],
                validationType: ItemValidationType.BACKEND,
                forceRefresh: false
            }).catch((error: any) => {
                logger(`Validation failed for parent item ${item.key}: ${error.message}`, 2);
                return null;
            })
        );
        
        // Wait for all validations to complete
        await Promise.all([
            ...regularItemValidationPromises,
            ...attachmentValidationPromises,
            ...parentItemValidationPromises
        ]);
        
        // Remove invalid items from currentMessageItemsAtom
        const invalidItems = items
            .map(item => ({
                item,
                validation: item.isAnnotation() && item.parentItem
                    ? {
                        ...getValidation(item.parentItem),
                        isValid: getValidation(item).isValid && getValidation(item.parentItem).isValid   
                    }
                    : getValidation(item)
            }))
            .filter(({ validation }) => validation && !validation.isValid);

        if (invalidItems.length > 0) {
            // Remove invalid items from currentMessageItemsAtom
            const currentItems = get(currentMessageItemsAtom);
            const invalidKeys = new Set(invalidItems.map(({ item }) => item.key));
            const validItems = currentItems.filter((item: Zotero.Item) => !invalidKeys.has(item.key));
            set(currentMessageItemsAtom, validItems);

            // Show error message with custom content
            let title = `${invalidItems.length} Items Removed`;
            if (invalidItems.length === 1) {
                const label = invalidItems[0].item.isAttachment() ? 'Invalid File' : 'Invalid Item';
                const name = invalidItems[0].item.isAnnotation()
                    ? 'Annotation'
                    : invalidItems[0].item.isNote() ? 'Note' : `"${invalidItems[0].item.getDisplayTitle()}"`
                title = `${label} ${truncateText(name, 60)}`
            }
            
            const invalidItemsData = invalidItems.map(({ item, validation }) => ({
                item,
                reason: validation?.reason || 'Unknown error'
            }));
            
            const popupMessageId = items.map((item) => item.key).join(',');
            set(removePopupMessageAtom, popupMessageId);
            set(addPopupMessageAtom, {
                id: popupMessageId,
                type: 'error',
                title,
                customContent: createElement(InvalidItemsMessageContent, { 
                    invalidItems: invalidItemsData 
                }),
                expire: isReaderAttachment ? false : true,
                duration: 3000
            });
        }

        // Show popup for regular items with invalid attachments or no PDF attachments
        const validRegularItems = regularItems.filter((item) => {
            const validation = getValidation(item);
            return validation && validation.isValid;
        });
        
        // Show individual popup for single item, summary popup for multiple items
        if (validRegularItems.length === 1) {
            set(addRegularItemPopupAtom, { item: validRegularItems[0], getValidation });
        } else if (validRegularItems.length > 1) {
            set(addRegularItemsSummaryPopupAtom, { items: validRegularItems, getValidation });
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
    async (get, set, limit?: number) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        const itemsFiltered = items.filter((item) => item.isRegularItem() || item.isAttachment());
        if (!limit || itemsFiltered.length <= limit) {
            await set(addItemsToCurrentMessageItemsAtom, itemsFiltered.slice(0, limit));
        }
    }
);


/**
* Update current reader attachment
*/
export const updateReaderAttachmentAtom = atom(
    null,
    async (get, set, reader?: any) => {
        // also gets the current reader item (parent item)
        // Zotero.getActiveZoteroPane().getSelectedItems()
        
        // Remove popup message for current reader attachment
        const currentReaderAttachmentKey = get(currentReaderAttachmentKeyAtom);
        if (currentReaderAttachmentKey) {
            set(removePopupMessageAtom, currentReaderAttachmentKey);
        }

        // Get current reader
        reader = reader || getCurrentReader();
        if (!reader) {
            set(currentReaderAttachmentAtom, null);
            return;
        }

        // Get reader item
        const item = await Zotero.Items.getAsync(reader.itemID);
        if (item) {
            set(currentReaderAttachmentAtom, item);
            validateItemsInBackground(get, set, [item], true);
        }
    }
);
