// @ts-ignore useEffect is defined in React
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { updateAttachmentsFromSelectedItemsAtom } from "../atoms/attachments";

/**
 * Listens to changes in Zotero tab selection and updates
 * the attachments based on the selected tab type.
 */
export function useZoteroTabSelection() {
    const updateAttachmentsFromSelectedItems = useSetAtom(updateAttachmentsFromSelectedItemsAtom);
    const window = Zotero.getMainWindow();

    useEffect(() => {
        // Handler for tab selection changes
        const tabObserver = {
            notify: function(event: string, type: string, ids: string[], extraData: any) {
                if (type === 'tab' && event === 'select') {
                    const selectedTab = window.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    
                    if (!selectedTab) return;

                    if (selectedTab.type === 'library') {
                        // For library tabs, get selected items from the active pane
                        const newSelectedItems = Zotero.getActiveZoteroPane().getSelectedItems() || [];
                        updateAttachmentsFromSelectedItems(newSelectedItems);
                    } 
                    else if (selectedTab.type === 'reader') {
                        // For reader tabs, get the attachment from the reader
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

        // Cleanup: unregister the observer when component unmounts
        return () => {
            // @ts-ignore unregisterObserver is not typed
            Zotero.Notifier.unregisterObserver(tabObserver);
        };
    }, [updateAttachmentsFromSelectedItems]);
} 