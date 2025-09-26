import { syncService, SyncDataResponse } from '../services/syncService';
import { logger } from './logger';
import { userIdAtom } from "../../react/atoms/auth";
import { store } from "../../react/store";
import { getClientDateModifiedAsISOString, getClientDateModifiedBatch } from './zoteroUtils';
import { v4 as uuidv4 } from 'uuid';
import { syncWithZoteroAtom } from '../../react/atoms/profile';
import { deleteItems, getAllItemsToSync, syncingItemFilter, SyncItem, syncItemsToBackend, extractItemData, extractAttachmentData } from './sync';

/**
 * Discrepancy information for consistency checks
 */
interface ItemDiscrepancy {
    zotero_key: string;
    backend_hash: string;
    local_hash: string;
    backend_version: number;
    local_version: number;
    backend_date_modified: string;
    local_date_modified: string;
    should_update: boolean;
    reason: string;
}

interface AttachmentDiscrepancy {
    zotero_key: string;
    backend_hash: string;
    local_hash: string;
    backend_version: number;
    local_version: number;
    backend_date_modified: string;
    local_date_modified: string;
    should_update: boolean;
    reason: string;
}

interface ConsistencyCheckResult {
    library_id: number;
    total_items_checked: number;
    total_attachments_checked: number;
    item_discrepancies: ItemDiscrepancy[];
    attachment_discrepancies: AttachmentDiscrepancy[];
    items_updated: number;
    attachments_updated: number;
    items_and_attachments_added: number;
}

/**
 * Performs a consistency check by comparing local and backend metadata hashes
 * @param libraryID Zotero library ID to check
 * @param pageSize Number of items per page for pagination (default: 500)
 * @param sendUpdates Whether to send updates to backend for discrepancies (default: true)
 * @returns Promise resolving to consistency check results
 */
export async function performConsistencyCheck(
    libraryID: number,
    pageSize: number = 500,
    sendUpdates: boolean = true
): Promise<ConsistencyCheckResult> {
    const consistencyId = uuidv4();
    const library = Zotero.Libraries.get(libraryID);
    const libraryName = library ? library.name : 'Unknown';
    
    logger(`Beaver Consistency Check '${consistencyId}': Starting consistency check for library ${libraryID} (${libraryName})`, 2);

    const userId = store.get(userIdAtom);
    if (!userId) {
        logger(`Beaver Consistency Check '${consistencyId}': No user ID found, cannot perform consistency check.`, 1);
        throw new Error('User not authenticated for consistency check');
    }

    const result: ConsistencyCheckResult = {
        library_id: libraryID,
        total_items_checked: 0,
        total_attachments_checked: 0,
        item_discrepancies: [],
        attachment_discrepancies: [],
        items_updated: 0,
        attachments_updated: 0,
        items_and_attachments_added: 0,
    };

    // Get all local items before processing backend data
    logger(`Beaver Consistency Check '${consistencyId}': Getting all local items to track new additions`, 3);
    const allLocalItems = await getAllItemsToSync(libraryID);
    const localItemKeys = new Set<string>();
    
    for (const item of allLocalItems) {
        localItemKeys.add(item.key);
    }

    logger(`Beaver Consistency Check '${consistencyId}': Found ${localItemKeys.size} local items`, 3);

    // Process all pages from backend
    let page = 0;
    let hasMore = true;
    while (hasMore) {
        try {
            logger(`Beaver Consistency Check '${consistencyId}': Processing page ${page + 1}`, 3);
            
            // Get backend data for this page
            const backendData: SyncDataResponse = await syncService.getSyncData(
                libraryID,
                null, // Get all data, not since a specific version
                null, // Get all data, not until a specific version
                page,
                pageSize
            );

            const { items_state: backendItems, attachments_state: backendAttachments } = backendData;
            
            logger(`Beaver Consistency Check '${consistencyId}': Page ${page + 1}: ${backendItems.length} items, ${backendAttachments.length} attachments`, 4);

            result.total_items_checked += backendItems.length;
            result.total_attachments_checked += backendAttachments.length;

            // Remove processed keys from local set
            backendItems.forEach(item => localItemKeys.delete(item.zotero_key));
            backendAttachments.forEach(attachment => localItemKeys.delete(attachment.zotero_key));

            // Get zotero items and clientDateModified for all items
            const zoteroItemsPromises = backendItems.map((item) => Zotero.Items.getByLibraryAndKeyAsync(libraryID, item.zotero_key));
            const zoteroItems = (await Promise.all(zoteroItemsPromises)).filter(syncingItemFilter) as Zotero.Item[];
            const zoteroItemsMap = new Map(zoteroItems.map(item => [item.key, item]));
            const clientDateModifiedMap = await getClientDateModifiedBatch(zoteroItems);

            // Process items concurrently
            const itemProcessingPromises = backendItems.map(async (backendItem) => {
                try {
                    const zoteroItem = zoteroItemsMap.get(backendItem.zotero_key);
                    if (!zoteroItem) {
                        return { deleteKey: backendItem.zotero_key };
                    }

                    const localDateModified = clientDateModifiedMap.get(zoteroItem.id) || await getClientDateModifiedAsISOString(zoteroItem);
                    const localItemData = await extractItemData(zoteroItem, localDateModified);
                    if (backendItem.metadata_hash !== localItemData.item_metadata_hash) {
                        const shouldUpdate = shouldUpdateBackend(
                            backendItem.zotero_version,
                            backendItem.date_modified,
                            zoteroItem.version,
                            localDateModified
                        );
                        return {
                            discrepancy: {
                                zotero_key: backendItem.zotero_key,
                                backend_hash: backendItem.metadata_hash,
                                local_hash: localItemData.item_metadata_hash,
                                backend_version: backendItem.zotero_version,
                                local_version: zoteroItem.version,
                                backend_date_modified: backendItem.date_modified,
                                local_date_modified: localDateModified,
                                should_update: shouldUpdate,
                                reason: shouldUpdate ? 'local version is newer or equal with newer date' : 'backend version is newer',
                            },
                        };
                    }
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Error processing item ${backendItem.zotero_key}: ${error.message}`, 1);
                    Zotero.logError(error);
                }
                return null;
            });

            // Get zotero items and clientDateModified for all attachments
            const zoteroAttachmentsPromises = backendAttachments.map((item) => Zotero.Items.getByLibraryAndKeyAsync(libraryID, item.zotero_key));
            const zoteroAttachments = (await Promise.all(zoteroAttachmentsPromises)).filter(syncingItemFilter) as Zotero.Item[];
            const zoteroAttachmentsMap = new Map(zoteroAttachments.map(item => [item.key, item]));
            const clientDateModifiedMapAttachments = await getClientDateModifiedBatch(zoteroAttachments);

            // Process attachments concurrently
            const attachmentProcessingPromises = backendAttachments.map(async (backendAttachment) => {
                try {
                    const zoteroAttachment = zoteroAttachmentsMap.get(backendAttachment.zotero_key);
                    if (!zoteroAttachment) {
                        return { deleteKey: backendAttachment.zotero_key };
                    }

                    const localDateModified = clientDateModifiedMapAttachments.get(zoteroAttachment.id) || await getClientDateModifiedAsISOString(zoteroAttachment);
                    const localAttachmentData = await extractAttachmentData(zoteroAttachment, localDateModified, { skipFileHash: true });
                    if (localAttachmentData && backendAttachment.metadata_hash !== localAttachmentData.attachment_metadata_hash) {
                        const shouldUpdate = shouldUpdateBackend(
                            backendAttachment.zotero_version,
                            backendAttachment.date_modified,
                            zoteroAttachment.version,
                            localDateModified
                        );
                        return {
                            discrepancy: {
                                zotero_key: backendAttachment.zotero_key,
                                backend_hash: backendAttachment.metadata_hash,
                                local_hash: localAttachmentData.attachment_metadata_hash,
                                backend_version: backendAttachment.zotero_version,
                                local_version: zoteroAttachment.version,
                                backend_date_modified: backendAttachment.date_modified,
                                local_date_modified: localDateModified,
                                should_update: shouldUpdate,
                                reason: shouldUpdate ? 'local version is newer or equal with newer date' : 'backend version is newer',
                            },
                        };
                    }
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Error processing attachment ${backendAttachment.zotero_key}: ${error.message}`, 1);
                    Zotero.logError(error);
                }
                return null;
            });

            const [itemResults, attachmentResults] = await Promise.all([
                Promise.all(itemProcessingPromises),
                Promise.all(attachmentProcessingPromises),
            ]);

            // Collate results
            const itemsToDelete = itemResults.map(r => r?.deleteKey).filter((k): k is string => !!k);
            result.item_discrepancies.push(...itemResults.map(r => r?.discrepancy).filter((d): d is ItemDiscrepancy => !!d));
            
            const attachmentsToDelete = attachmentResults.map(r => r?.deleteKey).filter((k): k is string => !!k);
            result.attachment_discrepancies.push(...attachmentResults.map(r => r?.discrepancy).filter((d): d is AttachmentDiscrepancy => !!d));

            // Log discrepancies
            result.item_discrepancies.forEach(d => logger(`Beaver Consistency Check '${consistencyId}': Item discrepancy found for ${d.zotero_key}: ${d.reason}`, 2));
            result.attachment_discrepancies.forEach(d => logger(`Beaver Consistency Check '${consistencyId}': Attachment discrepancy found for ${d.zotero_key}: ${d.reason}`, 2));

            // Delete items from backend that don't exist locally
            const allKeysToDelete = [...itemsToDelete, ...attachmentsToDelete];
            if (allKeysToDelete.length > 0) {
                logger(`Beaver Consistency Check '${consistencyId}': ${allKeysToDelete.length} items not found locally, deleting from backend.`, 3);
                try {
                    await deleteItems(userId, libraryID, allKeysToDelete);
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Failed to delete items from backend: ${error.message}`, 1);
                    Zotero.logError(error);
                }
            }

            // Send updates to backend if requested and discrepancies found
            if (sendUpdates && (result.item_discrepancies.length > 0 || result.attachment_discrepancies.length > 0)) {
                logger(`Beaver Consistency Check '${consistencyId}': Sending updates to backend for discrepancies`, 3);
                
                try {
                    const itemsToUpdate = result.item_discrepancies
                        .filter(d => d.should_update)
                        .map(d => d.zotero_key);
                    
                    const attachmentsToUpdate = result.attachment_discrepancies
                        .filter(d => d.should_update)
                        .map(d => d.zotero_key);

                    if (itemsToUpdate.length > 0 || attachmentsToUpdate.length > 0) {
                        // Get the actual items to send
                        const itemsToSync: SyncItem[] = [];
                        
                        // Add regular items
                        for (const key of itemsToUpdate) {
                            const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
                            if (item && item.isRegularItem()) {
                                itemsToSync.push({ action: 'upsert', item });
                            }
                        }
                        
                        // Add attachments
                        for (const key of attachmentsToUpdate) {
                            const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
                            if (item && item.isAttachment()) {
                                itemsToSync.push({ action: 'upsert', item });
                            }
                        }

                        const syncWithZotero = store.get(syncWithZoteroAtom);
                        const syncMethod = syncWithZotero ? 'version' : 'date_modified';

                        if (itemsToSync.length > 0) {
                            await syncItemsToBackend(
                                consistencyId,
                                libraryID,
                                itemsToSync,
                                'consistency',
                                syncMethod
                            );
                            
                            result.items_updated = itemsToUpdate.length;
                            result.attachments_updated = attachmentsToUpdate.length;
                        }
                    }
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Error sending updates: ${error.message}`, 1);
                    Zotero.logError(error);
                }
            }

            hasMore = backendData.has_more;
            page++;
            
        } catch (error: any) {
            logger(`Beaver Consistency Check '${consistencyId}': Error processing page ${page + 1}: ${error.message}`, 1);
            Zotero.logError(error);
            break;
        }
    }

    // After processing all backend data, sync remaining local items
    if (sendUpdates && localItemKeys.size > 0) {
        // TODO: This includes attachments with missing files. They are excluded from the actual sync but counted here.
        const zoteroItems = await Promise.all(Array.from(localItemKeys).map((key) => Zotero.Items.getByLibraryAndKeyAsync(libraryID, key)));
        const newItemsToSync: SyncItem[] = zoteroItems.filter(syncingItemFilter).map((item) => ({ action: 'upsert', item } as SyncItem));
        const newItemKeys = newItemsToSync.map((item) => item.item.key)

        logger(`Beaver Consistency Check '${consistencyId}': Found ${newItemsToSync.length} new items to add (${newItemKeys.join(', ')})`, 3);

        if (newItemsToSync.length > 0) {
            try {
                const syncWithZotero = store.get(syncWithZoteroAtom);
                const syncMethod = syncWithZotero ? 'version' : 'date_modified';

                await syncItemsToBackend(consistencyId, libraryID, newItemsToSync, 'consistency', syncMethod);
                
                result.items_and_attachments_added = newItemsToSync.length;
            } catch (error: any) {
                logger(`Beaver Consistency Check '${consistencyId}': Error adding new items: ${error.message}`, 1);
                Zotero.logError(error);
            }
        }
    }

    // Final logging of results
    logger(`Beaver Consistency Check '${consistencyId}': Completed`, 2);
    logger(`Beaver Consistency Check '${consistencyId}': Checked ${result.total_items_checked} items, ${result.total_attachments_checked} attachments`, 3);
    logger(`Beaver Consistency Check '${consistencyId}': Found ${result.item_discrepancies.length} item discrepancies, ${result.attachment_discrepancies.length} attachment discrepancies`, 3);
    if (sendUpdates) {
        logger(`Beaver Consistency Check '${consistencyId}': Updated ${result.items_updated} items, ${result.attachments_updated} attachments`, 3);
        logger(`Beaver Consistency Check '${consistencyId}': Added ${result.items_and_attachments_added} items and attachments`, 3);
    }

    return result;
}

/**
 * Determines whether the backend should be updated based on version and date comparison
 * @param backendVersion Backend version number
 * @param backendDate Backend date modified (ISO string)
 * @param localVersion Local version number
 * @param localDate Local date modified (SQL datetime string)
 * @returns true if backend should be updated
 */
function shouldUpdateBackend(
    backendVersion: number,
    backendDate: string,
    localVersion: number,
    localDate: string
): boolean {
    // Local version is newer
    if (localVersion > backendVersion) {
        return true;
    }
    
    // Same version, check date
    if (localVersion === backendVersion) {
        const backendTime = new Date(backendDate).getTime();
        const localTime = new Date(localDate).getTime();
        return localTime >= backendTime;
    }
    
    // Backend version is newer
    return false;
}

