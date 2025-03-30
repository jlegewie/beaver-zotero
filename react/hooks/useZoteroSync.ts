// @ts-ignore useEffect is defined in React
import { useEffect, useRef } from "react";
import { syncZoteroDatabase, syncItemsToBackend, itemFilter, ItemFilterFunction } from "../../src/utils/sync";
import { syncService } from "../../src/services/syncService";
import { useAtomValue, useSetAtom } from "jotai";
import { isAuthenticatedAtom } from "../atoms/auth";
import { syncStatusAtom, syncTotalAtom, syncCurrentAtom, SyncStatus } from "../atoms/ui";
import { queueService, AddUploadQueueFromAttachmentRequest } from "../../src/services/queueService";
import { fileUploader } from "../../src/services/FileUploader";

const DEBOUNCE_MS = 2000;

/**
 * Interface for collected sync events
 */
interface CollectedEvents {
    addModify: Set<number>; // Item IDs for add/modify events
    delete: Map<number, { libraryID: number, key: string }>; // ID to {libraryID, key} mapping for delete events
    index: Set<number>; // Item IDs for index events
    timer: number | null; // Timer ID for debounce
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
export function useZoteroSync(filterFunction: ItemFilterFunction = itemFilter, debounceMs: number = DEBOUNCE_MS) {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const setSyncTotal = useSetAtom(syncTotalAtom);
    const setSyncCurrent = useSetAtom(syncCurrentAtom);

    // ref to prevent multiple registrations if dependencies change
    const observerRef = useRef<any>(null);
    
    // ref for collected events - using ref to persist between renders
    const eventsRef = useRef<CollectedEvents>({
        addModify: new Set(),
        delete: new Map(),
        index: new Set(),
        timer: null,
        timestamp: 0
    });

    /**
     * Process collected add/modify events by library
     */
    const processAddModifyEvents = async () => {
        const itemIds = Array.from(eventsRef.current.addModify);
        if (itemIds.length === 0) return;
        
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
                console.log(`[Beaver] Syncing ${libraryItems.length} changed items from library ${libraryID}`);
                await syncItemsToBackend(libraryID, libraryItems, 'incremental', 
                    (status) => setSyncStatus(status), 
                    (processed, total) => {
                        setSyncTotal(total);
                        setSyncCurrent(processed);
                    });
            }
        } catch (error) {
            console.error("[Beaver] Error syncing modified items:", error);
        }
    };

    /**
     * Process collected delete events
     */
    const processDeleteEvents = async () => {
        if (eventsRef.current.delete.size === 0) return;
        
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
                console.log(`[Beaver] Deleting ${keys.length} items from library ${libraryID}`);
                await syncService.deleteItems(libraryID, keys);
            }
        } catch (error) {
            console.error("[Beaver] Error handling deleted items:", error);
        }
    };

    /**
     * Process collected index events
     */
    const processIndexEvents = async () => {
        const itemIds = Array.from(eventsRef.current.index);
        if (itemIds.length === 0) return;
        
        try {
            // Get the items from Zotero
            const items = await Zotero.Items.getAsync(itemIds as number[]);
            if (items.length === 0) return;
            
            // Create library-specific requests for fulltext items
            const requestsByLibrary = new Map<number, AddUploadQueueFromAttachmentRequest>();
            
            // Group items by library
            for (const item of items) {
                const libraryID = item.libraryID;
                
                // @ts-ignore FullText exists
                if (!Zotero.FullText.canIndex(item) || !(await Zotero.FullText.isFullyIndexed(item))) {
                    continue;
                }
                
                if (!requestsByLibrary.has(libraryID)) {
                    requestsByLibrary.set(libraryID, {
                        library_id: libraryID,
                        attachment_keys: [],
                        type: 'fulltext'
                    });
                }
                
                requestsByLibrary.get(libraryID)?.attachment_keys.push(item.key);
            }
            
            // Process each library's fulltext requests
            for (const request of requestsByLibrary.values()) {
                if (request.attachment_keys.length > 0) {
                    console.log(`[Beaver] Adding ${request.attachment_keys.length} upload tasks to the upload queue for library ${request.library_id}`);
                    await queueService.addItemsFromAttachmentKeys(request);
                }
            }
            
            // Start the uploader if we have any items to process
            if (Array.from(requestsByLibrary.values()).some(req => req.attachment_keys.length > 0)) {
                fileUploader.start();
            }
        } catch (error) {
            console.error("[Beaver] Error handling index event:", error);
        }
    };

    /**
     * Process all collected events and reset the collection
     */
    const processEvents = async () => {
        console.log(`[Beaver] Processing collected events after ${debounceMs}ms of inactivity`);
        console.log(`[Beaver] Events to process: ${eventsRef.current.addModify.size} add/modify, ${eventsRef.current.delete.size} delete, ${eventsRef.current.index.size} index`);
        
        // Process each type of event
        await processAddModifyEvents();
        await processDeleteEvents();
        await processIndexEvents();
        
        // Reset collections
        eventsRef.current.addModify.clear();
        eventsRef.current.delete.clear();
        eventsRef.current.index.clear();
        eventsRef.current.timer = null;
    };

    useEffect(() => {
        if (!isAuthenticated) return;
        console.log("[Beaver] Setting up Zotero sync");
        
        // Perform initial sync on mount
        const onStatusChange = (status: SyncStatus) => {
            setSyncStatus(status);
        }
        const onProgress = (processed: number, total: number) => {
            setSyncTotal(total);
            setSyncCurrent(processed);
        }
        syncZoteroDatabase(filterFunction, 50, onStatusChange, onProgress);
        
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
                    } else if (event === 'index') {
                        // Collect index events
                        ids.forEach(id => eventsRef.current.index.add(id));
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
        Zotero.Notifier.registerObserver(observer, ['item'], 'beaver-sync');
        observerRef.current = observer;
        
        // Cleanup function
        return () => {
            console.log("[Beaver] Cleaning up Zotero sync");
            if (observerRef.current) {
                Zotero.Notifier.unregisterObserver(observerRef.current);
                observerRef.current = null;
            }
            
            // Clear any pending timers
            if (eventsRef.current.timer !== null) {
                clearTimeout(eventsRef.current.timer);
                eventsRef.current.timer = null;
            }
            
            // Process any remaining events before unmounting
            if (
                eventsRef.current.addModify.size > 0 || 
                eventsRef.current.delete.size > 0 || 
                eventsRef.current.index.size > 0
            ) {
                processEvents();
            }
        };
    }, [isAuthenticated, filterFunction, debounceMs]);
}