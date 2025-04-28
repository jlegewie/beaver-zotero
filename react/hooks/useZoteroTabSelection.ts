// @ts-ignore useEffect is defined in React
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { logger } from "../../src/utils/logger";
import { readerItemKeyAtom, readerTextSelectionAtom, updateSourcesFromReaderAtom, updateSourcesFromZoteroItemsAtom } from "../atoms/input";
import { isLibraryTabAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';
import { TextSelection, addSelectionChangeListener, getCurrentReader, getSelectedTextAsTextSelection } from "../utils/readerUtils";

/**
 * Listens to changes in Zotero tab selection
 * 
 * Sets isLibraryTabAtom and updates sources based on the selected tab type.
 * Also manages the reader text selection listener based on the active tab.
 */
export function useZoteroTabSelection() {
    const updateSourcesFromZoteroItems = useSetAtom(updateSourcesFromZoteroItemsAtom);
    const setIsLibraryTab = useSetAtom(isLibraryTabAtom);
    const setReaderItemKey = useSetAtom(readerItemKeyAtom);
    const updateSourcesFromReader = useSetAtom(updateSourcesFromReaderAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
    // ref to prevent multiple registrations if dependencies change
    const observerRef = useRef<any>(null);
    const selectionCleanupRef = useRef<(() => void) | null>(null);
    
    // define main window
    const window = Zotero.getMainWindow();
    
    useEffect(() => {
        logger("useZoteroTabSelection: initializing tab selection hook");
        // Set initial state
        const initialIsLibrary = window.Zotero_Tabs.selectedType === 'library';
        setIsLibraryTab(initialIsLibrary);
        if (!initialIsLibrary && window.Zotero_Tabs.selectedID) {
            const reader = getCurrentReader(window);
            if (reader) {
                logger(`useZoteroTabSelection: initial reader tab detected, setting up selection listener`);
                selectionCleanupRef.current = addSelectionChangeListener(reader, (newSelection: TextSelection) => {                    
                    logger(`useZoteroTabSelection: (initial listener) Selection changed in reader, updating selection to "${newSelection.text}"`);
                    setReaderTextSelection(newSelection);
                });
                // TODO: NOT SURE IF THIS IS NEEDED
                updateSourcesFromReader(reader);
            }
        }

        const resetReaderTextSelection = (reader: any) => {
            // Add new selection listener
            logger("useZoteroTabSelection: setting up reader selection listener");
            selectionCleanupRef.current = addSelectionChangeListener(reader, (newSelection: TextSelection) => {
                logger(`useZoteroTabSelection: Selection changed in reader, updating selection to "${newSelection.text}"`);
                setReaderTextSelection(newSelection);
            });
            // Update current text selection
            const selection = getSelectedTextAsTextSelection(reader);
            if (selection) {
                logger("useZoteroTabSelection: setting reader text selection to current selection");
                setReaderTextSelection(selection);
            }
            else {
                logger("useZoteroTabSelection: no selection in reader, setting reader text selection to null");
                setReaderTextSelection(null);
            }
        }

        // Function to poll for reader._internalReader
        const waitForInternalReader = (reader: any, maxTime = 2000) => {
            const startTime = Date.now();
            const checkInterval = 100; // Check every 100ms
            
            const poll = () => {
                // Check if reader is ready
                if (reader._internalReader && reader._internalReader._primaryView && reader._internalReader._primaryView._iframeWindow) {
                    logger("useZoteroTabSelection: reader._internalReader is ready");
                    resetReaderTextSelection(reader);
                    return;
                }
                
                // Check if we've exceeded the maximum wait time
                if (Date.now() - startTime >= maxTime) {
                    logger("useZoteroTabSelection: timed out waiting for reader._internalReader");
                    // Try anyway as a fallback
                    resetReaderTextSelection(reader);
                    return;
                }
                
                // Continue polling
                setTimeout(poll, checkInterval);
            };
            
            // Start polling
            poll();
        };

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
                    if (!isLibrary) {
                        reader = Zotero.Reader.getByTabID(selectedTab.id);
                    }

                    // Update UI through UIManager if sidebar is visible
                    const isVisible = window.document.querySelector("#zotero-beaver-tb-chat-toggle")?.hasAttribute("selected");
                    if (isVisible) {
                        logger("useZoteroTabSelection: updating sidebar UI");
                        uiManager.updateUI({
                            isVisible: true,
                            isLibraryTab: isLibrary,
                            collapseState: {
                                library: null,
                                reader: null
                            }
                        });
                    }

                    // Cleanup previous selection listener
                    if (selectionCleanupRef.current) {
                        logger("useZoteroTabSelection: cleaning up previous selection listener");
                        selectionCleanupRef.current();
                        selectionCleanupRef.current = null;
                    }

                    // Update sources and text selection
                    if (isLibrary) {
                        logger("useZoteroTabSelection: updating sources from library items");
                        const newSelectedItems = Zotero.getActiveZoteroPane().getSelectedItems() || [];
                        await updateSourcesFromZoteroItems(newSelectedItems);
                        setReaderItemKey(null);
                        setReaderTextSelection(null);
                    } else if (selectedTab.type === 'reader') {
                        if (reader) {
                            // Update sources
                            updateSourcesFromReader(reader);
                            
                            // Wait for reader._internalReader to be defined
                            waitForInternalReader(reader);
                        }
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
            logger("useZoteroTabSelection: cleaning up tab observer and selection listener");
            if (selectionCleanupRef.current) {
                selectionCleanupRef.current();
                selectionCleanupRef.current = null;
            }
            if (observerRef.current) {
                Zotero.Notifier.unregisterObserver(observerRef.current);
                observerRef.current = null;
            }
        };
    }, [updateSourcesFromZoteroItems, setIsLibraryTab, setReaderItemKey, updateSourcesFromReader, setReaderTextSelection]);
} 