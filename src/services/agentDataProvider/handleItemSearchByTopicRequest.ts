/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { deduplicateItems } from '../../utils/zoteroUtils';
import { agentItemFilter } from '../../utils/agentItemSupport';
import { serializeItem } from '../../utils/zoteroSerializers';
import {
    WSItemSearchByTopicRequest,
    WSItemSearchByTopicResponse,
    ItemSearchFrontendResultItem,
    FrontendTimingMetadata,
} from '@beaver/agent-core/protocol/agentProtocol';
import { semanticSearchService, SearchResult } from '../semanticSearchService';
import { BeaverDB } from '../database';
import {
    getCollectionByIdOrName,
    getCollectionScopeItemIds,
    getSearchableLibraryIds,
    prepareAttachmentInfoBatchData,
    processAttachmentInfoBatch,
    resolveLibrariesFilterToSearchableIds,
} from '../agentDataProvider/utils';
import { TimingAccumulator } from '../../utils/timing';


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
    // Start timing
    const startTime = Date.now();
    let searchEndTime = 0;
    let serializationEndTime = 0;
    
    // Get database instance from global addon
    const db = Zotero.Beaver?.db as BeaverDB | null;
    if (!db) {
        logger('handleItemSearchByTopicRequest: Database not available', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Get searchable library IDs
    const searchableLibraryIds = getSearchableLibraryIds();
    if (searchableLibraryIds.length === 0) {
        logger('handleItemSearchByTopicRequest: no searchable libraries available', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }
    
    // Resolve library IDs from filter, but always intersect with searchable libraries.
    // Accepts portable library refs ("u"/"g<groupID>"), numeric IDs, numeric-ID
    // strings, and library name substrings.
    const libraryIds: number[] = request.libraries_filter && request.libraries_filter.length > 0
        ? resolveLibrariesFilterToSearchableIds(request.libraries_filter)
        : [...searchableLibraryIds];

    // Guard: if libraries_filter was provided but resolved to no searchable libraries,
    // return empty results instead of widening scope to all libraries
    if (request.libraries_filter && request.libraries_filter.length > 0 && libraryIds.length === 0) {
        logger('handleItemSearchByTopicRequest: libraries_filter resolved to no searchable libraries', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Resolve collections_filter to collection objects. Every resolution is
    // re-checked against libraryIds: a key-like filter resolves through a
    // cross-library fallback that can land outside the searchable set, and the
    // scope is read from Zotero before the embedding query narrows by library.
    const collectionsById = new Map<number, Zotero.Collection>();
    const addCollectionInScope = (collection: Zotero.Collection | null | undefined) => {
        if (collection && libraryIds.includes(collection.libraryID)) {
            collectionsById.set(collection.id, collection);
        }
    };
    if (request.collections_filter && request.collections_filter.length > 0) {
        for (const collectionFilter of request.collections_filter) {
            if (typeof collectionFilter === 'number') {
                addCollectionInScope(Zotero.Collections.get(collectionFilter));
                continue;
            }

            // String filter: search within each library
            for (const libId of libraryIds) {
                addCollectionInScope(getCollectionByIdOrName(collectionFilter, libId)?.collection);
            }
        }
    }

    // Resolve the collection scope to an item allowlist before ranking, so the
    // candidate pool isn't spent on items outside the requested collections.
    // An empty allowlist returns empty rather than widening scope: a filter that
    // resolves to nothing must narrow, not silently search the whole library.
    let collectionItemIds: number[] | undefined;
    if (request.collections_filter && request.collections_filter.length > 0) {
        collectionItemIds = await getCollectionScopeItemIds(Array.from(collectionsById.values()));
        if (collectionItemIds.length === 0) {
            logger(`handleItemSearchByTopicRequest: collections_filter resolved to ${collectionsById.size} collections holding no items`, 1);
            return {
                type: 'item_search_by_topic',
                request_id: request.request_id,
                items: [],
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }
    }

    logger('handleItemSearchByTopicRequest: Searching by topic', {
        topic_query: request.topic_query,
        libraryIds: libraryIds.length > 0 ? libraryIds : 'all',
        collectionItemIds: collectionItemIds ? collectionItemIds.length : 'all',
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
            libraryIds,
            itemIds: collectionItemIds,
        });
    } catch (error) {
        logger(`handleItemSearchByTopicRequest: Semantic search failed: ${error}`, 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
        };
    }
    
    // Record search completion time
    searchEndTime = Date.now();

    logger(`handleItemSearchByTopicRequest: Semantic search returned ${searchResults.length} results`, 1);

    if (searchResults.length === 0) {
        const timing: FrontendTimingMetadata = {
            total_ms: Date.now() - startTime,
            search_ms: searchEndTime - startTime,
            item_count: 0,
            attachment_count: 0,
        };
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing,
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
            timing: {
                total_ms: Date.now() - startTime,
                search_ms: searchEndTime - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Timing accumulator for serialization breakdown
    const ta = new TimingAccumulator();

    // Load item data (needed for deduplication which checks title, DOI, ISBN, creators)
    await ta.track('data_loading_ms', () =>
        Zotero.Items.loadDataTypes(validItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"])
    );

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

    // Apply filters first (before serialization)
    const filteredItems: { item: Zotero.Item; similarity: number }[] = [];

    for (const searchResult of searchResults) {
        const item = itemById.get(searchResult.itemId);
        if (!item) continue;

        // Apply filters
        // Year filter
        if (request.year_min || request.year_max) {
            const yearStr = item.getField('date', false, true);
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

        // Validate item is regular item and not in trash
        const isValidItem = agentItemFilter(item);
        if (!isValidItem) continue;

        filteredItems.push({
            item,
            similarity: searchResult.similarity,
        });
    }

    // Serialize items in parallel in bounded batches (with backfill on failures to ensure limit is reached)
    const targetLimit = request.limit > 0 ? request.limit : filteredItems.length;
    const candidates = filteredItems.slice(offset);
    const BATCH_SIZE = Math.min(targetLimit, 20);

    // Batch-fetch best attachments and sync dates for all candidate items
    const candidateItems = candidates.map(c => c.item);
    const batchAttachmentData = await prepareAttachmentInfoBatchData(candidateItems, ta);

    const resultItems: ItemSearchFrontendResultItem[] = [];
    for (let batchStart = 0; batchStart < candidates.length && resultItems.length < targetLimit; batchStart += BATCH_SIZE) {
        const batch = candidates.slice(batchStart, batchStart + BATCH_SIZE);

        const serialized = await Promise.all(
            batch.map(async ({ item, similarity }): Promise<ItemSearchFrontendResultItem | null> => {
                try {
                    const [itemData, attachments] = await Promise.all([
                        ta.track('item_serialization_ms', () => serializeItem(item, undefined, { skipHash: true })),
                        ta.track('attachment_processing_ms', () => processAttachmentInfoBatch(
                            item,
                            batchAttachmentData,
                            {
                                skipWorkerFallback: true,
                                timing: ta,
                                includeAnnotationsCount: true,
                            },
                        )),
                    ]);
                    return { item: itemData, attachments, similarity };
                } catch (error) {
                    logger(`handleItemSearchByTopicRequest: Failed to serialize item ${item.key}: ${error}`, 1);
                    return null;
                }
            })
        );

        for (const result of serialized) {
            if (result !== null) {
                resultItems.push(result);
                if (resultItems.length >= targetLimit) break;
            }
        }
    }

    // Record serialization completion time
    serializationEndTime = Date.now();

    // Calculate total attachment count
    const totalAttachments = resultItems.reduce((sum, item) => sum + item.attachments.length, 0);
    
    // Build timing metadata with serialization breakdown
    const timing: FrontendTimingMetadata = {
        total_ms: Date.now() - startTime,
        search_ms: searchEndTime - startTime,
        serialization_ms: serializationEndTime - searchEndTime,
        item_count: resultItems.length,
        attachment_count: totalAttachments,
        ...ta.getAll(),
    };

    logger(`handleItemSearchByTopicRequest: Returning ${resultItems.length} items (offset=${offset}, filtered=${filteredItems.length}), timing: ${JSON.stringify(timing)}`, 1);

    const response: WSItemSearchByTopicResponse = {
        type: 'item_search_by_topic',
        request_id: request.request_id,
        items: resultItems,
        timing,
    };

    return response;
}
