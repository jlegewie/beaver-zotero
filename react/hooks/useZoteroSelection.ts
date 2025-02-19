import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { selectedItemsAtom } from "../atoms/attachments";

/**
* Listens to changes in the Zotero item selection and updates
* the selectedItemsAtom only when the selection differs from the previous one.
*/
export function useZoteroSelection() {
    const setSelectedItems = useSetAtom(selectedItemsAtom);
        
    useEffect(() => {
        // Handler called whenever the Zotero selection changes
        const handleSelectionChange = () => {
            Zotero.debug("selected"); // For debugging
            
            // Retrieve newly selected items from Zotero
            const newSelectedItems: Zotero.Item[] =
            Zotero.getActiveZoteroPane().getSelectedItems() || [];
            
            // Update the selected items atom
            setSelectedItems(newSelectedItems);
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
