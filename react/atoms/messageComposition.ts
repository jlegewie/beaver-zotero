import { atom } from "jotai";
import { truncateText } from "../utils/stringUtils";
import { allUserAttachmentKeysAtom } from "../agents/atoms";
import { createElement } from 'react';
import { logger } from "../../src/utils/logger";
import { addPopupMessageAtom, addRegularItemPopupAtom, addRegularItemsSummaryPopupAtom, removePopupMessageAtom, safeChildAttachments } from "../utils/popupMessageUtils";
import { getItemValidationAtom, isHardBlockedValidation, isRejectedItemValidation, validateItemsAtom, validateRegularItemAtom } from './itemValidation';
import { searchableLibraryIdsAtom } from './profile';
import type { ItemValidationState } from './itemValidation';
import { toReadabilityInfo, summarizeRegularItemReadability } from '../utils/attachmentReadabilityCopy';
import { InvalidItemsMessageContent } from '../components/ui/popup/InvalidItemsMessageContent';
import { agentItemFilter } from "../../src/utils/agentItemSupport";
import { getCurrentReader } from "../utils/readerUtils";
import { TextSelection } from "../types/attachments/apiTypes";
import { ZoteroTag, CollectionReference } from "../types/zotero";
import type { ExternalFileRecord } from "../../src/services/database";
import { currentNoteItemAtom } from "./zoteroContext";
import type { SlashCommandDescriptor } from "../utils/slashCommands";


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
 * Current message collection attachments.
 * Set when a collection action is triggered (context menu, slash menu).
 * Cleared after the message is sent.
 */
export const currentMessageCollectionsAtom = atom<CollectionReference[]>([]);

/**
 * External files (files from disk, not Zotero items) attached to the current
 * message via drag-and-drop or the "Select File" menu. Kept separate from
 * currentMessageItemsAtom, which is deeply coupled to Zotero.Item. Records
 * point at copies in the Beaver-managed external-files folder; cleared after
 * the message is sent.
 */
export const currentMessageExternalFilesAtom = atom<ExternalFileRecord[]>([]);

/**
 * Add external file records to the current message (deduped by ext key).
 */
export const addExternalFilesToCurrentMessageAtom = atom(
    null,
    (get, set, records: ExternalFileRecord[]) => {
        const current = get(currentMessageExternalFilesAtom);
        const newRecords = records.filter(
            (record) => !current.some((existing) => existing.extKey === record.extKey)
        );
        if (newRecords.length === 0) return;
        set(currentMessageExternalFilesAtom, [...current, ...newRecords]);
    }
);

/**
 * Remove one external file from the current message.
 */
export const removeExternalFileFromMessageAtom = atom(
    null,
    (_, set, extKey: string) => {
        set(currentMessageExternalFilesAtom, (prev) =>
            prev.filter((record) => record.extKey !== extKey)
        );
    }
);

/**
 * A /command pill waiting to be inserted into the chat input. Set by
 * `stageActionPillAtom` (home launcher, context menu, reader toolbar) and
 * consumed by InputArea, which owns the editor handle: it inserts the pill,
 * focuses the editor, and clears this atom. The `nonce` distinguishes
 * consecutive requests for the same action.
 *
 * `targetWindow` names the surface where the user triggered the action, so
 * that when several InputAreas are mounted (main-window sidebar + separate
 * Beaver window) the pill deterministically lands in the right editor.
 */
export const pendingPillInsertAtom = atom<{
    descriptor: SlashCommandDescriptor;
    targetWindow?: Window;
    nonce: number;
} | null>(null);

/**
 * The /command pills currently in the message, in document order — the shared
 * companion to `currentMessageContentAtom` (which only carries plain text).
 * The editor the user edits in pushes its pills here; other mounted editors
 * (main sidebar vs separate Beaver window) use it to rebuild real pill nodes
 * when they sync the shared content string, so pills render and submit
 * correctly from every surface.
 */
export const currentMessagePillsAtom = atom<SlashCommandDescriptor[]>([]);

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
* Current note tab item key (note open in its own tab)
*/
export const currentNoteTabItemKeyAtom = atom<string | null>((get) => {
    const item = get(currentNoteItemAtom);
    return item?.key || null;
});

/**
 * Current reader text selection
*/
export const readerTextSelectionAtom = atom<TextSelection | null>(null);

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
* Remove all editable context from the current message at once.
* Clears attached items (and their popup messages), message collections, and
* library/collection/tag filters as well as the reader text selection.
*
* Non-editable context (current reader attachment, current note tab) is left
* untouched since it is derived from the active Zotero state rather than the
* user's manual selection.
*/
export const clearMessageContextAtom = atom(
    null,
    (get, set) => {
        // Remove popup messages tied to attached items
        const items = get(currentMessageItemsAtom);
        for (const item of items) {
            set(removePopupMessageAtom, item.key);
        }
        set(currentMessageItemsAtom, []);
        set(currentMessageCollectionsAtom, []);
        set(currentMessageExternalFilesAtom, []);
        set(currentMessageFiltersAtom, createDefaultMessageFilters());
        set(readerTextSelectionAtom, null);
    }
);

/**
* Add single item to currentMessageItemsAtom
* Validates in background and removes if rejected
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
* Validates in background and removes if rejected
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
        const preValidatedItems = newItems.filter((i) => agentItemFilter(i) || i.isAnnotation() || i.isNote());

        // Add items immediately (optimistic update)
        set(currentMessageItemsAtom, [...currentItems, ...preValidatedItems]);

        // Validate items in background (non-blocking)
        // This will update itemValidationResultsAtom as validation progresses
        // SourceButton will show: spinner → checkmark/error
        validateItemsInBackground(get, set, newItems);
    }
);

/**
 * Whether to warn that a freshly added regular item has unreadable attachments.
 *
 * The item itself remains usable when at least one attachment is readable, but
 * the popup still surfaces any completed attachment-level issue.
 */
function shouldShowRegularItemAddedPopup(
    item: Zotero.Item,
    getValidation: (item: Zotero.Item) => ItemValidationState | undefined,
): boolean {
    const attachments = safeChildAttachments(item);
    if (attachments.length === 0) return false;

    const infos = attachments.map((attachment) => toReadabilityInfo(getValidation(attachment)));
    const summary = summarizeRegularItemReadability(infos);
    return Boolean(summary.label);
}

/**
 * Validate items in background and remove rejected ones
 * This runs asynchronously without blocking the UI
 * 
 * Uses batch validation for regular items (validates item + all attachments together)
 * and individual validation for standalone attachments and annotations.
 * 
 * Uses the local validation path for all item types.
 */
async function validateItemsInBackground(
    get: any,
    set: any,
    items: Zotero.Item[],
    isReaderAttachment: boolean = false
) {
    const getValidation = get(getItemValidationAtom);
    logger(`validateItemsInBackground: Validating ${items.length} items`, 3);
    
    try {
        // Separate regular items from standalone attachments, annotations, and notes
        const regularItems = items.filter((item) => item.isRegularItem());
        const attachments = items.filter((item) => item.isAttachment());
        const annotations = items.filter((item) => item.isAnnotation());
        const notes = items.filter((item) => item.isNote());
        
        // Validate regular items with their attachments.
        const regularItemValidationPromises = regularItems.map((item) => 
            set(validateRegularItemAtom, item).catch((error: any) => {
                logger(`Batch validation failed for regular item ${item.key}: ${error.message}`, 2);
                return null;
            })
        );
        
        // Validate standalone attachments individually.
        const attachmentValidationPromises = attachments.map((item) =>
            set(validateItemsAtom, {
                items: [item]
            }).catch((error: any) => {
                logger(`Validation failed for standalone attachment ${item.key}: ${error.message}`, 2);
                return null;
            })
        );
        
        // Validate annotations themselves first, then their parent attachments.
        const annotationValidationPromises = annotations.map((item) => {
            logger(`validateItemsInBackground: Validating annotation ${item.libraryID}-${item.key}`, 3);
            return set(validateItemsAtom, {
                items: [item]
            }).catch((error: any) => {
                logger(`Validation failed for annotation ${item.key}: ${error.message}`, 2);
                return null;
            });
        });

        const noteValidationPromises = notes.map((item) => {
            logger(`validateItemsInBackground: Validating note ${item.libraryID}-${item.key}`, 3);
            return set(validateItemsAtom, {
                items: [item]
            }).catch((error: any) => {
                logger(`Validation failed for note ${item.key}: ${error.message}`, 2);
                return null;
            });
        });

        // Validate parent items of annotations.
        const parentItems = annotations
            .map((item) => item.parentItem ?? null)
            .filter((item): item is Zotero.Item => item !== null);

        const parentItemValidationPromises = parentItems.map((item) =>
            set(validateItemsAtom, {
                items: [item]
            }).catch((error: any) => {
                logger(`Validation failed for parent item ${item.key}: ${error.message}`, 2);
                return null;
            })
        );

        // Wait for all validations to complete
        await Promise.all([
            ...regularItemValidationPromises,
            ...attachmentValidationPromises,
            ...annotationValidationPromises,
            ...noteValidationPromises,
            ...parentItemValidationPromises
        ]);
        
        // Remove rejected items from currentMessageItemsAtom.
        const rejectedItems = items
            .map(item => {
                const itemValidation = getValidation(item);
                const parentValidation = item.parentItem ? getValidation(item.parentItem) : undefined;
                
                logger(`validateItemsInBackground: Checking item ${item.libraryID}-${item.key}, isAnnotation: ${item.isAnnotation()}, itemValidation: ${itemValidation ? JSON.stringify(itemValidation) : 'undefined'}, parentValidation: ${parentValidation ? JSON.stringify(parentValidation) : 'undefined'}`, 3);
                
                const validation = item.isAnnotation() && item.parentItem && isHardBlockedValidation(parentValidation)
                    ? parentValidation
                    : itemValidation;
                
                logger(`validateItemsInBackground: Combined validation for ${item.libraryID}-${item.key}: ${validation ? JSON.stringify(validation) : 'undefined'}`, 3);
                
                return { item, validation };
            })
            .filter(({ item, validation }) => {
                const isRejected = isRejectedItemValidation(item, validation);
                if (isRejected) {
                    logger(`validateItemsInBackground: Filtering out rejected item ${item.libraryID}-${item.key}, reason: ${validation?.reason}`, 3);
                }
                return isRejected;
            });

        logger(`validateItemsInBackground: Found ${rejectedItems.length} rejected items to remove`, 3);

        if (rejectedItems.length > 0) {
            // Remove rejected items from currentMessageItemsAtom
            const currentItems = get(currentMessageItemsAtom);
            const invalidKeys = new Set(rejectedItems.map(({ item }) => item.key));
            const validItems = currentItems.filter((item: Zotero.Item) => !invalidKeys.has(item.key));
            set(currentMessageItemsAtom, validItems);

            // Show error message with custom content
            let title = `${rejectedItems.length} Items Removed`;
            if (rejectedItems.length === 1) {
                const label = rejectedItems[0].item.isAttachment() ? 'File Removed' : 'Item Removed';
                const name = rejectedItems[0].item.isAnnotation()
                    ? 'Annotation'
                    : rejectedItems[0].item.isNote() ? 'Note' : `"${rejectedItems[0].item.getDisplayTitle()}"`
                title = `${label} ${truncateText(name, 60)}`
            }
            
            const invalidItemsData = rejectedItems.map(({ item, validation }) => ({
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
                duration: 5000
            });
        }

        const regularItemsNeedingPopup = regularItems.filter((item) => {
            const validation = getValidation(item);
            return validation
                && !isRejectedItemValidation(item, validation)
                && shouldShowRegularItemAddedPopup(item, getValidation);
        });
        
        // Show individual popup for single item, summary popup for multiple items
        if (regularItemsNeedingPopup.length === 1) {
            set(addRegularItemPopupAtom, { item: regularItemsNeedingPopup[0], getValidation });
        } else if (regularItemsNeedingPopup.length > 1) {
            set(addRegularItemsSummaryPopupAtom, { items: regularItemsNeedingPopup, getValidation });
        }

    } catch (error: any) {
        logger(`Background validation failed: ${error.message}`, 1);
    }
}

/**
* Update sources based on Zotero selection
* Filters out items that are already in the thread (by zotero_key)
*/
export const updateMessageItemsFromZoteroSelectionAtom = atom(
    null,
    async (get, set, limit?: number) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        // Never stage items from libraries the user excluded from Beaver.
        const searchableLibraryIds = get(searchableLibraryIdsAtom);
        const itemsFiltered = items.filter((item) =>
            (item.isRegularItem() || item.isAttachment() || item.isNote()) &&
            searchableLibraryIds.includes(item.libraryID)
        );

        // Filter out items already in the thread
        const existingKeys = get(allUserAttachmentKeysAtom);
        const newItems = itemsFiltered.filter((item) => !existingKeys.has(`${item.libraryID}-${item.key}`));
        
        if (!limit || newItems.length <= limit) {
            await set(addItemsToCurrentMessageItemsAtom, newItems.slice(0, limit));
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
