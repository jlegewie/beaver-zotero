import { SkippedItem } from '../../react/types/zotero';
import { getPref, setPref } from '../utils/prefs';

const SKIPPED_ITEMS_PREF = 'skippedItems';

/**
 * Manages items that are skipped during synchronization.
 * The list of skipped items is stored in Zotero preferences.
 */
export class SkippedItemsManager {
    private static instance: SkippedItemsManager;

    private constructor() {
        // Private constructor for singleton
    }

    public static getInstance(): SkippedItemsManager {
        if (!SkippedItemsManager.instance) {
            SkippedItemsManager.instance = new SkippedItemsManager();
        }
        return SkippedItemsManager.instance;
    }

    /**
     * Retrieves all skipped items from preferences.
     * @returns An array of SkippedItem objects.
     */
    public getAll(): SkippedItem[] {
        try {
            const raw = getPref(SKIPPED_ITEMS_PREF);
            if (raw && typeof raw === 'string') {
                const skippedItems = JSON.parse(raw) as SkippedItem[];
                if (Array.isArray(skippedItems)) {
                    return skippedItems;
                }
            }
        } catch (e) {
            Zotero.log(`Error parsing skippedItems preference: ${e}`, 'error');
            return [];
        }
        return [];
    }

    /**
     * Adds or updates a skipped item in the preferences.
     * @param item The Zotero.Item to upsert.
     * @param reason The reason the item is being skipped.
     */
    public upsert(item: Zotero.Item, reason: string): void {
        this.batchUpsert([item], reason);
    }

    /**
     * Adds or updates multiple skipped items in the preferences.
     * All items will be assigned the same reason.
     * @param itemsToSkip An array of Zotero.Item objects to upsert.
     * @param reason The reason the items are being skipped.
     */
    public batchUpsert(itemsToSkip: Zotero.Item[], reason: string): void {
        const existingSkippedItems = this.getAll();
        const skippedItemsMap = new Map<string, SkippedItem>();

        // Populate map for quick lookups
        for (const item of existingSkippedItems) {
            skippedItemsMap.set(`${item.library_id}-${item.zotero_key}`, item);
        }

        for (const itemToSkip of itemsToSkip) {
            const key = `${itemToSkip.libraryID}-${itemToSkip.key}`;
            const skippedItem: SkippedItem = {
                zotero_key: itemToSkip.key,
                library_id: itemToSkip.libraryID,
                reason: reason,
            };
            skippedItemsMap.set(key, skippedItem);
        }
    
        const newSkippedItems = Array.from(skippedItemsMap.values());
        setPref(SKIPPED_ITEMS_PREF, JSON.stringify(newSkippedItems));
    }

    /**
     * Deletes a skipped item from the preferences.
     * @param itemKey The key of the item to delete.
     * @param libraryId The library ID of the item to delete.
     */
    public delete(itemKey: string, libraryId: number): void {
        const items = this.getAll();
        const newItems = items.filter(
            (i) => !(i.zotero_key === itemKey && i.library_id === libraryId)
        );

        setPref(SKIPPED_ITEMS_PREF, JSON.stringify(newItems));
    }
}

export const skippedItemsManager = SkippedItemsManager.getInstance();
