import { selectedTabIfAccepted } from '../../src/runtime/navigation';
import { getContextWindow } from '../runtime/windowRuntime';
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { logger } from "@beaver/agent-core/platform/logger";
import { isLibraryTabAtom, selectedZoteroTabIdAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';
import { syncLibrarySidebar } from '../ui/librarySidebar';
import { isLibraryTabSelected, isLibraryTabType } from '../../src/ui/libraryPane';

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
    const setSelectedTabId = useSetAtom(selectedZoteroTabIdAtom);

    // define main window
    const window = getContextWindow();

    useEffect(() => {
        logger("useZoteroTabSelection: initializing tab selection hook");
        if (!window) {
            setIsLibraryTab(true);
            setSelectedTabId("zotero-pane");
            return;
        }
        // Set initial state. The window may have gained a library view since
        // the plugin registered its panes (Zotero 11 builds them lazily).
        syncLibrarySidebar();
        const initialIsLibrary = isLibraryTabSelected(window);
        setIsLibraryTab(initialIsLibrary);
        setSelectedTabId(window.Zotero_Tabs.selectedID);

        let lastSelectedID = window.Zotero_Tabs.selectedID;
        let lastIsLibrary = initialIsLibrary;

        const refreshVisibleSidebar = (isLibrary: boolean) => {
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
        };

        // Handler for tab selection changes
        const tabObserver: { notify: _ZoteroTypes.Notifier.Notify } = {
            notify: async function(event: _ZoteroTypes.Notifier.Event, type: _ZoteroTypes.Notifier.Type, ids: string[] | number[], extraData: any) {
                if (type !== 'tab') return;
                if (event === 'select') {
                    const selectedTab = selectedTabIfAccepted(window, ids, extraData);
                    if (!selectedTab) return;
                    // Zotero 11 reports a library tab whose view is still being
                    // built as `library-loading`; its item pane already exists.
                    const isLibrary = isLibraryTabType(selectedTab.type);
                    // Another library tab may have become the active view.
                    if (isLibrary) syncLibrarySidebar();
                    if (lastSelectedID === selectedTab.id && lastIsLibrary === isLibrary) return;
                    lastSelectedID = selectedTab.id;
                    lastIsLibrary = isLibrary;

                    logger(`useZoteroTabSelection: tab changed to ${selectedTab.type}`);
                    setIsLibraryTab(isLibrary);
                    setSelectedTabId(selectedTab.id);
                    refreshVisibleSidebar(isLibrary);
                }
                // Zotero's typings predate the tab `load` event.
                else if ((event as string) === 'load') {
                    // A Zotero 11 library view finished loading, which restores
                    // its pane layout: show the sidebar in it again.
                    const selectedTab = selectedTabIfAccepted(window, ids, extraData);
                    if (!selectedTab || !isLibraryTabType(selectedTab.type)) return;
                    if (!(ids as (string | number)[]).includes(selectedTab.id)) return;
                    syncLibrarySidebar();
                    refreshVisibleSidebar(true);
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
    }, [setIsLibraryTab, setSelectedTabId, window]);
}
