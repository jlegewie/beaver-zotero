import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { logger } from "../../src/utils/logger";
import { isLibraryTabAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';

/**
 * Module-level variable to track the Zotero notifier observer ID.
 * This persists across hot-reloads to ensure proper cleanup.
 */
let moduleTabNotifierId: string | null = null;

/**
 * Listens to changes in Zotero tab selection.
 *
 * Sets isLibraryTabAtom and update UI through UIManager
 * Updates the main UI state when tabs change.
 */
export function useZoteroTabSelection() {
    const setIsLibraryTab = useSetAtom(isLibraryTabAtom);
    
    // define main window
    const window = Zotero.getMainWindow();
    
    useEffect(() => {
        logger("useZoteroTabSelection: initializing tab selection hook");
        // Set initial state
        const initialIsLibrary = window.Zotero_Tabs.selectedType === 'library';
        setIsLibraryTab(initialIsLibrary);

        // Handler for tab selection changes
        const tabObserver: { notify: _ZoteroTypes.Notifier.Notify } = {
            notify: async function(event: _ZoteroTypes.Notifier.Event, type: _ZoteroTypes.Notifier.Type, ids: string[] | number[], extraData: any) {
                if (type === 'tab' && event === 'select') {
                    const selectedTab = window.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    if (!selectedTab) return;

                    // Update isLibraryTab atom
                    const isLibrary = selectedTab.type === 'library';
                    logger(`useZoteroTabSelection: tab changed to ${selectedTab.type}`);
                    setIsLibraryTab(isLibrary);

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
                }
            }
        };

        // Unregister any existing observer before registering a new one
        // This handles hot-reload scenarios where cleanup may not have run
        if (moduleTabNotifierId) {
            try {
                Zotero.Notifier.unregisterObserver(moduleTabNotifierId);
                logger("useZoteroTabSelection: Unregistered stale observer before re-registering", 4);
            } catch (e) {
                // Ignore errors if observer was already unregistered
            }
            moduleTabNotifierId = null;
        }

        // Register the observer
        const myObserverId = Zotero.Notifier.registerObserver(tabObserver, ['tab'], 'beaver-tabSelectionObserver');
        moduleTabNotifierId = myObserverId;
        logger("useZoteroTabSelection: registered tab selection observer");
        
        // Cleanup function
        return () => {
            logger("useZoteroTabSelection: cleaning up tab observer");
            if (moduleTabNotifierId === myObserverId) {
                logger("useZoteroTabSelection: unregistering tab observer");
                Zotero.Notifier.unregisterObserver(myObserverId);
                moduleTabNotifierId = null;
            }
        };
    }, [setIsLibraryTab, window]);
} 