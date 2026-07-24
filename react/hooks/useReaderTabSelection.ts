import { useEffect, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { readerTextSelectionAtom } from '../atoms/messageComposition';
import { clearReaderAttachmentAtom, updateReaderAttachmentAtom, addItemToCurrentMessageItemsAtom, currentMessageItemsAtom } from '../atoms/messageComposition';
import { logger } from '../../src/utils/logger';
import { addSelectionChangeListener, getCurrentReader, getSelectedTextAsTextSelection } from '../utils/readerUtils';
import { isValidAnnotationType, TextSelection } from '../types/attachments/apiTypes';
import { isAuthenticatedAtom } from "../atoms/auth";
import {
    hasAuthorizedAccessAtom,
    isDeviceAuthorizedAtom,
    isLibraryAccessReadyAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { isBeaverWindowOpenAtom, isSidebarVisibleAtom } from '../atoms/ui';
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
 * Manages the current reader attachment and text selection for the active
 * Zotero reader tab. It initializes selection state, listens for changes, and
 * handles switching between reader tabs.
 */
export function useReaderTabSelection() {
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isBeaverWindowOpen = useAtomValue(isBeaverWindowOpenAtom);
    const isBeaverVisible = isSidebarVisible || isBeaverWindowOpen;
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorized = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const isLibraryAccessReady = useAtomValue(isLibraryAccessReadyAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const searchableLibraryIdsKey = searchableLibraryIds.join(',');
    const updateReaderAttachment = useSetAtom(updateReaderAttachmentAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
    const clearReaderAttachment = useSetAtom(clearReaderAttachmentAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const getValidation = useAtomValue(getItemValidationAtom);

    // Refs to store cleanup functions, the current reader instance, and mounted state
    const selectionCleanupRef = useRef<(() => void) | null>(null);
    const currentReaderIdRef = useRef<number | null>(null);
    const currentReaderRef = useRef<ZoteroReader | null>(null);
    const readerTransitionGenerationRef = useRef(0);

    // Define main window
    const mainWindow = Zotero.getMainWindow();

    /**
     * Stop publishing the current reader context synchronously. Cleanup of
     * temporary annotations can touch the database/UI and must happen only
     * after the composer can no longer attach the reader that was just left.
     */
    const clearReaderContext = useCallback(() => {
        const readerToClean = currentReaderRef.current;
        const generation = ++readerTransitionGenerationRef.current;

        if (selectionCleanupRef.current) {
            selectionCleanupRef.current();
            selectionCleanupRef.current = null;
        }
        currentReaderIdRef.current = null;
        currentReaderRef.current = null;
        setReaderTextSelection(null);
        clearReaderAttachment();

        return { readerToClean, generation };
    }, [clearReaderAttachment, setReaderTextSelection]);

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

    // Function to set up listeners and state for a given reader
    const setupReader = useCallback(async (
        reader: any,
        transitionGeneration = readerTransitionGenerationRef.current,
    ) => {
        if (!reader) {
            logger("useReaderTabSelection:setupReader: No reader provided.");
            setReaderTextSelection(null);
            return;
        }

        // Cleanup any existing selection listener first
        if (selectionCleanupRef.current) {
            logger(`useReaderTabSelection:setupReader: Cleaning up previous selection listener for reader ${currentReaderIdRef.current}`);
            selectionCleanupRef.current();
            selectionCleanupRef.current = null;
        }

        currentReaderIdRef.current = reader.itemID; // Store just the ID
        currentReaderRef.current = reader;
        logger(`useReaderTabSelection:setupReader: Setting up for reader ${reader.itemID}`);

        // Update reader attachment for the new reader
        try {
            await updateReaderAttachment(reader);
        } catch (error) {
            logger(`useReaderTabSelection:setupReader: Failed to update reader attachment for ${reader.itemID}: ${error instanceof Error ? error.message : String(error)}`);
        }

        const activeReader = getCurrentReader(mainWindow);
        if (
            transitionGeneration !== readerTransitionGenerationRef.current ||
            activeReader?.itemID !== reader.itemID
        ) {
            logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is no longer active after attachment lookup. Skipping setup.`);
            return;
        }

        // Wait for the reader to be ready before setting initial selection and listener
        waitForInternalReader(reader, async () => {
            // Check if the reader context is still the same after waiting
            if (
                transitionGeneration !== readerTransitionGenerationRef.current ||
                currentReaderIdRef.current !== reader.itemID
            ) {
                logger(`useReaderTabSelection:setupReader: Reader changed after waitForInternalReader for ${reader.itemID}. Skipping setup.`);
                return;
            }

            // Get current selection and update state
            const initialSelection = getSelectedTextAsTextSelection(reader);
            logger(`useReaderTabSelection:setupReader: Initial selection for reader ${reader.itemID}: ${initialSelection?.text ? '"' + initialSelection.text + '"' : 'null'}`);
            // Ensure the reader item is valid
            const item = await Zotero.Items.getAsync(reader.itemID);
            if (item) {
                const validation = getValidation(item);
                if (isRejectedItemValidation(item, validation)) {
                    logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is rejected. Skipping setup.`);
                    setReaderTextSelection(null);
                    return;
                }
            }
            if (
                transitionGeneration !== readerTransitionGenerationRef.current ||
                currentReaderIdRef.current !== reader.itemID ||
                getCurrentReader(mainWindow)?.itemID !== reader.itemID
            ) {
                logger(`useReaderTabSelection:setupReader: Reader changed while loading selection state for ${reader.itemID}. Skipping setup.`);
                return;
            }
            // Set the initial selection
            setReaderTextSelection(initialSelection);

            // Add new selection listener with initiallyHasSelection parameter based on initial selection
            logger(`useReaderTabSelection:setupReader: Adding selection listener for reader ${reader.itemID}`);
            selectionCleanupRef.current = addSelectionChangeListener(
                reader, 
                async (newSelection: TextSelection | null) => {
                    // Ensure the event is for the currently active reader this hook manages
                    if (
                        transitionGeneration === readerTransitionGenerationRef.current &&
                        currentReaderIdRef.current === reader.itemID
                    ) {
                        logger(`useReaderTabSelection: Selection changed in reader ${reader.itemID}, updating selection to "${newSelection ? newSelection.text : 'null'}"`);
                        // Ensure the reader item is valid
                        const item = await Zotero.Items.getAsync(reader.itemID);
                        if (item) {
                            const validation = getValidation(item);
                            if (isRejectedItemValidation(item, validation)) {
                                logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is rejected. Skipping setup.`);
                                return;
                            }
                        }
                        if (
                            transitionGeneration !== readerTransitionGenerationRef.current ||
                            currentReaderIdRef.current !== reader.itemID ||
                            getCurrentReader(mainWindow)?.itemID !== reader.itemID
                        ) return;
                        // Set the new selection
                        setReaderTextSelection(newSelection);
                    } else {
                         logger(`useReaderTabSelection: Stale selection event received for reader ${reader.itemID}. Current reader ID is ${currentReaderIdRef.current}. Ignoring.`);
                    }
                }
            );
        });

    }, [mainWindow, setReaderTextSelection, updateReaderAttachment, waitForInternalReader]); // Dependencies


    useEffect(() => {
        if (!isBeaverVisible) return;
        if (!isAuthenticated || !hasAuthorized || !isDeviceAuthorized || !isLibraryAccessReady) return;
        logger("useReaderTabSelection: Hook mounted");

        let isMounted = true;

        // Initial setup: Get the current reader and set it up
        const initializeReader = async () => {
            const initialReader = getCurrentReader(mainWindow);
            if (initialReader) {
                logger(`useReaderTabSelection: Initial reader detected (itemID: ${initialReader.itemID})`);
                if (isMounted) await setupReader(initialReader);
            } else {
                // The active tab is not a reader (library or note tab) — make sure
                // no stale reader context is left attached to the composer.
                logger("useReaderTabSelection: No active reader on mount.");
                if (isMounted) {
                    clearReaderContext();
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
                        const newReader = Zotero.Reader.getByTabID(selectedTab.id);
                        if (newReader && newReader.itemID !== currentReaderIdRef.current) {
                            logger(`useReaderTabSelection: Tab changed to a different reader (itemID: ${newReader.itemID}). Cleaning up temporary annotations and setting up new reader.`);

                            // Invalidate the previous reader immediately so item
                            // notifications and composer state cannot use it while
                            // annotation cleanup is still in progress.
                            const { readerToClean, generation } = clearReaderContext();

                            // Clean up temporary annotations from the previous reader
                            await BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader);

                            const activeReader = getCurrentReader(mainWindow);
                            if (
                                !isMounted ||
                                generation !== readerTransitionGenerationRef.current ||
                                activeReader?.itemID !== newReader.itemID
                            ) return;
                            await setupReader(newReader, generation);
                        } else if (!newReader) {
                            logger("useReaderTabSelection: Tab changed to reader, but could not get reader instance.");
                            // If we somehow switch to a reader tab but can't get the instance, clear state
                            const { readerToClean } = clearReaderContext();
                            await BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader);
                        }
                        // If newReader is the same as current, do nothing - already handled
                    } else {
                        // Tab switched to something other than a reader (e.g., library)
                        logger(`useReaderTabSelection: Tab changed to ${selectedTab.type}. Cleaning up reader state and temporary annotations.`);

                        // Clear all reader-derived context before cleanup yields.
                        const { readerToClean } = clearReaderContext();

                        // Clean up temporary annotations when leaving reader tabs
                        await BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader);
                    }
                }
                // Annotation events
                if (type === 'item') {
                    // Add events
                    if (event === 'add') {
                        try {
                            const item = Zotero.Items.get(ids[0]);
                            if(!item.isAnnotation() || !isValidAnnotationType(item.annotationType)) return;
                            const activeReader = getCurrentReader(mainWindow);
                            if (
                                !activeReader ||
                                activeReader.itemID !== currentReaderIdRef.current ||
                                item.parentItemID !== activeReader.itemID
                            ) return;
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
            const { readerToClean } = clearReaderContext();
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
    }, [setupReader, clearReaderContext, mainWindow, isBeaverVisible, isAuthenticated, isDeviceAuthorized, hasAuthorized, isLibraryAccessReady, searchableLibraryIdsKey]);

}
