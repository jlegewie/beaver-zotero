/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../utils/logger';
import { ZoteroItemStatus, ItemDataWithStatus, AttachmentDataWithStatus } from '../../react/types/zotero';
import { safeIsInTrash } from '../utils/zoteroUtils';
import { syncingItemFilterAsync } from '../utils/sync';
import { syncLibraryIdsAtom, syncWithZoteroAtom } from '../../react/atoms/profile';
import { userIdAtom } from '../../react/atoms/auth';

import { store } from '../../react/store';
import { isAttachmentOnServer } from '../utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../../react/utils/sourceUtils';
import { serializeAttachment, serializeItem } from '../utils/zoteroSerializers';
import { FindReferenceData, findExistingReference } from '../../react/utils/findExistingReference';
import {
    WSZoteroDataRequest,
    WSZoteroDataResponse,
    WSDataError,
    WSExternalReferenceCheckRequest,
    WSExternalReferenceCheckResponse,
    ExternalReferenceCheckResult,
} from './agentProtocol';

/**
 * Handle zotero_data_request event.
 * Fetches item/attachment metadata for the requested references.
 */
export async function handleZoteroDataRequest(request: WSZoteroDataRequest): Promise<WSZoteroDataResponse> {
    const errors: WSDataError[] = [];

    // Get sync configuration from store
    const syncLibraryIds = store.get(syncLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Track keys to avoid duplicates when including parents/attachments
    const itemKeys = new Set<string>();
    const attachmentKeys = new Set<string>();

    // Collect Zotero items to serialize
    const itemsToSerialize: Zotero.Item[] = [];
    const attachmentsToSerialize: Zotero.Item[] = [];

    const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

    // Phase 1: Collect primary items from request (don't access parentID/getAttachments yet)
    const primaryItems: Zotero.Item[] = [];
    const referenceToItem = new Map<string, Zotero.Item>();
    
    for (const reference of request.items) {
        try {
            const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
            if (!zoteroItem) {
                errors.push({
                    reference,
                    error: 'Item not found in local database',
                    error_code: 'not_found'
                });
                continue;
            }
            primaryItems.push(zoteroItem);
            referenceToItem.set(makeKey(reference.library_id, reference.zotero_key), zoteroItem);
        } catch (error: any) {
            logger(`AgentService: Failed to load zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            errors.push({
                reference,
                error: 'Failed to load item',
                error_code: 'load_failed'
            });
        }
    }

    // Phase 2: Load data types for primary items BEFORE accessing parentID/getAttachments
    if (primaryItems.length > 0) {
        await Zotero.Items.loadDataTypes(primaryItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    // Phase 3: Now expand to parents and children (safe to access parentID/getAttachments)
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue; // Already recorded error in Phase 1

        try {
            if (zoteroItem.isAttachment()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!attachmentKeys.has(key)) {
                    attachmentKeys.add(key);
                    attachmentsToSerialize.push(zoteroItem);
                }

                // Include parent item if requested
                if (request.include_parents && zoteroItem.parentID) {
                    const parentItem = await Zotero.Items.getAsync(zoteroItem.parentID);
                    if (parentItem && !parentItem.isAttachment()) {
                        const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                        if (!itemKeys.has(parentKey)) {
                            itemKeys.add(parentKey);
                            itemsToSerialize.push(parentItem);
                        }
                    }
                }
            } else if (zoteroItem.isRegularItem()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!itemKeys.has(key)) {
                    itemKeys.add(key);
                    itemsToSerialize.push(zoteroItem);
                }

                // Include attachments if requested
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        const attachment = await Zotero.Items.getAsync(attachmentId);
                        if (attachment) {
                            const attKey = makeKey(attachment.libraryID, attachment.key);
                            if (!attachmentKeys.has(attKey)) {
                                attachmentKeys.add(attKey);
                                attachmentsToSerialize.push(attachment);
                            }
                        }
                    }
                }
            } else {
                errors.push({
                    reference,
                    error: 'Item is not a regular item or attachment',
                    error_code: 'filtered_from_sync'
                });
            }
        } catch (error: any) {
            logger(`AgentService: Failed to expand zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed'
            });
        }
    }

    // Phase 4: Load data for all items (including newly discovered parents and children)
    const allItems = [...itemsToSerialize, ...attachmentsToSerialize];
    if (allItems.length > 0) {
        // Load all item data in bulk
        await Zotero.Items.loadDataTypes(allItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
        
        // Load parent items for attachments (needed for isInTrash() to check parent trash status)
        const parentIds = [...new Set(
            allItems
                .filter(item => item.parentID)
                .map(item => item.parentID as number)
        )];
        if (parentIds.length > 0) {
            const parentItems = await Zotero.Items.getAsync(parentIds);
            if (parentItems.length > 0) {
                await Zotero.Items.loadDataTypes(parentItems, ["primaryData"]);
            }
        }
    }

    // Helper function to compute status for an item
    const computeStatus = async (item: Zotero.Item): Promise<ZoteroItemStatus> => {
        const isSyncedLibrary = syncLibraryIds.includes(item.libraryID);
        const trashState = safeIsInTrash(item);
        const isInTrash = trashState === true;
        const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
        const passesSyncFilters = availableLocallyOrOnServer && (await syncingItemFilterAsync(item));
        
        // Compute is_pending_sync only if we have a userId
        let isPendingSync: boolean | null = null;
        if (userId) {
            try {
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                isPendingSync = !wasAddedBeforeSync;
            } catch (e) {
                // Unable to determine pending status
                isPendingSync = null;
            }
        }

        return {
            is_synced_library: isSyncedLibrary,
            is_in_trash: isInTrash,
            available_locally_or_on_server: availableLocallyOrOnServer,
            passes_sync_filters: passesSyncFilters,
            is_pending_sync: isPendingSync
        };
    };

    // Phase 3: Serialize all items and attachments with status
    const [itemResults, attachmentResults] = await Promise.all([
        Promise.all(itemsToSerialize.map(async (item): Promise<ItemDataWithStatus | null> => {
            const serialized = await serializeItem(item, undefined);
            const status = await computeStatus(item);
            return { item: serialized, status };
        })),
        Promise.all(attachmentsToSerialize.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
            const serialized = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
            if (!serialized) {
                errors.push({
                    reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                    error: 'Attachment not available locally',
                    error_code: 'not_available'
                });
                return null;
            }
            const status = await computeStatus(attachment);
            return { attachment: serialized, status };
        }))
    ]);

    // Filter out null results
    const items = itemResults.filter((i): i is ItemDataWithStatus => i !== null);
    const attachments = attachmentResults.filter((a): a is AttachmentDataWithStatus => a !== null);

    const response: WSZoteroDataResponse = {
        type: 'zotero_data',
        request_id: request.request_id,
        items,
        attachments,
        errors: errors.length > 0 ? errors : undefined
    };

    return response;   
}


/**
 * Handle external_reference_check_request event.
 */
export async function handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<WSExternalReferenceCheckResponse> {
    const results: ExternalReferenceCheckResult[] = [];

    // Process all items in parallel for efficiency
    const checkPromises = request.items.map(async (item): Promise<ExternalReferenceCheckResult> => {
        try {
            const referenceData: FindReferenceData = {
                title: item.title,
                date: item.date,
                DOI: item.doi,
                ISBN: item.isbn,
                creators: item.creators
            };

            const existingItem = await findExistingReference(request.library_id, referenceData);

            if (existingItem) {
                return {
                    id: item.id,
                    exists: true,
                    item: {
                        library_id: existingItem.libraryID,
                        zotero_key: existingItem.key
                    }
                };
            }

            return {
                id: item.id,
                exists: false
            };
        } catch (error) {
            logger(`AgentService: Failed to check reference ${item.id}: ${error}`, 1);
            // Return as not found on error
            return {
                id: item.id,
                exists: false
            };
        }
    });

    const resolvedResults = await Promise.all(checkPromises);
    results.push(...resolvedResults);

    const response: WSExternalReferenceCheckResponse = {
        type: 'external_reference_check',
        request_id: request.request_id,
        results
    };

    return response;
}