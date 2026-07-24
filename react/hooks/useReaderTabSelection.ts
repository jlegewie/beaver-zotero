import { useEffect, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { readerTextSelectionAtom } from '../atoms/messageComposition';
import { currentReaderAttachmentAtom, updateReaderAttachmentAtom, clearReaderAttachmentAtom, isReaderLibrarySearchable, addItemToCurrentMessageItemsAtom, currentMessageItemsAtom } from '../atoms/messageComposition';
import { logger } from '../../src/utils/logger';
import { addSelectionChangeListener, getCurrentReader, getSelectedTextAsTextSelection } from '../utils/readerUtils';
import { isValidAnnotationType, TextSelection } from '../types/attachments/apiTypes';
import { isAuthenticatedAtom } from "../atoms/auth";
import { isBeaverUIVisibleAtom } from '../atoms/ui';
import {
    hasAuthorizedAccessAtom,
    isDeviceAuthorizedAtom,
    isLibraryAccessReadyAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { BeaverTemporaryAnnotations, ZoteroReader } from '../utils/annotationUtils';
import { store } from '../store';
import { threadAgentActionsAtom, getZoteroItemReferenceFromAgentAction, hasAppliedBulkAnnotations, AgentAction } from '../agents/agentActions';
import { BEAVER_CITATION_ANNOTATION_AUTHOR, isBeaverAuthoredAnnotation } from '../../src/constants/annotations';
import { getItemValidationAtom, isRejectedItemValidation } from '../atoms/itemValidation';
import type { CreatedAnnotationResult } from '../types/agentActions/createAnnotations';

/**
 * Module-level variable to track the Zotero notifier observer ID.
 * This persists across hot-reloads to ensure proper cleanup.
 */
let moduleReaderTabNotifierId: string | null = null;

/**
 * Resolve the reader instance for a freshly selected tab.
 *
 * Opening an attachment adds and selects its tab from the `ReaderTab`
 * constructor, so the `select` notification can reach observers before Zotero
 * registers the instance. Poll briefly instead of treating that as "no reader",
 * and stop as soon as the tab is no longer the selected one.
 */
async function waitForReaderByTabID(tabID: string, timeoutMs = 2000): Promise<any | undefined> {
    const mainWindow = Zotero.getMainWindow();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const reader = Zotero.Reader.getByTabID(tabID);
        if (reader) return reader;
        if (Date.now() >= deadline) return undefined;
        if (mainWindow?.Zotero_Tabs?.selectedID !== tabID) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/**
 * Tracks the currently active Zotero reader tab: the open attachment
 * (`currentReaderAttachmentAtom`), its text selection
 * (`readerTextSelectionAtom`), and newly created annotations.
 *
 * Mounted once globally (`GlobalContextInitializer`) and active whenever a
 * Beaver chat surface is open — the main-window sidebar OR the separate Beaver
 * window. Both share one store, so this must not be tied to either surface's
 * own mount; window-only users would otherwise get no reader context at all
 * (no current attachment, no page number in `application_state`, no selection).
 */
export function useReaderTabSelection() {
    const isBeaverUIVisible = useAtomValue(isBeaverUIVisibleAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorized = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const isLibraryAccessReady = useAtomValue(isLibraryAccessReadyAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const searchableLibraryIdsKey = searchableLibraryIds.join(',');
    const updateReaderAttachment = useSetAtom(updateReaderAttachmentAtom);
    const clearReaderAttachment = useSetAtom(clearReaderAttachmentAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const getValidation = useAtomValue(getItemValidationAtom);

    // Refs to store cleanup functions, the current reader instance, and mounted state
    const selectionCleanupRef = useRef<(() => void) | null>(null);
    const currentReaderIdRef = useRef<number | null>(null);
    const currentReaderRef = useRef<ZoteroReader | null>(null);

    // Define main window
    const mainWindow = Zotero.getMainWindow();

    // Function to poll for reader._internalReader readiness
    const waitForInternalReader = useCallback((reader: any, callback: () => void, maxTime = 2000) => {
        if (!reader) {
            logger("useReaderTabSelection:waitForInternalReader: No reader provided.");
            return;
        }
        const startTime = Date.now();
        const checkInterval = 100; // Check every 100ms

        const poll = () => {
            // Reader might have become invalid (e.g., tab closed) during polling
            if (currentReaderIdRef.current !== reader.itemID) {
                 logger("useReaderTabSelection:waitForInternalReader: Reader changed during polling. Aborting.");
                 return;
            }
            // Check if reader is ready
            if (reader._internalReader && reader._internalReader._primaryView && reader._internalReader._primaryView._iframeWindow) {
                logger(`useReaderTabSelection:waitForInternalReader: reader for item ${reader.itemID} is ready.`);
                callback();
                return;
            }

            // Check if we've exceeded the maximum wait time
            if (Date.now() - startTime >= maxTime) {
                logger(`useReaderTabSelection:waitForInternalReader: timed out waiting for reader ${reader.itemID}._internalReader. Attempting callback anyway.`);
                // Try anyway as a fallback
                callback();
                return;
            }

            // Continue polling
            setTimeout(poll, checkInterval);
        };

        logger(`useReaderTabSelection:waitForInternalReader: Polling for reader ${reader.itemID} readiness...`);
        poll();
    }, []);

    /**
     * Stop tracking the active reader: drop its selection listener, the staged
     * selection, and the active-reader refs. Returns the reader that was
     * active so callers can run slower cleanup (temporary annotations) after
     * tracking has already stopped.
     *
     * Clearing the refs synchronously matters: the annotation observer treats
     * `currentReaderIdRef` as "the reader the user is in", so anything created
     * while a transition is still awaiting must no longer match.
     */
    const detachActiveReader = useCallback((): ZoteroReader | null => {
        if (selectionCleanupRef.current) {
            logger(`useReaderTabSelection: Removing selection listener for reader ${currentReaderIdRef.current}`);
            selectionCleanupRef.current();
            selectionCleanupRef.current = null;
        }
        const previousReader = currentReaderRef.current;
        currentReaderIdRef.current = null;
        currentReaderRef.current = null;
        setReaderTextSelection(null);
        return previousReader;
    }, [setReaderTextSelection]);

    /**
     * Start tracking `reader`.
     *
     * `isCurrent` reports whether the transition that requested this setup is
     * still the newest one. Tab selections overlap (see the observer below), so
     * a setup whose transition has been superseded must not write state the
     * winning transition already owns.
     */
    const setupReader = useCallback(async (reader: any, isCurrent: () => boolean = () => true) => {
        if (!reader) {
            logger("useReaderTabSelection:setupReader: No reader provided.");
            detachActiveReader();
            return;
        }

        // Libraries the user excluded from Beaver are never tracked: no
        // attachment, no selection listener, and no active-reader id — the
        // annotation observer keys off that id, so leaving it set would let
        // excluded-library annotations into the draft message.
        if (!isReaderLibrarySearchable(store.get(searchableLibraryIdsAtom), reader)) {
            logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is in an excluded library. Not tracking.`);
            detachActiveReader();
            clearReaderAttachment();
            return;
        }

        detachActiveReader();

        currentReaderIdRef.current = reader.itemID; // Store just the ID
        currentReaderRef.current = reader;
        logger(`useReaderTabSelection:setupReader: Setting up for reader ${reader.itemID}`);

        // Update reader attachment for the new reader
        try {
            await updateReaderAttachment(reader);
        } catch (error) {
            logger(`useReaderTabSelection:setupReader: Failed to update reader attachment for ${reader.itemID}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // A newer tab transition took over while the item was loading; it owns
        // the reader context now.
        if (!isCurrent()) {
            logger(`useReaderTabSelection:setupReader: Setup for reader ${reader.itemID} was superseded. Skipping.`);
            return;
        }

        // Nothing to track without an attachment (e.g. the item could not be
        // loaded); make sure no reader is left marked active.
        if (!store.get(currentReaderAttachmentAtom)) {
            logger(`useReaderTabSelection:setupReader: No trackable attachment for reader ${reader.itemID}. Skipping selection setup.`);
            if (currentReaderIdRef.current === reader.itemID) detachActiveReader();
            return;
        }

        // Wait for the reader to be ready before setting initial selection and listener
        waitForInternalReader(reader, async () => {
            // Check if the reader context is still the same after waiting
            if (currentReaderIdRef.current !== reader.itemID) {
                logger(`useReaderTabSelection:setupReader: Reader changed after waitForInternalReader for ${reader.itemID}. Skipping setup.`);
                return;
            }

            // Get current selection and update state
            const initialSelection = getSelectedTextAsTextSelection(reader);
            logger(`useReaderTabSelection:setupReader: Initial selection for reader ${reader.itemID}: ${initialSelection?.text ? '"' + initialSelection.text + '"' : 'null'}`);
            // Ensure the reader item is valid
            const item = await Zotero.Items.getAsync(reader.itemID);
            // Tracking can stop while the item loads (tab switched, Beaver
            // closed). Re-check before touching state: a listener installed
            // after teardown would never be removed, and the selection would
            // belong to a reader the user already left.
            if (currentReaderIdRef.current !== reader.itemID) {
                logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} no longer active after item load. Skipping setup.`);
                return;
            }
            if (item) {
                const validation = getValidation(item);
                if (isRejectedItemValidation(item, validation)) {
                    logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is rejected. Skipping setup.`);
                    setReaderTextSelection(null);
                    return;
                }
            }
            // Set the initial selection
            setReaderTextSelection(initialSelection);

            // Add new selection listener with initiallyHasSelection parameter based on initial selection
            logger(`useReaderTabSelection:setupReader: Adding selection listener for reader ${reader.itemID}`);
            selectionCleanupRef.current = addSelectionChangeListener(
                reader, 
                async (newSelection: TextSelection | null) => {
                    // Ensure the event is for the currently active reader this hook manages
                    if (currentReaderIdRef.current === reader.itemID) {
                        logger(`useReaderTabSelection: Selection changed in reader ${reader.itemID}, updating selection to "${newSelection ? newSelection.text : 'null'}"`);
                        // Ensure the reader item is valid
                        const item = await Zotero.Items.getAsync(reader.itemID);
                        // Re-check: tracking can stop while the item loads
                        if (currentReaderIdRef.current !== reader.itemID) {
                            logger(`useReaderTabSelection: Reader ${reader.itemID} no longer active after item load. Dropping selection.`);
                            return;
                        }
                        if (item) {
                            const validation = getValidation(item);
                            if (isRejectedItemValidation(item, validation)) {
                                logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is rejected. Skipping setup.`);
                                return;
                            }
                        }
                        // Set the new selection
                        setReaderTextSelection(newSelection);
                    } else {
                         logger(`useReaderTabSelection: Stale selection event received for reader ${reader.itemID}. Current reader ID is ${currentReaderIdRef.current}. Ignoring.`);
                    }
                }
            );
        });

    }, [detachActiveReader, clearReaderAttachment, setReaderTextSelection, updateReaderAttachment, waitForInternalReader]); // Dependencies


    useEffect(() => {
        // Inert while no Beaver surface is open. Re-running the effect with the
        // gate closed first runs the previous run's cleanup, which clears the
        // reader atoms and unregisters the observers.
        if (!isBeaverUIVisible) return;
        if (!isAuthenticated || !hasAuthorized || !isDeviceAuthorized || !isLibraryAccessReady) return;
        logger("useReaderTabSelection: Hook mounted");

        let isMounted = true;

        // Serializes overlapping tab transitions. Zotero dispatches tab
        // notifications without awaiting observers, so rapid A → B → C
        // selections interleave at every await: a superseded callback must not
        // resume and clear or replace the context of the tab that won.
        let tabTransitionGeneration = 0;

        // Initial setup: Get the current reader and set it up
        const initializeReader = async () => {
            const transition = ++tabTransitionGeneration;
            const initialReader = getCurrentReader(mainWindow);
            if (initialReader) {
                logger(`useReaderTabSelection: Initial reader detected (itemID: ${initialReader.itemID})`);
                if (isMounted) {
                    await setupReader(initialReader, () => transition === tabTransitionGeneration);
                }
            } else {
                logger("useReaderTabSelection: No active reader on mount.");
                // No reader means no reader context at all — including any
                // attachment left over from the last time tracking ran.
                if (isMounted) {
                    detachActiveReader();
                    clearReaderAttachment();
                }
            }
        };
        initializeReader().catch(error => {
            logger(`useReaderTabSelection: Error during initial reader setup: ${error instanceof Error ? error.message : String(error)}`);
        });

        // Set up tab change listener
        const readerObserver: { notify: _ZoteroTypes.Notifier.Notify } = {
            notify: async function(event: _ZoteroTypes.Notifier.Event, type: _ZoteroTypes.Notifier.Type, ids: string[] | number[], extraData: any) {
                if (!isMounted) return;

                // Tab change event
                if (type === 'tab' && event === 'select') {
                    const selectedTab = mainWindow.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    if (!selectedTab) return;

                    if (selectedTab.type === 'reader') {
                        // Re-selecting the reader already being tracked is a
                        // no-op — keep its listener and staged selection.
                        const activeReader = Zotero.Reader.getByTabID(selectedTab.id);
                        if (activeReader && activeReader.itemID === currentReaderIdRef.current) return;

                        const transition = ++tabTransitionGeneration;

                        // Drop the previous reader's context BEFORE any await:
                        // resolving the new reader instance can poll for
                        // seconds. The annotation observer keys off the refs, so
                        // anything created meanwhile belongs to a reader the
                        // user has left; and a leftover attachment would be
                        // reported alongside the NEW reader's page and content
                        // kind, which read straight from the open reader.
                        const previousReader = detachActiveReader();
                        clearReaderAttachment();

                        await BeaverTemporaryAnnotations.cleanupAll(previousReader as ZoteroReader);
                        if (!isMounted || transition !== tabTransitionGeneration) return;

                        const newReader = await waitForReaderByTabID(selectedTab.id);
                        if (!isMounted || transition !== tabTransitionGeneration) return;
                        if (newReader) {
                            logger(`useReaderTabSelection: Tab changed to a different reader (itemID: ${newReader.itemID}). Setting up new reader.`);
                            await setupReader(newReader, () => transition === tabTransitionGeneration);
                        } else {
                            logger("useReaderTabSelection: Tab changed to reader, but could not get reader instance.");
                            // Nothing to report on a reader tab whose reader
                            // cannot be resolved; the context was already
                            // cleared above.
                        }
                    } else {
                        // Tab switched to something other than a reader (e.g., library)
                        logger(`useReaderTabSelection: Tab changed to ${selectedTab.type}. Cleaning up reader state and temporary annotations.`);

                        // Also takes a transition token, so a reader transition
                        // still in flight cannot set up a reader after the user
                        // has moved to a library or note tab.
                        ++tabTransitionGeneration;
                        const previousReader = detachActiveReader();
                        clearReaderAttachment();

                        await BeaverTemporaryAnnotations.cleanupAll(previousReader as ZoteroReader);
                    }
                }
                // Annotation events
                if (type === 'item') {
                    // Add events
                    if (event === 'add') {
                        // Only annotations made in the reader the user is
                        // currently in become message context. This observer is
                        // registered globally, so annotations arriving on a
                        // library/note tab — or from sync, or from a background
                        // reader tab — must not touch the draft message.
                        const activeReaderItemID = currentReaderIdRef.current;
                        if (activeReaderItemID === null) return;
                        try {
                            const item = Zotero.Items.get(ids[0]);
                            if(!item.isAnnotation() || !isValidAnnotationType(item.annotationType)) return;
                            if (item.parentID !== activeReaderItemID) return;
                            if (isBeaverAuthoredAnnotation(item.annotationAuthorName)) return;
                            if (item.annotationText === BEAVER_CITATION_ANNOTATION_AUTHOR) return;
                            // Check if this annotation was created by an agent action
                            const agentActions = store.get(threadAgentActionsAtom);
                            const isFromAgentAction = agentActions.some((action: AgentAction) => {
                                const ref = getZoteroItemReferenceFromAgentAction(action);
                                if (ref?.zotero_key === item.key && ref?.library_id === item.libraryID) return true;
                                if (hasAppliedBulkAnnotations(action)) {
                                    return action.result_data!.created.some(
                                        (created: CreatedAnnotationResult) => created.zotero_key === item.key && created.library_id === item.libraryID,
                                    );
                                }
                                return false;
                            });
                            if (isFromAgentAction) return;
                            await addItemToCurrentMessageItems(item);
                        } catch (e) {
                            logger(`useReaderTabSelection: Item not loaded for ID ${ids[0]}: ${e}`);
                            return;
                        }
                    }
                    // Delete events
                    if (event === 'delete') {
                        ids.forEach(id => {
                            if (extraData && extraData[id]) {
                                const { libraryID, key } = extraData[id];
                                if (libraryID && key) {
                                    setCurrentMessageItems((prev) =>
                                        prev.filter((i) => !(i.libraryID === libraryID && i.key === key)
                                    ));
                                }
                            }
                        });
                    }
                }
            }
        };

        // Unregister any existing observer before registering a new one
        // This handles hot-reload scenarios where cleanup may not have run
        if (moduleReaderTabNotifierId) {
            try {
                Zotero.Notifier.unregisterObserver(moduleReaderTabNotifierId);
                logger("useReaderTabSelection: Unregistered stale observer before re-registering", 4);
            } catch (e) {
                // Ignore errors if observer was already unregistered
            }
            moduleReaderTabNotifierId = null;
        }

        logger("useReaderTabSelection: Registering tab selection observer");
        
        const myObserverId = Zotero.Notifier.registerObserver(readerObserver, ['tab', 'item'], 'beaver-readerSidebarTabObserver');
        moduleReaderTabNotifierId = myObserverId;

        // Cleanup function on unmount
        return () => {
            isMounted = false;
            logger("useReaderTabSelection: Hook unmounting. Cleaning up listeners and observer.");

            // Stop tracking first, then clear the attachment through the atom
            // that also cancels an in-flight update — writing null directly
            // would let a pending item lookup repopulate it after teardown.
            const readerToClean = detachActiveReader();
            clearReaderAttachment();

            if (moduleReaderTabNotifierId && moduleReaderTabNotifierId === myObserverId) {
                logger("useReaderTabSelection: Unregistering tab observer.");
                try {
                    Zotero.Notifier.unregisterObserver(myObserverId);
                } catch (e) {
                    logger(`useReaderTabSelection: Error during unregisterObserver: ${e}`);
                }
                moduleReaderTabNotifierId = null;
            }

            // Clean up any remaining temporary annotations on unmount
            BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader).catch(error => {
                logger(`useReaderTabSelection: Error cleaning up temporary annotations on unmount: ${error}`);
            });
        };
    }, [setupReader, detachActiveReader, setReaderTextSelection, updateReaderAttachment, clearReaderAttachment, mainWindow, waitForInternalReader, isBeaverUIVisible, isAuthenticated, isDeviceAuthorized, hasAuthorized, isLibraryAccessReady, searchableLibraryIdsKey]);

}
