/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { ItemDataWithStatus, AttachmentDataWithStatus } from '../../../react/types/zotero';
import { searchableLibraryIdsAtom, syncWithZoteroAtom } from '../../../react/atoms/profile';
import { userIdAtom } from '../../../react/atoms/auth';
import { store } from '../../../react/store';
import { serializeAttachment, serializeItem } from '../../utils/zoteroSerializers';
import { computeItemStatus, getAttachmentFileStatus, getAttachmentFileStatusLightweight } from './utils';
import {
    WSZoteroDataRequest,
    WSZoteroDataResponse,
    WSDataError,
} from '../agentProtocol';


/**
 * Handle zotero_data_request event.
 * Fetches item/attachment metadata for the requested references.
 */
export async function handleZoteroDataRequest(request: WSZoteroDataRequest): Promise<WSZoteroDataResponse> {
    const errors: WSDataError[] = [];

    // Get sync configuration from store
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Track keys to avoid duplicates when including parents/attachments
    const itemKeys = new Set<string>();
    const attachmentKeys = new Set<string>();

    // Collect Zotero items to serialize
    const itemsToSerialize: Zotero.Item[] = [];
    const attachmentsToSerialize: Zotero.Item[] = [];

    const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

    // Phase 1: Collect primary items from request IN PARALLEL
    const primaryItems: Zotero.Item[] = [];
    const referenceToItem = new Map<string, Zotero.Item>();
    
    const loadResults = await Promise.all(
        request.items.map(async (reference) => {
            try {
                const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                if (!zoteroItem) {
                    return { reference, error: 'Item not found in local database', error_code: 'not_found' as const };
                }
                return { reference, item: zoteroItem };
            } catch (error: any) {
                logger(`AgentService: Failed to load zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
                const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
                return { reference, error: 'Failed to load item', error_code: 'load_failed' as const, details };
            }
        })
    );
    
    // Process results, preserving order
    for (const result of loadResults) {
        if ('item' in result && result.item) {
            primaryItems.push(result.item);
            referenceToItem.set(makeKey(result.reference.library_id, result.reference.zotero_key), result.item);
        } else if ('error' in result) {
            errors.push({
                reference: result.reference,
                error: result.error,
                error_code: result.error_code,
                details: result.details
            });
        }
    }

    // Phase 2: Load data types for primary items BEFORE accessing parentID/getAttachments
    if (primaryItems.length > 0) {
        await Zotero.Items.loadDataTypes(primaryItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    // Phase 3: Collect all parent/attachment IDs first, then batch load
    const parentIdsToLoad = new Set<number>();
    const attachmentIdsToLoad = new Set<number>();
    
    // First pass: collect IDs and categorize items
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue;

        try {
            if (zoteroItem.isAttachment()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!attachmentKeys.has(key)) {
                    attachmentKeys.add(key);
                    attachmentsToSerialize.push(zoteroItem);
                }
                // Collect parent ID for batch loading
                if (request.include_parents && zoteroItem.parentID) {
                    parentIdsToLoad.add(zoteroItem.parentID);
                }
            } else if (zoteroItem.isRegularItem()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!itemKeys.has(key)) {
                    itemKeys.add(key);
                    itemsToSerialize.push(zoteroItem);
                }
                // Collect attachment IDs for batch loading
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        attachmentIdsToLoad.add(attachmentId);
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
            logger(`AgentService: Failed to categorize zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed',
                details
            });
        }
    }
    
    // Batch load parents and attachments in parallel
    const [parentItemsArray, attachmentItemsArray] = await Promise.all([
        parentIdsToLoad.size > 0 ? Zotero.Items.getAsync([...parentIdsToLoad]) : Promise.resolve([]),
        attachmentIdsToLoad.size > 0 ? Zotero.Items.getAsync([...attachmentIdsToLoad]) : Promise.resolve([])
    ]);
    
    // Create lookup maps
    const parentItemsById = new Map<number, Zotero.Item>();
    for (const item of parentItemsArray) {
        if (item) parentItemsById.set(item.id, item);
    }
    
    const attachmentItemsById = new Map<number, Zotero.Item>();
    for (const item of attachmentItemsArray) {
        if (item) attachmentItemsById.set(item.id, item);
    }
    
    // Second pass: add parents and attachments using the pre-loaded items
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue;

        try {
            if (zoteroItem.isAttachment()) {
                // Add parent item if requested (using pre-loaded data)
                if (request.include_parents && zoteroItem.parentID) {
                    const parentItem = parentItemsById.get(zoteroItem.parentID);
                    if (parentItem && !parentItem.isAttachment()) {
                        const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                        if (!itemKeys.has(parentKey)) {
                            itemKeys.add(parentKey);
                            itemsToSerialize.push(parentItem);
                        }
                    }
                }
            } else if (zoteroItem.isRegularItem()) {
                // Add attachments if requested (using pre-loaded data)
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        const attachment = attachmentItemsById.get(attachmentId);
                        if (attachment) {
                            const attKey = makeKey(attachment.libraryID, attachment.key);
                            if (!attachmentKeys.has(attKey)) {
                                attachmentKeys.add(attKey);
                                attachmentsToSerialize.push(attachment);
                            }
                        }
                    }
                }
            }
        } catch (error: any) {
            logger(`AgentService: Failed to expand zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed',
                details
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

    // Phase 5: Pre-compute primary attachments per parent (cache getBestAttachment)
    const primaryAttachmentByParentId = new Map<number, Zotero.Item | false>();
    const parentIdsForPrimaryCheck = [...new Set(
        attachmentsToSerialize
            .filter(att => att.parentID)
            .map(att => att.parentID as number)
    )];
    
    // Batch load parent items and their best attachments
    if (parentIdsForPrimaryCheck.length > 0) {
        const parentsForCheck = await Zotero.Items.getAsync(parentIdsForPrimaryCheck);
        await Promise.all(
            parentsForCheck.map(async (parentItem) => {
                if (parentItem) {
                    const bestAttachment = await parentItem.getBestAttachment();
                    primaryAttachmentByParentId.set(parentItem.id, bestAttachment || false);
                }
            })
        );
    }

    // Phase 6: Serialize all items and attachments with status
    // Determine file status level from request (default to 'lightweight' for backward compatibility)
    const fileStatusLevel = request.file_status_level ?? 'lightweight';
    
    const [itemResults, attachmentResults] = await Promise.all([
        Promise.all(itemsToSerialize.map(async (item): Promise<ItemDataWithStatus | null> => {
            const serialized = await serializeItem(item, undefined);
            const status = await computeItemStatus(item, searchableLibraryIds, syncWithZotero, userId);
            return { item: serialized, status };
        })),
        Promise.all(attachmentsToSerialize.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
            const serialized = await serializeAttachment(attachment, undefined, { skipFileHash: true, skipSyncingFilter: true });
            if (!serialized) {
                errors.push({
                    reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                    error: 'Attachment not available locally',
                    error_code: 'not_available'
                });
                return null;
            }
            const status = await computeItemStatus(attachment, searchableLibraryIds, syncWithZotero, userId);
            
            // Determine if this is the primary attachment for its parent (using cached data)
            let isPrimary = false;
            if (attachment.parentID) {
                const primaryAttachment = primaryAttachmentByParentId.get(attachment.parentID);
                isPrimary = primaryAttachment !== false && primaryAttachment !== undefined && attachment.id === primaryAttachment.id;
            }
            
            // Get file status based on requested level
            // - 'none': skip file status entirely (fastest, for metadata-only lookups)
            // - 'lightweight': fast checks without reading full PDF (default)
            // - 'full': full analysis including OCR detection (slowest)
            let fileStatus = undefined;
            if (fileStatusLevel === 'full') {
                fileStatus = await getAttachmentFileStatus(attachment, isPrimary);
            } else if (fileStatusLevel === 'lightweight') {
                fileStatus = await getAttachmentFileStatusLightweight(attachment, isPrimary);
            }
            // else: fileStatusLevel === 'none', skip file status
            
            return { attachment: serialized, status, file_status: fileStatus };
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