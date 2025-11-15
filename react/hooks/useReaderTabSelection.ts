import { useEffect, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { readerTextSelectionAtom } from '../atoms/messageComposition';
import { currentReaderAttachmentAtom, updateReaderAttachmentAtom, addItemToCurrentMessageItemsAtom, currentMessageItemsAtom } from '../atoms/messageComposition';
import { logger } from '../../src/utils/logger';
import { addSelectionChangeListener, getCurrentReader, getSelectedTextAsTextSelection } from '../utils/readerUtils';
import { isValidAnnotationType, TextSelection } from '../types/attachments/apiTypes';
import { isAuthenticatedAtom } from "../atoms/auth";
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom } from '../atoms/profile';
import { BEAVER_ANNOTATION_TEXT } from '../components/sources/ZoteroCitation';
import { BeaverTemporaryAnnotations, ZoteroReader } from '../utils/annotationUtils';
import { store } from '../store';
import { threadProposedActionsAtom } from '../atoms/proposedActions';
import { getZoteroItemReferenceFromProposedAction } from '../types/chat/proposedActions';
import { getItemValidationAtom } from '../atoms/itemValidation';

/**
 * Manages text selection listening for the currently active Zotero reader tab.
 * This hook should only be mounted when the reader sidebar is visible.
 * It initializes selection state, listens for changes, and handles switching
 * between reader tabs.
 */
export function useReaderTabSelection() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorized = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const updateReaderAttachment = useSetAtom(updateReaderAttachmentAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
    const setReaderAttachment = useSetAtom(currentReaderAttachmentAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const getValidation = useAtomValue(getItemValidationAtom);

    // Refs to store cleanup functions, the current reader instance, and mounted state
    const selectionCleanupRef = useRef<(() => void) | null>(null);
    const zoteroNotifierIdRef = useRef<string | null>(null);
    const currentReaderIdRef = useRef<number | null>(null);
    const currentReaderRef = useRef<ZoteroReader | null>(null);

    // Define main window
    const window = Zotero.getMainWindow();

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
    const setupReader = useCallback(async (reader: any) => {
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
            if (item) {
                const validation = getValidation(item);
                if (validation && !validation.isValid) {
                    logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is invalid. Skipping setup.`);
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
                        if (item) {
                            const validation = getValidation(item);
                            if (validation && !validation.isValid) {
                                logger(`useReaderTabSelection:setupReader: Reader ${reader.itemID} is invalid. Skipping setup.`);
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

    }, [setReaderTextSelection, updateReaderAttachment, waitForInternalReader]); // Dependencies


    useEffect(() => {
        if (!isAuthenticated || !hasAuthorized || !isDeviceAuthorized) return;
        logger("useReaderTabSelection: Hook mounted");

        // Initial setup: Get the current reader and set it up
        const initializeReader = async () => {
            const initialReader = getCurrentReader(window);
            if (initialReader) {
                logger(`useReaderTabSelection: Initial reader detected (itemID: ${initialReader.itemID})`);
                await setupReader(initialReader);
            } else {
                logger("useReaderTabSelection: No active reader on mount.");
                setReaderTextSelection(null); // Ensure selection is null if no reader
            }
        };
        initializeReader().catch(error => {
            logger(`useReaderTabSelection: Error during initial reader setup: ${error instanceof Error ? error.message : String(error)}`);
        });

        // Set up tab change listener
        const readerObserver: { notify: _ZoteroTypes.Notifier.Notify } = {
            notify: async function(event: _ZoteroTypes.Notifier.Event, type: _ZoteroTypes.Notifier.Type, ids: string[] | number[], extraData: any) {
                // Tab change event
                if (type === 'tab' && event === 'select') {
                    const selectedTab = window.Zotero_Tabs._tabs.find(tab => tab.id === ids[0]);
                    if (!selectedTab) return;

                    if (selectedTab.type === 'reader') {
                        const newReader = Zotero.Reader.getByTabID(selectedTab.id);
                        if (newReader && newReader.itemID !== currentReaderIdRef.current) {
                            logger(`useReaderTabSelection: Tab changed to a different reader (itemID: ${newReader.itemID}). Cleaning up temporary annotations and setting up new reader.`);
                            
                            // Clean up temporary annotations from the previous reader
                            await BeaverTemporaryAnnotations.cleanupAll(currentReaderRef.current as ZoteroReader);
                            
                            await setupReader(newReader);
                        } else if (!newReader) {
                            logger("useReaderTabSelection: Tab changed to reader, but could not get reader instance.");
                            // If we somehow switch to a reader tab but can't get the instance, clear state
                            if (selectionCleanupRef.current) selectionCleanupRef.current();
                            selectionCleanupRef.current = null;
                            currentReaderIdRef.current = null;
                            currentReaderRef.current = null;
                            setReaderTextSelection(null);
                        }
                        // If newReader is the same as current, do nothing - already handled
                    } else {
                        // Tab switched to something other than a reader (e.g., library)
                        logger(`useReaderTabSelection: Tab changed to ${selectedTab.type}. Cleaning up reader state and temporary annotations.`);
                        
                        // Clean up temporary annotations when leaving reader tabs
                        await BeaverTemporaryAnnotations.cleanupAll(currentReaderRef.current as ZoteroReader);
                        
                        if (selectionCleanupRef.current) {
                            selectionCleanupRef.current();
                            selectionCleanupRef.current = null;
                        }
                        currentReaderIdRef.current = null;
                        currentReaderRef.current = null;
                        setReaderTextSelection(null);
                        await updateReaderAttachment();
                    }
                }
                // Annotation events
                if (type === 'item') {
                    // Add events
                    if (event === 'add') {
                        const item = Zotero.Items.get(ids[0]);
                        if(!item.isAnnotation() || !isValidAnnotationType(item.annotationType)) return;
                        // Check if this annotation was created by a proposed action
                        const proposedActions = store.get(threadProposedActionsAtom);
                        const isFromProposedAction = proposedActions.some((action) => 
                            getZoteroItemReferenceFromProposedAction(action)?.zotero_key === item.key &&
                            getZoteroItemReferenceFromProposedAction(action)?.library_id === item.libraryID
                        );
                        if (isFromProposedAction) return;
                        if(item.annotationText === BEAVER_ANNOTATION_TEXT) return;
                        await addItemToCurrentMessageItems(item);
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

        logger("useReaderTabSelection: Registering tab selection observer");
        
        zoteroNotifierIdRef.current = Zotero.Notifier.registerObserver(readerObserver, ['tab', 'item'], 'beaver-readerSidebarTabObserver');

        // Cleanup function on unmount
        return () => {
            logger("useReaderTabSelection: Hook unmounting. Cleaning up listeners and observer.");
            // Clear reader item key
            setReaderAttachment(null);
            // Cleanup selection event listner
            if (selectionCleanupRef.current) {
                logger("useReaderTabSelection: Removing selection listener.");
                selectionCleanupRef.current();
                selectionCleanupRef.current = null;
            }
            if (zoteroNotifierIdRef.current) {
                logger("useReaderTabSelection: Unregistering tab observer.");
                try {
                    Zotero.Notifier.unregisterObserver(zoteroNotifierIdRef.current);
                } catch (e) {
                    logger(`useReaderTabSelection: Error during unregisterObserver: ${e}`);
                }
                zoteroNotifierIdRef.current = null;
            }
            
            // Stash reader instance before clearing refs
            const readerToClean = currentReaderRef.current;

            currentReaderIdRef.current = null;
            currentReaderRef.current = null;
            // Reset atom state on unmount
            setReaderTextSelection(null);
            
            // Clean up any remaining temporary annotations on unmount
            BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader).catch(error => {
                logger(`useReaderTabSelection: Error cleaning up temporary annotations on unmount: ${error}`);
            });
        };
    }, [setupReader, setReaderTextSelection, updateReaderAttachment, setReaderAttachment, window, waitForInternalReader, isAuthenticated, isDeviceAuthorized, hasAuthorized]);

}
