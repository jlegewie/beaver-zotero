import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { currentZoteroSelectionAtom } from "../atoms/input";

/**
* Listens to changes in the Zotero item selection and updates
* currentZoteroSelectionAtom (max 5 items).
*/
export function useZoteroSelection() {
    const setCurrentZoteroSelection = useSetAtom(currentZoteroSelectionAtom);

    useEffect(() => {
        // Handler called whenever the Zotero selection changes
        const handleSelectionChange = () => {
            // Retrieve selected items from Zotero
            const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
            
            // Truncate to max 5 items
            const truncatedItems = selectedItems.slice(0, 5);
            
            // Update the atom
            setCurrentZoteroSelection(truncatedItems);
        };
        
        // Subscribe to Zotero selection events
        // @ts-ignore itemsView is not fully typed
        Zotero.getActiveZoteroPane().itemsView.onSelect.addListener(handleSelectionChange);
        
        // Cleanup subscription on unmount
        return () => {
            // @ts-ignore itemsView is not fully typed
            Zotero.getActiveZoteroPane().itemsView.onSelect.removeListener(handleSelectionChange);
        };
    }, [setCurrentZoteroSelection]);
}
