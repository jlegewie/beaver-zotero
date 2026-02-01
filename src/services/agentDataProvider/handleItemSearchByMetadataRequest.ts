/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { deduplicateItems } from '../../utils/zoteroUtils';
import { syncingItemFilter } from '../../utils/sync';
import { searchableLibraryIdsAtom, syncWithZoteroAtom } from '../../../react/atoms/profile';
import { userIdAtom } from '../../../react/atoms/auth';

import { store } from '../../../react/store';
import { serializeItem } from '../../utils/zoteroSerializers';
import {
    WSItemSearchByMetadataRequest,
    WSItemSearchByMetadataResponse,
    ItemSearchFrontendResultItem,
    FrontendTimingMetadata,
} from '../agentProtocol';
import { searchItemsByMetadata, SearchItemsByMetadataOptions } from '../../../react/utils/searchTools';
import { getCollectionByIdOrName, processAttachmentsParallel } from './utils';


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
    // Start timing
    const startTime = Date.now();
    let searchEndTime = 0;
    let serializationEndTime = 0;
    
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
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
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
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
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

    // Calculate offset for pagination (default 0, guard against negative values)
    const offset = Math.max(0, request.offset ?? 0);

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

        // Early exit if we have enough results (fetch extra to account for cross-library duplicates and pagination offset)
        const preDedupBuffer = (offset + request.limit) * 2;
        if (request.limit > 0 && uniqueItems.size >= preDedupBuffer) {
            break;
        }
    }

    // Convert to array
    let items = Array.from(uniqueItems.values());

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    items = deduplicateItems(items, 1);
    
    // Record search completion time
    searchEndTime = Date.now();
    
    logger('handleItemSearchByMetadataRequest: Final items', {
        libraryIds,
        items: items.length,
    }, 1);

    // Get sync configuration from store for status computation
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);
    const attachmentContext = {
        searchableLibraryIds,
        syncWithZotero,
        userId,
    };

    // Serialize items with backfill on failures to ensure limit is reached
    const resultItems: ItemSearchFrontendResultItem[] = [];
    const targetLimit = request.limit > 0 ? request.limit : items.length;

    for (let i = offset; i < items.length && resultItems.length < targetLimit; i++) {
        const item = items[i];

        try {
            const isValidItem = syncingItemFilter(item);
            if (!isValidItem) {
                continue;
            }
            // Serialize the item and process attachments in parallel
            const [itemData, attachments] = await Promise.all([
                serializeItem(item, undefined),
                processAttachmentsParallel(item, attachmentContext)
            ]);

            resultItems.push({
                item: itemData,
                attachments,
            });
        } catch (error) {
            logger(`handleItemSearchByMetadataRequest: Failed to serialize item ${item.key}: ${error}`, 1);
            // Continue to next item to backfill
        }
    }
    
    // Record serialization completion time
    serializationEndTime = Date.now();
    
    // Calculate total attachment count
    const totalAttachments = resultItems.reduce((sum, item) => sum + item.attachments.length, 0);
    
    // Build timing metadata
    const timing: FrontendTimingMetadata = {
        total_ms: Date.now() - startTime,
        search_ms: searchEndTime - startTime,
        serialization_ms: serializationEndTime - searchEndTime,
        item_count: resultItems.length,
        attachment_count: totalAttachments,
    };

    logger(`handleItemSearchByMetadataRequest: Returning ${resultItems.length} items, timing: ${JSON.stringify(timing)}`, 1);

    const response: WSItemSearchByMetadataResponse = {
        type: 'item_search_by_metadata',
        request_id: request.request_id,
        items: resultItems,
        timing,
    };

    return response;
}