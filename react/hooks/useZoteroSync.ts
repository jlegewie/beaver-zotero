import { useEffect, useRef } from "react";
import { syncZoteroDatabase, syncingItemFilter, ItemFilterFunction } from "../../src/utils/sync";
import { useAtomValue } from "jotai";
import { isAuthenticatedAtom, userAtom } from "../atoms/auth";
import { fileUploader } from "../../src/services/FileUploader";
import { hasAuthorizedAccessAtom, syncLibraryIdsAtom, isDeviceAuthorizedAtom, planFeaturesAtom } from "../atoms/profile";
import { store } from "../index";
import { logger } from "../../src/utils/logger";
import { deleteItems } from "../../src/utils/sync";

const DEBOUNCE_MS = 2000;
const LIBRARY_SYNC_DELAY_MS = 4000; // Delay before calling syncZoteroDatabase for changed libraries
const SYNC_BATCH_SIZE_INITIAL = 100;

/**
 * Interface for collected sync events
 */
interface CollectedEvents {
    changedLibraries: Set<number>; // Library IDs that have changes
    delete: Map<number, { libraryID: number, key: string }>; // ID to {libraryID, key} mapping for delete events
    timer: NodeJS.Timeout | null; // Timer ID for debounce
    timestamp: number; // Last event timestamp
}

/**
 * Hook that sets up Zotero database synchronization:
 * - Performs initial sync on mount
 * - Sets up listeners for item changes with debouncing
 * - Processes batched events after a period of inactivity
 * 
 * @param filterFunction Optional function to filter which items to sync
 * @param debounceMs Debounce time in milliseconds (default: 2000ms)
 */
export function useZoteroSync(filterFunction: ItemFilterFunction = syncingItemFilter, debounceMs: number = DEBOUNCE_MS) {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isAuthorized = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);

    // ref to prevent multiple registrations if dependencies change
    const zoteroNotifierIdRef = useRef<string | null>(null);
    
    // ref for collected events - using ref to persist between renders
    const eventsRef = useRef<CollectedEvents>({
        changedLibraries: new Set(),
        delete: new Map(),
        timer: null,
        timestamp: 0
    });

    /**
     * Process libraries that have changes by calling syncZoteroDatabase
     */
    const processChangedLibraries = async () => {
        const changedLibraryIds = Array.from(eventsRef.current.changedLibraries);
        if (changedLibraryIds.length === 0) return;
        
        try {
            // Filter to only sync libraries that are in syncLibraryIds
            const librariesToSync = changedLibraryIds.filter(libraryId => syncLibraryIds.includes(libraryId));
            
            if (librariesToSync.length === 0) {
                logger(`useZoteroSync: No libraries to sync`, 3);
                return;
            }

            logger(`useZoteroSync: Syncing ${librariesToSync.length} changed libraries: ${librariesToSync.join(', ')}`, 3);
            await syncZoteroDatabase(librariesToSync, filterFunction, SYNC_BATCH_SIZE_INITIAL);
        } catch (error: any) {
            logger(`useZoteroSync: Error syncing changed libraries: ${error.message}`, 1);
            Zotero.logError(error);
        }
    };

    /**
     * Process collected delete events
     */
    const processDeleteEvents = async () => {
        if (eventsRef.current.delete.size === 0) return;
        
        const user = store.get(userAtom);
        if (!user) {
            logger('useZoteroSync: No user found', 1);
            return;
        }
        
        try {
            // Group by library ID for batch processing
            const keysByLibrary = new Map<number, string[]>();
            
            for (const { libraryID, key } of eventsRef.current.delete.values()) {
                if(syncLibraryIds.includes(libraryID)) {
                    if (!keysByLibrary.has(libraryID)) {
                        keysByLibrary.set(libraryID, []);
                    }
                    keysByLibrary.get(libraryID)?.push(key);
                }
            }
            
            // Process each library's deletions
            for (const [libraryID, keys] of keysByLibrary.entries()) {
                logger(`useZoteroSync: Deleting ${keys.length} items from library ${libraryID}`, 3);
                await deleteItems(user.id, libraryID, keys);
            }
        } catch (error: any) {
            logger(`useZoteroSync: Error handling deleted items: ${error.message}`, 1);
            Zotero.logError(error);
        }
    };

    /**
     * Process all collected events and reset the collection
     */
    const processEvents = async () => {
        logger(`useZoteroSync: Processing collected events after ${LIBRARY_SYNC_DELAY_MS}ms of inactivity`, 3);
        logger(`useZoteroSync: Events to process: ${eventsRef.current.changedLibraries.size} changed libraries, ${eventsRef.current.delete.size} delete`, 3);
        
        // Process each type of event
        await processChangedLibraries();
        await processDeleteEvents();
        
        // Reset collections
        eventsRef.current.changedLibraries.clear();
        eventsRef.current.delete.clear();
        eventsRef.current.timer = null;
    };

    useEffect(() => {
        // Conditions for sync
        if (!isAuthenticated) return;
        if (!isAuthorized) return;
        if (!isDeviceAuthorized) return;
        if (syncLibraryIds.length === 0) return;

        // Set initial status to in_progress
        logger("useZoteroSync: Setting up Zotero sync", 3);
        
        // Function to create the observer
        const setupObserver = () => {
            // Create the notification observer with debouncing
            const observer = {
                notify: async function(event: string, type: string, ids: number[], extraData: any) {
                    if (type === 'item') {
                        // Record the timestamp of this event
                        eventsRef.current.timestamp = Date.now();
                        
                        if (event === 'add' || event === 'modify') {
                            // Filter add events by library immediately and track changed libraries
                            const items = await Zotero.Items.getAsync(ids as number[]);
                            items
                                .filter(item => syncLibraryIds.includes(item.libraryID))
                                .forEach(item => {
                                    eventsRef.current.changedLibraries.add(item.libraryID);
                                    eventsRef.current.delete.delete(item.id);
                                });
                        } else if (event === 'delete') {
                            // Collect delete events with their metadata
                            ids.forEach(id => {
                                if (extraData && extraData[id]) {
                                    const { libraryID, key } = extraData[id];
                                    if (libraryID && key) {
                                        if(syncLibraryIds.includes(libraryID)) {
                                            eventsRef.current.delete.set(id, { libraryID, key });
                                        }
                                    } else {
                                        logger(`useZoteroSync: Missing libraryID or key in extraData for permanently deleted item ID ${id}. Cannot queue for backend deletion.`, 2);
                                    }
                                } else {
                                    logger(`useZoteroSync: Missing extraData for permanently deleted item ID ${id}. Cannot queue for backend deletion.`, 2);
                                }
                            });
                        }
                        
                        // Clear existing timer and set a new one
                        if (eventsRef.current.timer !== null) {
                            clearTimeout(eventsRef.current.timer);
                        }
                        
                        // Set new timer to process events after debounce period
                        eventsRef.current.timer = setTimeout(processEvents, LIBRARY_SYNC_DELAY_MS);
                    }
                }
            // @ts-ignore Zotero.Notifier.Notify is defined
            } as Zotero.Notifier.Notify;
            
            // Register the observer
            zoteroNotifierIdRef.current = Zotero.Notifier.registerObserver(observer, ['item'], 'beaver-sync');
        };
        
        // Initialize sync operations
        const initializeSync = async () => {
            try {
                // First sync the database
                await syncZoteroDatabase(syncLibraryIds, filterFunction, SYNC_BATCH_SIZE_INITIAL);
                // Then set up the observer after sync completes
                setupObserver();
                // Start file uploader after sync completes
                if (store.get(planFeaturesAtom)?.uploadFiles) {
                    await fileUploader.start();
                }
            } catch (error: any) {
                logger(`useZoteroSync: Error during initial sync: ${error.message}`, 1);
                Zotero.logError(error);
                // Still set up the observer even if initial sync fails
                setupObserver();
            }
        };
        
        // Call the async initialization function
        initializeSync();
        
        // Cleanup function
        return () => {
            logger("useZoteroSync: Cleaning up Zotero sync", 3);
            if (zoteroNotifierIdRef.current) {
                Zotero.Notifier.unregisterObserver(zoteroNotifierIdRef.current);
                zoteroNotifierIdRef.current = null;
            }
            
            // Clear any pending timers
            if (eventsRef.current.timer !== null) {
                clearTimeout(eventsRef.current.timer);
                eventsRef.current.timer = null;
            }
            
            // Process any remaining events before unmounting
            if (
                eventsRef.current.changedLibraries.size > 0 || 
                eventsRef.current.delete.size > 0
            ) {
                processEvents();
            }
        };
    }, [isAuthenticated, filterFunction, debounceMs, isAuthorized, isDeviceAuthorized, syncLibraryIds]);
}