import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { logger } from "../../src/utils/logger";
import { readerItemKeyAtom, updateSourcesFromReaderAtom, updateSourcesFromZoteroItemsAtom } from "../atoms/input";
import { isLibraryTabAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';

/**
 * Listens to changes in Zotero tab selection.
 *
 * Sets isLibraryTabAtom and updates sources based on the selected tab type.
 * Updates the main UI state when tabs change.
 * Does NOT manage reader text selection listeners (handled by useReaderTextSelection).
 */
export function useZoteroTabSelection() {
    const updateSourcesFromZoteroItems = useSetAtom(updateSourcesFromZoteroItemsAtom);
    const setIsLibraryTab = useSetAtom(isLibraryTabAtom);
    const setReaderItemKey = useSetAtom(readerItemKeyAtom);
    const updateSourcesFromReader = useSetAtom(updateSourcesFromReaderAtom);
    // ref to prevent multiple registrations if dependencies change
    const observerRef = useRef<any>(null);
    
    // define main window
    const window = Zotero.getMainWindow();
    
    useEffect(() => {
        logger("useZoteroTabSelection: initializing tab selection hook");
        // Set initial state
        const initialIsLibrary = window.Zotero_Tabs.selectedType === 'library';
        setIsLibraryTab(initialIsLibrary);

        // Handler for tab selection changes
        const tabObserver = {
            notify: async function(event: string, type: string, ids: string[], extraData: any) {
                if (type === 'tab' && event === 'select') {
                    const selectedTab = window.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    if (!selectedTab) return;

                    // Update isLibraryTab atom
                    const isLibrary = selectedTab.type === 'library';
                    logger(`useZoteroTabSelection: tab changed to ${selectedTab.type}`);
                    setIsLibraryTab(isLibrary);

                    // Get the reader for the selected tab
                    let reader = null;
                    if (!isLibrary && selectedTab.type === 'reader') { // Ensure it's actually a reader tab
                        reader = Zotero.Reader.getByTabID(selectedTab.id);
                    }

                    // Update UI through UIManager if sidebar is visible
                    const isVisible = window.document.querySelector("#zotero-beaver-tb-chat-toggle")?.hasAttribute("selected");
                    if (isVisible) {
                        logger("useZoteroTabSelection: updating sidebar UI via UIManager");
                        uiManager.updateUI({
                            isVisible: true,
                            isLibraryTab: isLibrary,
                            collapseState: { // Reset collapse state on tab change? Or fetch current? Assuming reset for now.
                                library: null,
                                reader: null
                            }
                        });
                    }

                    // Update sources based on tab type
                    if (isLibrary) {
                        logger("useZoteroTabSelection: updating sources from library items");
                        const newSelectedItems = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
                        // Check if pane exists before calling getSelectedItems
                        await updateSourcesFromZoteroItems(newSelectedItems);
                        setReaderItemKey(null);
                    } else if (reader) { // Check if reader instance exists
                        logger(`useZoteroTabSelection: reader tab selected (itemID: ${reader.itemID}), updating sources`);
                        // Update sources using the reader instance
                        updateSourcesFromReader(reader);
                    } else {
                        // Handle cases where it's not library and not a reader (or reader couldn't be fetched)
                        logger(`useZoteroTabSelection: selected tab is neither library nor a recognized reader (${selectedTab.type}). Clearing reader-specific state.`);
                        setReaderItemKey(null);
                         // Maybe clear sources here too? depends on desired behavior
                        // updateSourcesFromReader(null);
                    }
                }
            }
        };

        // Register the observer
        // @ts-ignore registerObserver is not typed
        Zotero.Notifier.registerObserver(tabObserver, ['tab'], 'beaver-tabSelectionObserver');
        logger("useZoteroTabSelection: registered tab selection observer");
        observerRef.current = tabObserver;
        
        // Cleanup function
        return () => {
            logger("useZoteroTabSelection: cleaning up tab observer");
            if (observerRef.current) {
                logger("useZoteroTabSelection: unregistering tab observer");
                Zotero.Notifier.unregisterObserver(observerRef.current);
                observerRef.current = null;
            }
        };
    }, [updateSourcesFromZoteroItems, setIsLibraryTab, setReaderItemKey, updateSourcesFromReader, window]);
} 