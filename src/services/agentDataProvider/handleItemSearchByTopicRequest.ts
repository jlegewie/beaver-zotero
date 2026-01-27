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
    WSItemSearchByTopicRequest,
    WSItemSearchByTopicResponse,
    ItemSearchFrontendResultItem,
} from '../agentProtocol';
import { semanticSearchService, SearchResult } from '../semanticSearchService';
import { BeaverDB } from '../database';
import { getCollectionByIdOrName, processAttachmentsParallel } from '../agentDataProvider/utils';


/**
 * Handle item_search_by_topic_request event.
 * Searches the user's Zotero library by topic using semantic search and returns matching items.
 * 
 * Algorithm:
 * 1. Use semantic search service to find items by topic similarity
 * 2. Apply filters (year, libraries, etc.)
 * 3. Serialize items with attachments and similarity scores
 * 4. Return items sorted by similarity
 */
export async function handleItemSearchByTopicRequest(
    request: WSItemSearchByTopicRequest
): Promise<WSItemSearchByTopicResponse> {
    // Get database instance from global addon
    const db = Zotero.Beaver?.db as BeaverDB | null;
    if (!db) {
        logger('handleItemSearchByTopicRequest: Database not available', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    // Get searchable library IDs
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    
    // Resolve library IDs from filter, but always intersect with searchable libraries
    const libraryIds: number[] = [];
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        for (const libraryFilter of request.libraries_filter) {
            if (typeof libraryFilter === 'number') {
                // Only include if searchable
                if (searchableLibraryIds.includes(libraryFilter)) {
                    libraryIds.push(libraryFilter);
                }
            } else if (typeof libraryFilter === 'string') {
                const libraryIdNum = parseInt(libraryFilter, 10);
                if (!isNaN(libraryIdNum)) {
                    // Only include if searchable
                    if (searchableLibraryIds.includes(libraryIdNum)) {
                        libraryIds.push(libraryIdNum);
                    }
                } else {
                    // Library name lookup - only include searchable libraries
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
        // Default to searchable libraries if no filter provided
        libraryIds.push(...searchableLibraryIds);
    }

    // Guard: if libraries_filter was provided but resolved to no searchable libraries,
    // return empty results instead of widening scope to all libraries
    if (request.libraries_filter && request.libraries_filter.length > 0 && libraryIds.length === 0) {
        logger('handleItemSearchByTopicRequest: libraries_filter resolved to no searchable libraries', 1);
        return {
            type: 'item_search_by_topic',
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

    logger('handleItemSearchByTopicRequest: Searching by topic', {
        topic_query: request.topic_query,
        libraryIds: libraryIds.length > 0 ? libraryIds : 'all',
        collectionKeys: collectionKeys.length > 0 ? collectionKeys : 'all',
        limit: request.limit,
    }, 1);

    // Create search service and run semantic search
    const searchService = new semanticSearchService(db, 512);

    // Calculate offset for pagination (default 0, guard against negative values)
    const offset = Math.max(0, request.offset ?? 0);

    let searchResults: SearchResult[];
    try {
        searchResults = await searchService.search(request.topic_query, {
            topK: (offset + request.limit) * 4, // Fetch extra to account for filtering and pagination offset
            minSimilarity: 0.3,
            libraryIds: libraryIds.length > 0 ? libraryIds : undefined,
        });
    } catch (error) {
        logger(`handleItemSearchByTopicRequest: Semantic search failed: ${error}`, 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    logger(`handleItemSearchByTopicRequest: Semantic search returned ${searchResults.length} results`, 1);

    if (searchResults.length === 0) {
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    // Load items from search results
    const itemIds = searchResults.map(r => r.itemId);
    const items = await Zotero.Items.getAsync(itemIds);
    let validItems = items.filter((item): item is Zotero.Item => item !== null);

    if (validItems.length === 0) {
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }

    // Load item data (needed for deduplication which checks title, DOI, ISBN, creators)
    await Zotero.Items.loadDataTypes(validItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    validItems = deduplicateItems(validItems, 1);
    const deduplicatedItemIds = new Set(validItems.map(item => item.id));
    
    // Create a map for item lookup by ID
    const itemById = new Map<number, Zotero.Item>();
    for (const item of validItems) {
        itemById.set(item.id, item);
    }
    
    // Filter searchResults to only include items that survived deduplication
    searchResults = searchResults.filter(result => deduplicatedItemIds.has(result.itemId));

    // Create similarity map
    const similarityByItemId = new Map<number, number>();
    for (const result of searchResults) {
        similarityByItemId.set(result.itemId, result.similarity);
    }

    // Get sync configuration from store for status computation
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);
    const attachmentContext = {
        searchableLibraryIds,
        syncWithZotero,
        userId,
    };

    // Serialize items with attachments and similarity
    const resultItems: ItemSearchFrontendResultItem[] = [];

    for (const searchResult of searchResults) {
        const item = itemById.get(searchResult.itemId);
        if (!item) continue;

        // Apply filters
        // Year filter
        if (request.year_min || request.year_max) {
            const yearStr = item.getField('date');
            const yearMatch = yearStr ? String(yearStr).match(/\d{4}/) : null;
            const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
            
            if (year) {
                if (request.year_min && year < request.year_min) continue;
                if (request.year_max && year > request.year_max) continue;
            }
        }

        // Author filter
        if (request.author_filter && request.author_filter.length > 0) {
            const creators = item.getCreators();
            const creatorLastNames = creators.map(c => (c.lastName || '').toLowerCase());
            const matchesAuthor = request.author_filter.some(authorName => 
                creatorLastNames.some(lastName => lastName.includes(authorName.toLowerCase()))
            );
            if (!matchesAuthor) continue;
        }

        // Tags filter
        if (request.tags_filter && request.tags_filter.length > 0) {
            const itemTags = item.getTags().map(t => t.tag.toLowerCase());
            const matchesTag = request.tags_filter.some(tag => 
                itemTags.includes(tag.toLowerCase())
            );
            if (!matchesTag) continue;
        }

        // Collections filter
        if (collectionKeys.length > 0) {
            const itemCollections = item.getCollections();
            const itemCollectionKeys = itemCollections.map(collectionId => {
                const collection = Zotero.Collections.get(collectionId);
                return collection ? collection.key : null;
            }).filter((key): key is string => key !== null);
            
            const matchesCollection = collectionKeys.some(key => 
                itemCollectionKeys.includes(key)
            );
            if (!matchesCollection) continue;
        }

        // Validate item is regular item and not in trash
        const isValidItem = syncingItemFilter(item);
        if (!isValidItem) continue;

        try {
            // Serialize item and process attachments in parallel
            const [itemData, attachments] = await Promise.all([
                serializeItem(item, undefined),
                processAttachmentsParallel(item, attachmentContext)
            ]);

            resultItems.push({
                item: itemData,
                attachments,
                similarity: searchResult.similarity,
            });
        } catch (error) {
            logger(`handleItemSearchByTopicRequest: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    // Apply offset and limit (offset calculated earlier with guard against negative values)
    const offsetItems = offset > 0 ? resultItems.slice(offset) : resultItems;
    const limitedItems = request.limit > 0 ? offsetItems.slice(0, request.limit) : offsetItems;

    logger(`handleItemSearchByTopicRequest: Returning ${limitedItems.length} items (offset=${offset})`, 1);

    const response: WSItemSearchByTopicResponse = {
        type: 'item_search_by_topic',
        request_id: request.request_id,
        items: limitedItems,
    };

    return response;
}