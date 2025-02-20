import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { updateAttachmentsFromSelectedItemsAtom, removedItemKeysCache } from "../atoms/attachments";

/**
* Listens to changes in the Zotero item selection and updates
* the selectedItemsAtom only when the selection differs from the previous one.
*/
export function useZoteroSelection() {
    const updateAttachmentsFromSelectedItems = useSetAtom(updateAttachmentsFromSelectedItemsAtom);
    const lastSelectionKeys = useRef<string[]>([]);

    useEffect(() => {
        // Handler called whenever the Zotero selection changes
        const handleSelectionChange = () => {
            // Retrieve newly selected items from Zotero
            const newSelectedItems: Zotero.Item[] =
            Zotero.getActiveZoteroPane().getSelectedItems() || [];

            // Remove newly selected items from the removed item keys cache
            // Logic: When the user re-selects an item that was previously removed,
            // we need to remove it from the removed item keys cache.
            const newlySelectedKeys = newSelectedItems
                .map((item) => item.key)
                .filter((key) => !lastSelectionKeys.current.includes(key));
            newlySelectedKeys.forEach((key) => removedItemKeysCache.delete(key));

            // Update the selected items atom
            updateAttachmentsFromSelectedItems(newSelectedItems);

            // Update the last selection keys
            lastSelectionKeys.current = newSelectedItems.map((item) => item.key);
        };
        
        // Subscribe to Zotero selection events
        // @ts-ignore itemsView is not fully typed
        Zotero.getActiveZoteroPane().itemsView.onSelect.addListener(handleSelectionChange);
        
        // Cleanup subscription on unmount
        return () => {
            // @ts-ignore itemsView is not fully typed
            Zotero.getActiveZoteroPane().itemsView.onSelect.removeListener(handleSelectionChange);
        };
    }, [updateAttachmentsFromSelectedItems]);
}
