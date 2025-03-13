// @ts-ignore useEffect is defined in React
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { updateSourcesFromZoteroItemsAtom } from "../atoms/input";
import { isLibraryTabAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';

/**
 * Listens to changes in Zotero tab selection
 * 
 * Sets isLibraryTabAtom and updates sources based on the selected tab type.
 */
export function useZoteroTabSelection() {
    const updateSourcesFromZoteroItems = useSetAtom(updateSourcesFromZoteroItemsAtom);
    const setIsLibraryTab = useSetAtom(isLibraryTabAtom);
    const window = Zotero.getMainWindow();

    useEffect(() => {
        // Set initial state
        const initialIsLibrary = window.Zotero_Tabs.selectedType === 'library';
        setIsLibraryTab(initialIsLibrary);

        // Handler for tab selection changes
        const tabObserver = {
            notify: async function(event: string, type: string, ids: string[], extraData: any) {
                if (type === 'tab' && event === 'select') {
                    const selectedTab = window.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    if (!selectedTab) return;

                    const isLibrary = selectedTab.type === 'library';
                    setIsLibraryTab(isLibrary);

                    // Update UI through UIManager if sidebar is visible
                    const isVisible = window.document.querySelector("#zotero-beaver-tb-chat-toggle")?.hasAttribute("selected");
                    if (isVisible) {
                        uiManager.updateUI({
                            isVisible: true,
                            isLibraryTab: isLibrary,
                            collapseState: {
                                library: null,
                                reader: null
                            }
                        });
                    }

                    // Update sources
                    if (isLibrary) {
                        const newSelectedItems = Zotero.getActiveZoteroPane().getSelectedItems() || [];
                        await updateSourcesFromZoteroItems(newSelectedItems);
                    } else if (selectedTab.type === 'reader') {
                        const reader = Zotero.Reader.getByTabID(selectedTab.id);
                        if (reader) {
                            // @ts-ignore itemID is not typed
                            const item = Zotero.Items.get(reader.itemID);
                            if (item) {
                                updateSourcesFromZoteroItems([item]);
                            }
                        }
                    }
                }
            }
        };

        // Register the observer
        // @ts-ignore registerObserver is not typed
        Zotero.Notifier.registerObserver(tabObserver, ['tab'], 'beaver-tabSelectionObserver');
        // @ts-ignore unregisterObserver is not typed
        return () => Zotero.Notifier.unregisterObserver(tabObserver);
    }, [updateSourcesFromZoteroItems, setIsLibraryTab]);
} 