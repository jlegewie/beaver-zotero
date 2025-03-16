// @ts-ignore useEffect is defined in React
import { useEffect, useRef } from "react";
import { syncZoteroDatabase, syncItemsToBackend, itemFilter, ItemFilterFunction } from "../../src/utils/sync";
import { syncService } from "../../src/services/syncService";
import { useAtomValue, useSetAtom } from "jotai";
import { isAuthenticatedAtom } from "../atoms/auth";
import { syncStatusAtom, syncTotalAtom, syncCurrentAtom, SyncStatus } from "../atoms/ui";
import { queueService, AddUploadQueueFromAttachmentRequest } from "../../src/services/queueService";
import { fileUploader } from "../../src/services/FileUploader";

/**
 * Hook that sets up Zotero database synchronization:
 * - Performs initial sync on mount
 * - Sets up listeners for item changes
 * 
 * @param filterFunction Optional function to filter which items to sync
 */
export function useZoteroSync(filterFunction: ItemFilterFunction = itemFilter) {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const setSyncTotal = useSetAtom(syncTotalAtom);
    const setSyncCurrent = useSetAtom(syncCurrentAtom);

    // ref to prevent multiple registrations if dependencies change
    const observerRef = useRef<any>(null);

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
        
        // Create the notification observer
        const observer = {
            notify: async function(event: string, type: string, ids: number[], extraData: any) {
                if (type === 'item') {
                    if (event === 'add' || event === 'modify') {
                        try {
                            // Get the items from Zotero
                            const items = await Zotero.Items.getAsync(ids);
                            
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
                                await syncItemsToBackend(libraryID, libraryItems, 'incremental', onStatusChange, onProgress);
                            }
                        } catch (error) {
                            console.error("[Beaver] Error syncing modified items:", error);
                        }
                    } else if (event === 'delete') {
                        // Handle deleted items
                        try {
                            // Get the keys by library ID
                            const keysByLibrary = new Map<number, string[]>();
                            for (const id of ids) {
                                // Extract library ID and keys from the extraData
                                if (extraData && extraData[id]) {
                                    const { libraryID, key } = extraData[id];
                                    if (libraryID && key) {
                                        keysByLibrary.set(libraryID, [...(keysByLibrary.get(libraryID) || []), key]);
                                    }
                                }
                            }
                            for (const [libraryID, keys] of keysByLibrary.entries()) {
                                await syncService.deleteItems(libraryID, keys);
                            }
                        } catch (error) {
                            console.error("[Beaver] Error handling deleted items:", error);
                        }
                    } else if (event === 'index') {
                        // Handle index event
                        console.log("[Beaver] Handling index event");
                        try {
                            // Get the items from Zotero
                            const items = await Zotero.Items.getAsync(ids);
                            if (items.length === 0) return;
                            
                            // Create a request to upload the fulltext items
                            const request = {
                                library_id: items[0].libraryID,
                                attachment_keys: [],
                                type: 'fulltext'
                            } as AddUploadQueueFromAttachmentRequest;
                            
                            // Add all fulltext items to the request
                            for (const item of items) {
                                // @ts-ignore FullText exists
                                if (Zotero.FullText.canIndex(item) && await Zotero.FullText.isFullyIndexed(item)) {
                                    request.attachment_keys.push(item.key);
                                }
                            }

                            // Add upload task to the upload queue and start the file uploader
                            if (request.attachment_keys.length > 0) {
                                console.log(`[Beaver] Adding ${request.attachment_keys.length} upload tasks to the upload queue`);
                                await queueService.addItemsFromAttachmentKeys(request);
                                fileUploader.start();
                            }
                        } catch (error) {
                            console.error("[Beaver] Error handling index event:", error);
                        }
                    }
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
        };
    }, [isAuthenticated, filterFunction]);
} 