/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { AttachmentDataWithStatus } from '../../../react/types/zotero';
import { deduplicateItems } from '../../utils/zoteroUtils';
import { syncingItemFilter } from '../../utils/sync';
import { searchableLibraryIdsAtom, syncWithZoteroAtom } from '../../../react/atoms/profile';
import { userIdAtom } from '../../../react/atoms/auth';

import { store } from '../../../react/store';
import { serializeAttachment, serializeItem } from '../../utils/zoteroSerializers';
import {
    WSItemSearchByMetadataRequest,
    WSItemSearchByMetadataResponse,
    ItemSearchFrontendResultItem,
} from '../agentProtocol';
import { searchItemsByMetadata, SearchItemsByMetadataOptions } from '../../../react/utils/searchTools';
import { computeItemStatus, getAttachmentFileStatus } from './utils';
import { getCollectionByIdOrName } from './utils';


/**
 * Handle item_search_by_metadata_request event.
 * Searches the user's Zotero library by metadata and returns matching items with attachments.
 * 
 * Algorithm:
 * 1. Validate: At least one query parameter must be provided
 * 2. Apply query matching (AND logic between different query types):
 *    - title_query: search title field (substring match)
 *    - author_query: search creator names
 *    - publication_query: search publication/journal name
 * 3. Apply filters to narrow results (year, type, libraries, tags, collections)
 * 4. Return items with attachments
 */
export async function handleItemSearchByMetadataRequest(
    request: WSItemSearchByMetadataRequest
): Promise<WSItemSearchByMetadataResponse> {
    // Validate: at least one query parameter must be provided
    const hasQuery = !!request.title_query ||
                     !!request.author_query ||
                     !!request.publication_query;

    if (!hasQuery) {
        logger('handleItemSearchByMetadataRequest: No query parameters provided', 1);
        return {
            type: 'item_search_by_metadata',
            request_id: request.request_id,
            items: [],
        };
    }

    // Get searchable library IDs (Pro: synced only, Free: all local)
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    
    // Apply libraries_filter if provided, but always intersect with searchable libraries
    const libraryIds: number[] = [];
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        // Convert library names/IDs to library IDs
        for (const libraryFilter of request.libraries_filter) {
            if (typeof libraryFilter === 'number') {
                // Only include if searchable
                if (searchableLibraryIds.includes(libraryFilter)) {
                    libraryIds.push(libraryFilter);
                }
            } else if (typeof libraryFilter === 'string') {
                // Could be a library ID as string or a library name
                const libraryIdNum = parseInt(libraryFilter, 10);
                if (!isNaN(libraryIdNum)) {
                    // It's a number as string - only include if searchable
                    if (searchableLibraryIds.includes(libraryIdNum)) {
                        libraryIds.push(libraryIdNum);
                    }
                } else {
                    // It's a library name - find matching searchable libraries
                    const allLibraries = Zotero.Libraries.getAll();
                    for (const lib of allLibraries) {
                        if (lib.name.toLowerCase().includes(libraryFilter.toLowerCase()) &&
                            searchableLibraryIds.includes(lib.libraryID)) {
                            libraryIds.push(lib.libraryID);
                        }
                    }
                }
            }
        }
    } else {
        libraryIds.push(...searchableLibraryIds);
    }

    // Guard: if libraries_filter was provided but resolved to no searchable libraries,
    // return empty results instead of potentially widening scope
    if (request.libraries_filter && request.libraries_filter.length > 0 && libraryIds.length === 0) {
        logger('handleItemSearchByMetadataRequest: libraries_filter resolved to no searchable libraries', 1);
        return {
            type: 'item_search_by_metadata',
            request_id: request.request_id,
            items: [],
        };
    }

    // Convert collections_filter names to keys if needed (scoped to libraryIds)
    const collectionKeysSet = new Set<string>();
    if (request.collections_filter && request.collections_filter.length > 0) {
        for (const collectionFilter of request.collections_filter) {
            if (typeof collectionFilter === 'number') {
                const collection = Zotero.Collections.get(collectionFilter);
                if (collection && (libraryIds.length === 0 || libraryIds.includes(collection.libraryID))) {
                    collectionKeysSet.add(collection.key);
                }
                continue;
            }

            // String filter: search within each library
            if (libraryIds.length > 0) {
                for (const libId of libraryIds) {
                    const collection = getCollectionByIdOrName(collectionFilter, libId);
                    if (collection) {
                        collectionKeysSet.add(collection.key);
                    }
                }
            } else {
                const collection = getCollectionByIdOrName(collectionFilter);
                if (collection) {
                    collectionKeysSet.add(collection.key);
                }
            }
        }
    }
    const collectionKeys = Array.from(collectionKeysSet);

    logger('handleItemSearchByMetadataRequest: Metadata search', {
        libraryIds,
        title_query: request.title_query,
        author_query: request.author_query,
        publication_query: request.publication_query,
    }, 1);

    // Collect unique items across all libraries
    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    // Search each library using searchItemsByMetadata
    for (const libraryId of libraryIds) {
        const options: SearchItemsByMetadataOptions = {
            title_query: request.title_query,
            author_query: request.author_query,
            publication_query: request.publication_query,
            year_min: request.year_min,
            year_max: request.year_max,
            item_type: request.item_type_filter,
            tags: request.tags_filter,
            collection_key: collectionKeys.length > 0 ? collectionKeys[0] : undefined,
            limit: request.limit,
            join_mode: 'all', // AND logic between query params
        };

        try {
            const results = await searchItemsByMetadata(libraryId, options);
            for (const item of results) {
                if (item.isRegularItem() && !item.deleted) {
                    const key = makeKey(item.libraryID, item.key);
                    if (!uniqueItems.has(key)) {
                        uniqueItems.set(key, item);
                    }
                }
            }
        } catch (error) {
            logger(`handleItemSearchByMetadataRequest: Error searching library ${libraryId}: ${error}`, 1);
        }

        // Early exit if we have enough results (fetch extra to account for cross-library duplicates)
        const preDedupBuffer = request.limit * 2;
        if (request.limit > 0 && uniqueItems.size >= preDedupBuffer) {
            break;
        }
    }

    // Convert to array
    let items = Array.from(uniqueItems.values());

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    items = deduplicateItems(items, 1);
    
    logger('handleItemSearchByMetadataRequest: Final items', {
        libraryIds,
        items: items.length,
    }, 1);

    // Apply offset and limit (offset defaults to 0 for backward compatibility)
    const offset = request.offset ?? 0;
    const offsetItems = offset > 0 ? items.slice(offset) : items;
    const limitedItems = request.limit > 0 ? offsetItems.slice(0, request.limit) : offsetItems;

    // Get sync configuration from store for status computation
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Step 3: Serialize items with attachments (using unified format)
    const resultItems: ItemSearchFrontendResultItem[] = [];
    
    // Load all item data in bulk for efficiency
    if (limitedItems.length > 0) {
        await Zotero.Items.loadDataTypes(limitedItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    for (const item of limitedItems) {
        try {
            const isValidItem = syncingItemFilter(item);
            if (!isValidItem) {
                continue;
            }
            // Serialize the item
            const itemData = await serializeItem(item, undefined);

            // Get and serialize attachments using unified format
            const attachmentIds = item.getAttachments();
            const attachments: AttachmentDataWithStatus[] = [];

            if (attachmentIds.length > 0) {
                const attachmentItems = await Zotero.Items.getAsync(attachmentIds);
                const primaryAttachment = await item.getBestAttachment();
                await Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData"]);

                for (const attachment of attachmentItems) {
                    const isValidAttachment = syncingItemFilter(attachment);
                    if (isValidAttachment) {
                        const attachmentData = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
                        if (attachmentData) {
                            // Compute sync status
                            const status = await computeItemStatus(attachment, searchableLibraryIds, syncWithZotero, userId);
                            
                            // Get file status for this attachment
                            const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
                            const fileStatus = await getAttachmentFileStatus(attachment, isPrimary);
                            
                            // Build unified attachment structure
                            attachments.push({
                                attachment: attachmentData,
                                status,
                                file_status: fileStatus,
                            });
                        }
                    }
                }
            }

            resultItems.push({
                item: itemData,
                attachments,
            });
        } catch (error) {
            logger(`handleItemSearchByMetadataRequest: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    const response: WSItemSearchByMetadataResponse = {
        type: 'item_search_by_metadata',
        request_id: request.request_id,
        items: resultItems,
    };

    return response;
}