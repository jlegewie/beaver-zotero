import { useEffect, useRef } from "react";
import { syncZoteroDatabase, syncItemsToBackend, syncingItemFilter, ItemFilterFunction } from "../../src/utils/sync";
import { syncService } from "../../src/services/syncService";
import { useAtomValue, useSetAtom } from "jotai";
import { isAuthenticatedAtom, userAtom } from "../atoms/auth";
import { syncStatusAtom, SyncStatus } from "../atoms/ui";
import { fileUploader } from "../../src/services/FileUploader";
import { planFeaturesAtom, hasAuthorizedAccessAtom } from "../atoms/profile";
import { store } from "../index";
import { logger } from "../../src/utils/logger";

const DEBOUNCE_MS = 2000;
const SYNC_BATCH_SIZE_INITIAL = 100;
const SYNC_BATCH_SIZE_INCREMENTAL = 200;

/**
 * Interface for collected sync events
 */
interface CollectedEvents {
    addModify: Set<number>; // Item IDs for add/modify events
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
    const planFeatures = useAtomValue(planFeaturesAtom);
    const setSyncStatus = useSetAtom(syncStatusAtom);

    // ref to prevent multiple registrations if dependencies change
    const zoteroNotifierIdRef = useRef<string | null>(null);
    
    // ref for collected events - using ref to persist between renders
    const eventsRef = useRef<CollectedEvents>({
        addModify: new Set(),
        delete: new Map(),
        timer: null,
        timestamp: 0
    });

    /**
     * Process collected add/modify events by library
     */
    const processAddModifyEvents = async () => {
        const itemIds = Array.from(eventsRef.current.addModify);
        if (itemIds.length === 0) return;
        
        // Reset progress counters at the start of this operation
        setSyncStatus('in_progress');
        
        try {
            // Get the items from Zotero
            const items = await Zotero.Items.getAsync(itemIds as number[]);
            
            // Filter items that match our criteria
            const filteredItems = items.filter(filterFunction);
            
            if (filteredItems.length === 0) return;
            
            // Group items by library ID and sync each group separately
            const itemsByLibrary = new Map<number, Zotero.Item[]>();
            
            for (const item of filteredItems) {
                const libraryID = item.libraryID;
                if (!itemsByLibrary.has(libraryID)) {
                    itemsByLibrary.set(libraryID, []);
                }
                itemsByLibrary.get(libraryID)?.push(item);
            }
            
            // Sync each library's items separately
            for (const [libraryID, libraryItems] of itemsByLibrary.entries()) {
                logger(`useZoteroSync: Syncing ${libraryItems.length} changed items from library ${libraryID}`, 3);
                await syncItemsToBackend(
                    libraryID,
                    libraryItems,
                    'incremental', 
                    (status) => setSyncStatus(status), 
                    (processed, total) => { },
                    SYNC_BATCH_SIZE_INCREMENTAL
                );
            }
        } catch (error: any) {
            logger(`useZoteroSync: Error syncing modified items: ${error.message}`, 1);
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
                if (!keysByLibrary.has(libraryID)) {
                    keysByLibrary.set(libraryID, []);
                }
                keysByLibrary.get(libraryID)?.push(key);
            }
            
            // Process each library's deletions
            for (const [libraryID, keys] of keysByLibrary.entries()) {
                logger(`useZoteroSync: Deleting ${keys.length} items from library ${libraryID}`, 3);
                await syncService.deleteItems(libraryID, keys);
                await Zotero.Beaver.db.deleteByLibraryAndKeys(user.id, libraryID, keys);
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
        logger(`useZoteroSync: Processing collected events after ${debounceMs}ms of inactivity`, 3);
        logger(`useZoteroSync: Events to process: ${eventsRef.current.addModify.size} add/modify, ${eventsRef.current.delete.size} delete`, 3);
        
        // Process each type of event
        await processAddModifyEvents();
        await processDeleteEvents();
        
        // Reset collections
        eventsRef.current.addModify.clear();
        eventsRef.current.delete.clear();
        eventsRef.current.timer = null;
    };

    useEffect(() => {
        // Conditions for sync
        if (!isAuthenticated) return;
        if (!isAuthorized) return;
        if (!planFeatures.databaseSync) return;

        // Set initial status to in_progress
        logger("useZoteroSync: Setting up Zotero sync", 3);
        setSyncStatus('in_progress');
        
        // Status change callback
        const onStatusChange = (status: SyncStatus) => {
            setSyncStatus(status);
        }
        const onProgress = (processed: number, total: number) => { }
        
        // Function to create the observer
        const setupObserver = () => {
            // Create the notification observer with debouncing
            const observer = {
                notify: async function(event: string, type: string, ids: number[], extraData: any) {
                    if (type === 'item') {
                        // Record the timestamp of this event
                        eventsRef.current.timestamp = Date.now();
                        
                        if (event === 'add' || event === 'modify') {
                            // Collect add/modify events
                            ids.forEach(id => eventsRef.current.addModify.add(id));
                        } else if (event === 'delete') {
                            // Collect delete events with their metadata
                            ids.forEach(id => {
                                if (extraData && extraData[id]) {
                                    const { libraryID, key } = extraData[id];
                                    if (libraryID && key) {
                                        eventsRef.current.delete.set(id, { libraryID, key });
                                    }
                                }
                            });
                        }
                        
                        // Clear existing timer and set a new one
                        if (eventsRef.current.timer !== null) {
                            clearTimeout(eventsRef.current.timer);
                        }
                        
                        // Set new timer to process events after debounce period
                        eventsRef.current.timer = setTimeout(processEvents, debounceMs);
                    }
                }
            // @ts-ignore Zotero.Notifier.Notify is defined
            } as Zotero.Notifier.Notify;
            
            // Register the observer
            zoteroNotifierIdRef.current = Zotero.Notifier.registerObserver(observer, ['item'], 'beaver-sync');
        };
        
        // Create an async initialization function
        const initializeSync = async () => {
            try {
                // First sync the database
                await syncZoteroDatabase(filterFunction, SYNC_BATCH_SIZE_INITIAL, onStatusChange, onProgress);
                // Then set up the observer after sync completes
                setupObserver();
                // Start file uploader after sync completes
                await fileUploader.start();
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
                eventsRef.current.addModify.size > 0 || 
                eventsRef.current.delete.size > 0
            ) {
                processEvents();
            }
        };
    }, [isAuthenticated, filterFunction, debounceMs, planFeatures.databaseSync, isAuthorized]);
}