import { useEffect, useRef } from "react";

/**
* Listens to changes in the Zotero item selection and update
* currentSourcesAtom when the selection differs from the previous one.
*/
export function useZoteroSelection() {
    const lastSelectionKeys = useRef<string[]>([]);

    useEffect(() => {
        // Handler called whenever the Zotero selection changes
        const handleSelectionChange = async () => {
            // Retrieve newly selected items from Zotero
            const newSelectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];

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
    }, []);
}
