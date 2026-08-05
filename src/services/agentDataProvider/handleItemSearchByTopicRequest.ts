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
    collectionFilterKey,
    getSearchableLibraryIds,
    prepareAttachmentInfoBatchData,
    processAttachmentInfoBatch,
    resolveCollectionFilters,
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

    // Resolve collections_filter to (library, key) pairs within the searched
    // libraries. Every entry must resolve, so an unresolvable filter fails the
    // request instead of running a search the caller believes is scoped.
    const hasExplicitLibraries = !!(request.libraries_filter && request.libraries_filter.length > 0);
    const filterResolution = resolveCollectionFilters(request.collections_filter, {
        eligibleLibraryIds: libraryIds,
        explicitLibrary: hasExplicitLibraries,
    });
    if (!filterResolution.ok) {
        logger(`handleItemSearchByTopicRequest: ${filterResolution.message}`, 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            error: filterResolution.message,
            error_code: filterResolution.code,
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }
    const collectionFilterKeys = new Set(
        filterResolution.filters.map(filter => collectionFilterKey(filter.libraryID, filter.key))
    );

    logger('handleItemSearchByTopicRequest: Searching by topic', {
        topic_query: request.topic_query,
        libraryIds: libraryIds.length > 0 ? libraryIds : 'all',
        collections: filterResolution.filters.length > 0 ? filterResolution.filters : 'all',
        limit: request.limit,
    }, 1);

    // Create search service and run semantic search
    const searchService = new semanticSearchService(db, 512);

    // Calculate offset for pagination (default 0, guard against negative values)
    const offset = Math.max(0, request.offset ?? 0);

    // Timing accumulator for serialization breakdown
    const ta = new TimingAccumulator();

    /** Every request filter. Collection membership matches on (library, key). */
    const passesFilters = (item: Zotero.Item): boolean => {
        // Year filter
        if (request.year_min || request.year_max) {
            const yearStr = item.getField('date', false, true);
            const yearMatch = yearStr ? String(yearStr).match(/\d{4}/) : null;
            const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

            if (year) {
                if (request.year_min && year < request.year_min) return false;
                if (request.year_max && year > request.year_max) return false;
            }
        }

        // Author filter
        if (request.author_filter && request.author_filter.length > 0) {
            const creators = item.getCreators();
            const creatorLastNames = creators.map(c => (c.lastName || '').toLowerCase());
            const matchesAuthor = request.author_filter.some(authorName =>
                creatorLastNames.some(lastName => lastName.includes(authorName.toLowerCase()))
            );
            if (!matchesAuthor) return false;
        }

        // Tags filter
        if (request.tags_filter && request.tags_filter.length > 0) {
            const itemTags = item.getTags().map(t => t.tag.toLowerCase());
            const matchesTag = request.tags_filter.some(tag =>
                itemTags.includes(tag.toLowerCase())
            );
            if (!matchesTag) return false;
        }

        // Collections filter
        if (collectionFilterKeys.size > 0) {
            const inRequestedCollection = item.getCollections().some(collectionId => {
                const collection = Zotero.Collections.get(collectionId);
                return !!collection
                    && collectionFilterKeys.has(collectionFilterKey(collection.libraryID, collection.key));
            });
            if (!inRequestedCollection) return false;
        }

        // Validate item is regular item and not in trash
        return agentItemFilter(item);
    };

    /** Accumulated candidates that passed the filters, best match first. */
    const similarityByItemId = new Map<number, number>();
    const matchedItems: Zotero.Item[] = [];

    /**
     * Load and filter one window of candidates, appending it to the accumulators.
     *
     * Filters run before deduplication so a duplicate that fails a filter can
     * never displace the copy that passes it — most visibly, a personal-library
     * twin outside the requested collections displacing the item inside them.
     */
    const addCandidateWindow = async (candidates: SearchResult[]): Promise<void> => {
        const items = await Zotero.Items.getAsync(candidates.map(result => result.itemId));
        const validItems = items.filter((item): item is Zotero.Item => item !== null);
        if (validItems.length === 0) return;

        // Load item data (needed for the filters and for deduplication, which
        // checks title, DOI, ISBN and creators)
        await ta.track('data_loading_ms', () =>
            Zotero.Items.loadDataTypes(validItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"])
        );

        const itemById = new Map<number, Zotero.Item>();
        for (const item of validItems) {
            itemById.set(item.id, item);
        }

        for (const searchResult of candidates) {
            const item = itemById.get(searchResult.itemId);
            if (!item || similarityByItemId.has(item.id)) continue;
            if (!passesFilters(item)) continue;
            similarityByItemId.set(item.id, searchResult.similarity);
            matchedItems.push(item);
        }
    };

    // Only the similarity scoring is topK-independent: it scores every embedding
    // in the searched libraries either way. The trash filter that follows loads
    // topK * 2 items, so a deeper ranking costs more item loads on the main
    // thread. A collection filter can leave its matches far down the ranking, so
    // it takes a ranking deep enough to reach them while keeping that load
    // bounded.
    const COLLECTION_FILTER_TOP_K = 500;
    const topK = collectionFilterKeys.size > 0
        ? COLLECTION_FILTER_TOP_K
        : (offset + request.limit) * 4; // Fetch extra to account for filtering and pagination offset

    let searchResults: SearchResult[];
    try {
        searchResults = await searchService.search(request.topic_query, {
            topK,
            minSimilarity: 0.3,
            libraryIds,
        });
    } catch (error) {
        const message = `Semantic search failed: ${error}`;
        logger(`handleItemSearchByTopicRequest: ${message}`, 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            error: message,
            error_code: 'internal_error',
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    logger(`handleItemSearchByTopicRequest: Semantic search returned ${searchResults.length} results (topK=${topK})`, 1);

    // Loading items is the expensive part, so the ranking is walked in windows
    // and widened only while the page is still short. Deduplication runs over
    // every candidate seen so far, so a later window cannot reintroduce an item
    // an earlier one dropped. Each window costs a round trip, so a
    // collection-filtered walk — which can cross long stretches of the ranking
    // that hold no match — takes a floor rather than a page-sized window.
    const pageWindow = (offset + request.limit) * 4;
    const windowSize = request.limit > 0
        ? (collectionFilterKeys.size > 0 ? Math.max(pageWindow, 200) : pageWindow)
        : searchResults.length;
    let filteredItems: { item: Zotero.Item; similarity: number }[] = [];
    for (let processed = 0; processed < searchResults.length; processed += windowSize) {
        await addCandidateWindow(searchResults.slice(processed, processed + windowSize));

        // Deduplication keeps the first-seen position, so a survivor can score
        // below the entry after it. Results are ranked by list order, so sort by
        // the similarity each survivor reports.
        filteredItems = deduplicateItems(matchedItems, 1)
            .map(item => ({ item, similarity: similarityByItemId.get(item.id) ?? 0 }))
            .sort((a, b) => b.similarity - a.similarity || a.item.id - b.item.id);

        if (request.limit > 0 && filteredItems.length >= offset + request.limit) break;
    }

    // Record search completion time
    searchEndTime = Date.now();

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
