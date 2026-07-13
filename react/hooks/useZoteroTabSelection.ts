import { useEffect } from "react";
import { useSetAtom, useStore } from "jotai";
import { logger } from "../../src/utils/logger";
import { isLibraryTabAtom, selectedZoteroTabIdAtom } from "../atoms/ui";
import { uiManager } from '../ui/UIManager';
import {
    pendingComposerFocusTransferAtom,
    type ComposerFocusTransfer,
} from '../atoms/composerFocus';
import {
    captureComposerSelection,
    getComposerWindowToken,
    type ComposerSelection,
} from '../utils/composerSelection';

const POINTER_SNAPSHOT_TTL_MS = 1_000;
const TRANSFER_TTL_MS = 5_000;
const LOADING_TRANSFER_TTL_MS = 30_000;
const POST_LOAD_RESTORE_DELAY_MS = 100;

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
    const store = useStore();

    // define main window
    const window = Zotero.getMainWindow();

    useEffect(() => {
        logger("useZoteroTabSelection: initializing tab selection hook");
        const windowToken = getComposerWindowToken(window);
        let tabPointerSnapshot: { tabId: string; selection: ComposerSelection } | null = null;
        let pointerSnapshotTimer: number | null = null;
        let transferExpiryTimer: number | null = null;
        let activeTransfer: { tabId: string; transfer: ComposerFocusTransfer } | null = null;

        const clearPointerSnapshot = () => {
            tabPointerSnapshot = null;
            if (pointerSnapshotTimer !== null) {
                window.clearTimeout(pointerSnapshotTimer);
                pointerSnapshotTimer = null;
            }
        };

        const clearOwnedTransfer = () => {
            activeTransfer = null;
            if (transferExpiryTimer !== null) {
                window.clearTimeout(transferExpiryTimer);
                transferExpiryTimer = null;
            }
            store.set(pendingComposerFocusTransferAtom, current =>
                current?.targetWindowToken === windowToken ? null : current,
            );
        };

        const publishTransfer = (
            tabId: string,
            transfer: ComposerFocusTransfer,
            ttlMs: number,
        ) => {
            if (transferExpiryTimer !== null) {
                window.clearTimeout(transferExpiryTimer);
            }
            activeTransfer = { tabId, transfer };
            store.set(pendingComposerFocusTransferAtom, transfer);
            transferExpiryTimer = window.setTimeout(() => {
                if (activeTransfer?.transfer !== transfer) return;
                activeTransfer = null;
                transferExpiryTimer = null;
                store.set(pendingComposerFocusTransferAtom, current =>
                    current === transfer ? null : current,
                );
            }, ttlMs);
        };

        // A mouse/pointer press focuses the Zotero tab before its select
        // notification fires. Capture the outgoing composer synchronously on
        // pointerdown so the notification can still identify it as the focus
        // source. Keyboard/programmatic tab changes are captured directly in
        // the notification below because the composer remains active then.
        const handleTabPointerDown = (event: PointerEvent) => {
            const target = event.target as Element | null;
            const tab = target?.closest('#tab-bar-container .tab') as HTMLElement | null;
            const tabId = tab?.getAttribute('data-id');
            const activeElement = window.document.activeElement as HTMLElement | null;
            const selection = activeElement?.matches('[data-beaver-composer="true"]')
                ? captureComposerSelection(activeElement)
                : null;
            clearPointerSnapshot();
            if (tabId && selection) {
                tabPointerSnapshot = { tabId, selection };
                pointerSnapshotTimer = window.setTimeout(
                    clearPointerSnapshot,
                    POINTER_SNAPSHOT_TTL_MS,
                );
            }
        };
        const handleTabPointerUp = () => {
            if (!tabPointerSnapshot) return;
            if (pointerSnapshotTimer !== null) {
                window.clearTimeout(pointerSnapshotTimer);
            }
            // Let the click handler synchronously select the pressed tab first.
            // If no select notification follows, the snapshot belongs to a
            // completed gesture and must not be replayed by a later switch.
            pointerSnapshotTimer = window.setTimeout(clearPointerSnapshot, 0);
        };
        const handleTabPointerCancel = () => {
            clearPointerSnapshot();
        };
        window.document.addEventListener('pointerdown', handleTabPointerDown, true);
        window.document.addEventListener('pointerup', handleTabPointerUp, true);
        window.document.addEventListener('pointercancel', handleTabPointerCancel, true);

        // Set initial state
        const initialIsLibrary = window.Zotero_Tabs.selectedType === 'library';
        setIsLibraryTab(initialIsLibrary);
        setSelectedTabId(window.Zotero_Tabs.selectedID);

        // Handler for tab selection changes
        const tabObserver: { notify: _ZoteroTypes.Notifier.Notify } = {
            notify: async function(event: _ZoteroTypes.Notifier.Event, type: _ZoteroTypes.Notifier.Type, ids: string[] | number[], extraData: any) {
                if (type !== 'tab') return;
                const tabEvent = event as string;

                if (tabEvent === 'load') {
                    const tabId = String(ids[0]);
                    const pending = activeTransfer;
                    if (
                        !pending?.transfer.deferred
                        || pending.tabId !== tabId
                        || window.Zotero_Tabs.selectedID !== tabId
                        || store.get(pendingComposerFocusTransferAtom) !== pending.transfer
                    ) {
                        return;
                    }
                    publishTransfer(
                        tabId,
                        {
                            ...pending.transfer,
                            deferred: false,
                            restoreDelayMs: POST_LOAD_RESTORE_DELAY_MS,
                        },
                        TRANSFER_TTL_MS,
                    );
                    return;
                }

                if (tabEvent === 'select') {
                    const selectedTab = window.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    if (!selectedTab) return;

                    // Update isLibraryTab atom
                    const isLibrary = selectedTab.type === 'library';
                    const tabId = String(selectedTab.id);
                    logger(`useZoteroTabSelection: tab changed to ${selectedTab.type}`);
                    const activeElement = window.document.activeElement as HTMLElement | null;
                    const activeComposerSelection = activeElement?.matches('[data-beaver-composer="true"]')
                        ? captureComposerSelection(activeElement)
                        : null;
                    const pointerSelection = tabPointerSnapshot?.tabId === tabId
                        ? tabPointerSnapshot.selection
                        : null;
                    const selection = activeComposerSelection ?? pointerSelection;
                    clearPointerSnapshot();
                    clearOwnedTransfer();
                    if (selection) {
                        const deferred = selectedTab.type.endsWith('-loading');
                        publishTransfer(
                            tabId,
                            {
                                targetWindowToken: windowToken,
                                targetSurface: isLibrary ? 'library' : 'reader',
                                selection,
                                deferred,
                                restoreDelayMs: 50,
                            },
                            deferred ? LOADING_TRANSFER_TTL_MS : TRANSFER_TTL_MS,
                        );
                    }
                    setIsLibraryTab(isLibrary);
                    setSelectedTabId(selectedTab.id);

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
            clearPointerSnapshot();
            clearOwnedTransfer();
            window.document.removeEventListener('pointerdown', handleTabPointerDown, true);
            window.document.removeEventListener('pointerup', handleTabPointerUp, true);
            window.document.removeEventListener('pointercancel', handleTabPointerCancel, true);
            if (moduleTabNotifierId === myObserverId) {
                logger("useZoteroTabSelection: unregistering tab observer");
                Zotero.Notifier.unregisterObserver(myObserverId);
                moduleTabNotifierId = null;
            }
        };
    }, [setIsLibraryTab, setSelectedTabId, store, window]);
}
