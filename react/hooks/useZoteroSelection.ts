import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { selectedItemsAtom, removedItemKeysAtom } from "../atoms/attachments";

/**
* Listens to changes in the Zotero item selection and updates
* the selectedItemsAtom only when the selection differs from the previous one.
*/
export function useZoteroSelection() {
    const setSelectedItems = useSetAtom(selectedItemsAtom);
    const setRemovedItemKeys = useSetAtom(removedItemKeysAtom);
    const lastSelectionKeys = useRef<string[]>([]);

    useEffect(() => {
        // Handler called whenever the Zotero selection changes
        const handleSelectionChange = () => {
            // Retrieve newly selected items from Zotero
            const newSelectedItems: Zotero.Item[] =
            Zotero.getActiveZoteroPane().getSelectedItems() || [];
            
            // Update the selected items atom
            setSelectedItems(newSelectedItems);

            // Remove newly selected items from the removed item keys
            // Logic: When the user re-selects an item that was previously removed,
            // we need to remove it from the removed item keys.
            const newlySelectedKeys = newSelectedItems
                .map((item) => item.key)
                .filter((key) => !lastSelectionKeys.current.includes(key));
            setRemovedItemKeys((prev) => prev.filter((key) => !newlySelectedKeys.includes(key)));

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
    }, [setSelectedItems]);
}
