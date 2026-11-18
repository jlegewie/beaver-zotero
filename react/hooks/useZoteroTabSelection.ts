import { selectedTabIfAccepted } from '../../src/runtime/navigation';
import { getContextWindow } from '../runtime/windowRuntime';
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { logger } from "@beaver/agent-core/platform/logger";
import { isLibraryTabAtom, isSidebarVisibleAtom, selectedZoteroTabIdAtom } from "../atoms/ui";
import { store } from '../store';
import { uiManager } from '../ui/UIManager';
import { isLibraryTabSelected, isLibraryTabType } from '../../src/ui/libraryPane';

/**
 * Module-level variable to track the Zotero notifier observer ID.
 * This persists across hot-reloads to ensure proper cleanup.
 */
let moduleTabNotifierId: string | null = null;

/**
 * Listens to changes in Zotero tab selection.
 *
 * Sets isLibraryTabAtom, and moves the sidebar to the selected tab's pane
 * through the UI manager.
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
        // Place the sidebar for the selected tab: the window may have gained
        // a library view since the sidebar was created (Zotero 11 builds them
        // lazily).
        const placeSidebar = (isLibrary: boolean) => {
            uiManager.updateUI({ isVisible: store.get(isSidebarVisibleAtom), isLibraryTab: isLibrary });
        };

        // Set initial state.
        const initialIsLibrary = isLibraryTabSelected(window);
        setIsLibraryTab(initialIsLibrary);
        setSelectedTabId(window.Zotero_Tabs.selectedID);
        placeSidebar(initialIsLibrary);

        let lastSelectedID = window.Zotero_Tabs.selectedID;
        let lastIsLibrary = initialIsLibrary;

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
                    if (isLibrary) placeSidebar(true);
                    if (lastSelectedID === selectedTab.id && lastIsLibrary === isLibrary) return;
                    lastSelectedID = selectedTab.id;
                    lastIsLibrary = isLibrary;
                    // Move the sidebar before anything re-renders, so it is
                    // never painted in the pane it is leaving.
                    if (!isLibrary) placeSidebar(false);

                    logger(`useZoteroTabSelection: tab changed to ${selectedTab.type}`);
                    setIsLibraryTab(isLibrary);
                    setSelectedTabId(selectedTab.id);
                }
                // Zotero's typings predate the tab `load` event.
                else if ((event as string) === 'load') {
                    // A Zotero 11 library view finished loading, which restores
                    // its pane layout: show the sidebar in it again.
                    const selectedTab = selectedTabIfAccepted(window, ids, extraData);
                    if (!selectedTab || !isLibraryTabType(selectedTab.type)) return;
                    if (!(ids as (string | number)[]).includes(selectedTab.id)) return;
                    placeSidebar(true);
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
        // Ahead of Zotero's context pane (priority 20), which collapses that
        // pane when a library tab is selected: the sidebar has to leave it
        // first, or the collapse resets the scroll offsets inside the sidebar.
        const myObserverId = Zotero.Notifier.registerObserver(tabObserver, ['tab'], 'beaver-tabSelectionObserver', 10);
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
