// @ts-ignore useEffect is defined in React
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { updateAttachmentsFromSelectedItemsAtom } from "../atoms/attachments";
import { isLibraryTabAtom, isSidebarVisibleAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';

/**
 * Listens to changes in Zotero tab selection
 * 
 * Sets isLibraryTabAtom and updates attachments based on the selected tab type.
 */
export function useZoteroTabSelection() {
    const updateAttachmentsFromSelectedItems = useSetAtom(updateAttachmentsFromSelectedItemsAtom);
    const setIsLibraryTab = useSetAtom(isLibraryTabAtom);
    const window = Zotero.getMainWindow();

    useEffect(() => {
        // Set initial state
        const initialIsLibrary = window.Zotero_Tabs.selectedType === 'library';
        setIsLibraryTab(initialIsLibrary);

        // Handler for tab selection changes
        const tabObserver = {
            notify: function(event: string, type: string, ids: string[], extraData: any) {
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

                    // Update attachments
                    if (isLibrary) {
                        const newSelectedItems = Zotero.getActiveZoteroPane().getSelectedItems() || [];
                        updateAttachmentsFromSelectedItems(newSelectedItems);
                    } else if (selectedTab.type === 'reader') {
                        const reader = Zotero.Reader.getByTabID(selectedTab.id);
                        if (reader) {
                            // @ts-ignore itemID is not typed
                            const attachment = Zotero.Items.get(reader.itemID);
                            if (attachment) {
                                updateAttachmentsFromSelectedItems([attachment]);
                            }
                        }
                    }
                }
            }
        };

        // Register the observer
        // @ts-ignore registerObserver is not typed
        Zotero.Notifier.registerObserver(tabObserver, ['tab'], 'tabSelectionObserver');
        // @ts-ignore unregisterObserver is not typed
        return () => Zotero.Notifier.unregisterObserver(tabObserver);
    }, [updateAttachmentsFromSelectedItems, setIsLibraryTab]);
} 