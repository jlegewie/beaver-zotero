import { useEffect, useRef, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { readerTextSelectionAtom, currentReaderAttachmentAtom, updateReaderAttachmentAtom, updateSourcesFromZoteroItemsAtom, currentSourcesAtom } from '../atoms/input';
import { logger } from '../../src/utils/logger';
import { addSelectionChangeListener, getCurrentReader, getSelectedTextAsTextSelection } from '../utils/readerUtils';
import { toAnnotation } from '../types/attachments/converters';
import { TextSelection } from '../types/attachments/apiTypes';

const VALID_ANNOTATION_TYPES = ["highlight", "underline", "note", "image"];

/**
 * Manages text selection listening for the currently active Zotero reader tab.
 * This hook should only be mounted when the reader sidebar is visible.
 * It initializes selection state, listens for changes, and handles switching
 * between reader tabs.
 */
export function useReaderTabSelection() {
    const updateReaderAttachment = useSetAtom(updateReaderAttachmentAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
    const setReaderAttachment = useSetAtom(currentReaderAttachmentAtom);
    const setCurrentSourcesAtom = useSetAtom(currentSourcesAtom);
    const updateSourcesFromZoteroItems = useSetAtom(updateSourcesFromZoteroItemsAtom);

    // Refs to store cleanup functions, the current reader instance, and mounted state
    const selectionCleanupRef = useRef<(() => void) | null>(null);
    const zoteroNotifierIdRef = useRef<string | null>(null);
    const currentReaderIdRef = useRef<number | null>(null);

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
    const setupReader = useCallback((reader: any) => {
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
        logger(`useReaderTabSelection:setupReader: Setting up for reader ${reader.itemID}`);

        // Update reader attachment for the new reader
        updateReaderAttachment(reader);

        // Wait for the reader to be ready before setting initial selection and listener
        waitForInternalReader(reader, () => {
            // Check if the reader context is still the same after waiting
            if (currentReaderIdRef.current !== reader.itemID) {
                logger(`useReaderTabSelection:setupReader: Reader changed after waitForInternalReader for ${reader.itemID}. Skipping setup.`);
                return;
            }

            // Get current selection and update state
            const initialSelection = getSelectedTextAsTextSelection(reader);
            logger(`useReaderTabSelection:setupReader: Initial selection for reader ${reader.itemID}: ${initialSelection?.text ? '"' + initialSelection.text + '"' : 'null'}`);
            setReaderTextSelection(initialSelection);

            // Add new selection listener with initiallyHasSelection parameter based on initial selection
            logger(`useReaderTabSelection:setupReader: Adding selection listener for reader ${reader.itemID}`);
            selectionCleanupRef.current = addSelectionChangeListener(
                reader, 
                (newSelection: TextSelection | null) => {
                    // Ensure the event is for the currently active reader this hook manages
                    if (currentReaderIdRef.current === reader.itemID) {
                        logger(`useReaderTabSelection: Selection changed in reader ${reader.itemID}, updating selection to "${newSelection ? newSelection.text : 'null'}"`);
                        setReaderTextSelection(newSelection);
                    } else {
                         logger(`useReaderTabSelection: Stale selection event received for reader ${reader.itemID}. Current reader ID is ${currentReaderIdRef.current}. Ignoring.`);
                    }
                }
            );
        });

    }, [setReaderTextSelection, updateReaderAttachment, waitForInternalReader]); // Dependencies


    useEffect(() => {
        logger("useReaderTabSelection: Hook mounted");

        // Initial setup: Get the current reader and set it up
        const initialReader = getCurrentReader(window);
        if (initialReader) {
            logger(`useReaderTabSelection: Initial reader detected (itemID: ${initialReader.itemID})`);
            setupReader(initialReader);
        } else {
             logger("useReaderTabSelection: No active reader on mount.");
             setReaderTextSelection(null); // Ensure selection is null if no reader
        }

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
                            logger(`useReaderTabSelection: Tab changed to a different reader (itemID: ${newReader.itemID}). Setting up new reader.`);
                            setupReader(newReader);
                        } else if (!newReader) {
                            logger("useReaderTabSelection: Tab changed to reader, but could not get reader instance.");
                            // If we somehow switch to a reader tab but can't get the instance, clear state
                            if (selectionCleanupRef.current) selectionCleanupRef.current();
                            selectionCleanupRef.current = null;
                            currentReaderIdRef.current = null;
                            setReaderTextSelection(null);
                        }
                        // If newReader is the same as current, do nothing - already handled
                    } else {
                        // Tab switched to something other than a reader (e.g., library)
                        logger(`useReaderTabSelection: Tab changed to ${selectedTab.type}. Cleaning up reader state.`);
                        if (selectionCleanupRef.current) {
                            selectionCleanupRef.current();
                            selectionCleanupRef.current = null;
                        }
                        currentReaderIdRef.current = null;
                        setReaderTextSelection(null);
                        setReaderAttachment(null);
                    }
                }
                // Annotation events
                if (type === 'item') {
                    // Add events
                    if (event === 'add') {
                        const item = Zotero.Items.get(ids[0]);
                        if(!item.isAnnotation() || !VALID_ANNOTATION_TYPES.includes(item.annotationType)) return;
                        await updateSourcesFromZoteroItems([item], true);
                    }
                    // Delete events
                    if (event === 'delete') {
                        ids.forEach(id => {
                            if (extraData && extraData[id]) {
                                const { libraryID, key } = extraData[id];
                                if (libraryID && key) {
                                    setCurrentSourcesAtom((prev) =>
                                        prev.filter((s) => !(s.libraryID === libraryID && s.itemKey === key)
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
            currentReaderIdRef.current = null;
            // Reset atom state on unmount
            setReaderTextSelection(null);
        };
    }, [setupReader, setReaderTextSelection, updateReaderAttachment, setReaderAttachment, window, waitForInternalReader]);

}
