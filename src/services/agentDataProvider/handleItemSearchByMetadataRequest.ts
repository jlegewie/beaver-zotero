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
    WSItemSearchByMetadataRequest,
    WSItemSearchByMetadataResponse,
    ItemSearchFrontendResultItem,
    FrontendTimingMetadata,
} from '@beaver/agent-core/protocol/agentProtocol';
import { searchItemsByMetadata, SearchItemsByMetadataOptions } from '../../../react/utils/searchTools';
import {
    getSearchableLibraryIds,
    prepareAttachmentInfoBatchData,
    processAttachmentInfoBatch,
    resolveCollectionFilters,
    resolveLibrariesFilterToSearchableIds,
} from './utils';
import { TimingAccumulator } from '../../utils/timing';


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
    
    // Validate: at least one query parameter or filter must be provided
    const hasQuery = !!request.title_query ||
                     !!request.author_query ||
                     !!request.publication_query;
    const hasFilter = !!(request.collections_filter?.length) ||
                      !!(request.tags_filter?.length) ||
                      !!(request.libraries_filter?.length) ||
                      !!request.year_min ||
                      !!request.year_max;

    if (!hasQuery && !hasFilter) {
        logger('handleItemSearchByMetadataRequest: No query parameters or filters provided', 1);
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

    // Apply libraries_filter if provided, but always intersect with searchable libraries.
    // Accepts portable library refs ("u"/"g<groupID>"), numeric IDs, numeric-ID
    // strings, and library name substrings.
    const libraryIds: number[] = request.libraries_filter && request.libraries_filter.length > 0
        ? resolveLibrariesFilterToSearchableIds(request.libraries_filter)
        : getSearchableLibraryIds();

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

    // Resolve collections_filter to (library, key) pairs within the searched
    // libraries. Every entry must resolve, so an unresolvable filter fails the
    // request instead of running a search the caller believes is scoped.
    const hasExplicitLibraries = !!(request.libraries_filter && request.libraries_filter.length > 0);
    const filterResolution = resolveCollectionFilters(request.collections_filter, {
        eligibleLibraryIds: libraryIds,
        explicitLibrary: hasExplicitLibraries,
    });
    if (!filterResolution.ok) {
        logger(`handleItemSearchByMetadataRequest: ${filterResolution.message}`, 1);
        return {
            type: 'item_search_by_metadata',
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

    const hasCollectionFilter = filterResolution.filters.length > 0;

    // Calculate offset for pagination (default 0, guard against negative values)
    const offset = Math.max(0, request.offset ?? 0);

    logger('handleItemSearchByMetadataRequest: Metadata search', {
        libraryIds,
        title_query: request.title_query,
        author_query: request.author_query,
        publication_query: request.publication_query,
        collections: hasCollectionFilter ? filterResolution.filters : 'all',
    }, 1);

    // Collect unique items across all searches
    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    // One search per (library, collection) pair, or one per library when no
    // collection was requested. Conditions are ANDed (`join_mode: 'all'`), so two
    // `collection` conditions would demand membership in both, and switching the
    // join mode to `any` would OR the metadata predicates too — neither expresses
    // `(collection A OR collection B) AND <predicates>`. The union of
    // per-collection searches does, and each search is bounded by its collection.
    // Searches are non-recursive, so the collection condition means direct
    // membership. Libraries holding none of the requested collections are not
    // searched.
    const searches: { libraryId: number; collectionKey?: string }[] = [];
    for (const libraryId of libraryIds) {
        if (!hasCollectionFilter) {
            searches.push({ libraryId });
            continue;
        }
        for (const filter of filterResolution.filters) {
            if (filter.libraryID === libraryId) searches.push({ libraryId, collectionKey: filter.key });
        }
    }

    // A collection-filtered page is assembled after the union, so its searches
    // cannot truncate at the page size; they take a generous cap instead of
    // running unbounded over a large collection. `limit: 0` means unlimited and
    // is passed through unchanged.
    const searchLimit = hasCollectionFilter && request.limit > 0
        ? Math.max((offset + request.limit) * 4, 100)
        : request.limit;

    for (const { libraryId, collectionKey } of searches) {
        const options: SearchItemsByMetadataOptions = {
            title_query: request.title_query,
            author_query: request.author_query,
            publication_query: request.publication_query,
            year_min: request.year_min,
            year_max: request.year_max,
            item_type: request.item_type_filter,
            tags: request.tags_filter,
            collection_key: collectionKey,
            limit: searchLimit,
            join_mode: 'all', // AND logic between query params
        };

        try {
            const results = await searchItemsByMetadata(libraryId, options);
            if (hasCollectionFilter && searchLimit > 0 && results.length >= searchLimit) {
                logger(`handleItemSearchByMetadataRequest: library ${libraryId} hit the ${searchLimit}-result cap; a deep page may be approximate`, 1);
            }
            for (const item of results) {
                if (!item.isRegularItem() || item.deleted) continue;
                const key = makeKey(item.libraryID, item.key);
                if (!uniqueItems.has(key)) {
                    uniqueItems.set(key, item);
                }
            }
        } catch (error) {
            logger(`handleItemSearchByMetadataRequest: Error searching library ${libraryId}: ${error}`, 1);
        }

        // Early exit if we have enough results (fetch extra to account for cross-library duplicates and pagination offset)
        const preDedupBuffer = (offset + request.limit) * 2;
        if (!hasCollectionFilter && request.limit > 0 && uniqueItems.size >= preDedupBuffer) {
            break;
        }
    }

    // Convert to array
    let items = Array.from(uniqueItems.values());

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    items = deduplicateItems(items, 1);

    // A page is a slice of this union in its natural order: libraries are
    // iterated in order, each search returns a stable prefix of its own results,
    // and both the union map and deduplication preserve insertion order.
    // Identical requests therefore return the same page, and a larger offset
    // extends the same prefixes rather than reordering them, so consecutive
    // pages neither overlap nor skip.

    // Timing accumulator for serialization breakdown
    const ta = new TimingAccumulator();

    // Record search completion time
    searchEndTime = Date.now();

    logger('handleItemSearchByMetadataRequest: Final items', {
        libraryIds,
        items: items.length,
    }, 1);

    // Serialize items in parallel in bounded batches (with backfill on failures to ensure limit is reached)
    const targetLimit = request.limit > 0 ? request.limit : items.length;
    // `agentItemFilter` only reads primary data, which the search already
    // loaded, so it can run before the heavier load below.
    const candidates = items.slice(offset).filter(item => agentItemFilter(item));
    // Only what the page can actually consume is loaded and prepared. A
    // collection-filtered search unions one search per (library, collection)
    // pair, so the union reaching this point can be several hundred items —
    // loading data types and attachment info for all of them would be
    // main-thread work the page never uses. The loop below stops at
    // `targetLimit` and reaches further only to backfill items that fail to
    // serialize, so twice the page is ample headroom.
    const workingSet = request.limit > 0 ? candidates.slice(0, targetLimit * 2) : candidates;
    const BATCH_SIZE = Math.min(targetLimit, 20);

    // Load item data needed for serialization (searchItemsByMetadata only loads itemData/creators/childItems)
    if (workingSet.length > 0) {
        await ta.track('data_loading_ms', () =>
            Zotero.Items.loadDataTypes(workingSet, ["primaryData", "tags", "collections", "relations", "childItems"])
        );
    }

    // Batch-fetch best attachments and sync dates for all candidate items
    const batchAttachmentData = await prepareAttachmentInfoBatchData(workingSet, ta);

    const resultItems: ItemSearchFrontendResultItem[] = [];
    for (let batchStart = 0; batchStart < workingSet.length && resultItems.length < targetLimit; batchStart += BATCH_SIZE) {
        const batch = workingSet.slice(batchStart, batchStart + BATCH_SIZE);

        const serialized = await Promise.all(
            batch.map(async (item): Promise<ItemSearchFrontendResultItem | null> => {
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
                    return { item: itemData, attachments };
                } catch (error) {
                    logger(`handleItemSearchByMetadataRequest: Failed to serialize item ${item.key}: ${error}`, 1);
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

    logger(`handleItemSearchByMetadataRequest: Returning ${resultItems.length} items, timing: ${JSON.stringify(timing)}`, 1);

    const response: WSItemSearchByMetadataResponse = {
        type: 'item_search_by_metadata',
        request_id: request.request_id,
        items: resultItems,
        timing,
    };

    return response;
}
