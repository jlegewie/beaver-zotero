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
import { serializeItemSearchRows } from './itemSearchSerialization';
import {
    WSItemSearchByMetadataRequest,
    WSItemSearchByMetadataResponse,
    ItemSearchFrontendResultItem,
    FrontendTimingMetadata,
} from '@beaver/agent-core/protocol/agentProtocol';
import { searchItemsByMetadata, SearchItemsByMetadataOptions } from '../../../react/utils/searchTools';
import {
    collectionsFilterError,
    getSearchableLibraryIds,
    librariesFilterError,
    resolveCollectionsFilter,
    resolveLibrariesFilter,
    resolveTagsFilter,
    tagsFilterError,
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
    const collectionsFilter = request.collections_filter ?? [];
    const hasFilter = collectionsFilter.length > 0 ||
                      !!(request.tags_filter?.length) ||
                      !!(request.libraries_filter?.length) ||
                      !!request.item_type_filter ||
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
    let libraryIds: number[] = getSearchableLibraryIds();
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        const resolution = resolveLibrariesFilter(request.libraries_filter);

        // A libraries_filter that resolves to nothing must narrow the search to no
        // results, never widen it to every library — and it is reported as an error
        // rather than an empty result so a bad library reference is not mistaken for
        // a library that holds no matching items.
        const filterError = librariesFilterError(resolution);
        if (filterError) {
            logger(`handleItemSearchByMetadataRequest: ${filterError.message}`, 1);
            return {
                type: 'item_search_by_metadata',
                request_id: request.request_id,
                items: [],
                error: filterError.message,
                error_code: filterError.error_code,
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        libraryIds = resolution.libraryIds;
    }

    // Resolve collections_filter to collection keys, bucketed by library.
    // Keys must stay library-scoped: a Zotero search scoped to library B that is
    // given a collection key from library A matches nothing, so a shared collection
    // name (e.g. "Papers") in two libraries would silently empty out both searches.
    const collectionKeysByLibrary = new Map<number, Set<string>>();
    const hasCollectionsFilter = collectionsFilter.length > 0;
    if (hasCollectionsFilter) {
        const resolution = resolveCollectionsFilter(collectionsFilter, libraryIds);

        // A collections_filter that resolves to nothing must narrow the search to
        // no results, never widen it to the whole library — and it is reported as
        // an error rather than an empty result so a bad collection reference is
        // not mistaken for a collection that holds no matching items.
        const filterError = collectionsFilterError(resolution);
        if (filterError) {
            logger(`handleItemSearchByMetadataRequest: ${filterError.message}`, 1);
            return {
                type: 'item_search_by_metadata',
                request_id: request.request_id,
                items: [],
                error: filterError.message,
                error_code: filterError.error_code,
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        for (const collection of resolution.collections) {
            let keys = collectionKeysByLibrary.get(collection.libraryID);
            if (!keys) {
                keys = new Set<string>();
                collectionKeysByLibrary.set(collection.libraryID, keys);
            }
            keys.add(collection.key);
        }
    }

    // Resolve tags_filter to the tag names Zotero stores. Rewriting the filter is
    // what makes it work at all: the Zotero search matches tags case-sensitively,
    // so a differently cased entry would silently match nothing.
    const tagsFilter = request.tags_filter ?? [];
    let tagNames: string[] | undefined;
    if (tagsFilter.length > 0) {
        const resolution = await resolveTagsFilter(tagsFilter, libraryIds);

        // A tag the library doesn't have is reported as an error rather than an
        // empty result, so the model can tell a misspelled tag from a real tag
        // that carries no matching item.
        const filterError = tagsFilterError(resolution);
        if (filterError) {
            logger(`handleItemSearchByMetadataRequest: ${filterError.message}`, 1);
            return {
                type: 'item_search_by_metadata',
                request_id: request.request_id,
                items: [],
                error: filterError.message,
                error_code: filterError.error_code,
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        // A tags_filter must narrow the search, never drop off it: when nothing
        // resolved and no error explained why (no library in scope), return no
        // results instead of searching as if no tag had been requested.
        if (resolution.tags.length === 0) {
            logger('handleItemSearchByMetadataRequest: tags_filter resolved to no tags', 1);
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

        tagNames = resolution.tags;
    }

    // Calculate offset for pagination (default 0, guard against negative values)
    const offset = Math.max(0, request.offset ?? 0);

    // Per-library search limit. Deduplication runs before the page slice and
    // agentItemFilter after it, so each search has to over-fetch to fill a page of
    // `limit` items at `offset`. Every library is searched with this budget before the
    // union is deduplicated and sliced — stopping early would both hide libraries and
    // rob deduplication of the copies it prefers.
    // A non-positive limit means unlimited and is passed through as-is.
    //
    // The cap bounds pagination depth, because every fetched row costs data loading and
    // each page re-fetches the whole prefix. It deliberately ends pagination rather than
    // scaling with an arbitrary offset: with a single library, a page straddling the cap
    // comes back short and anything beyond it empty, which the model reads as the end of
    // the results. With several libraries, offsets past the cap keep paging through the
    // later libraries and a library with more than `MAX_ROWS_PER_LIBRARY` matches loses
    // its tail — reaching that needs 40+ pages at the largest allowed limit. Raising the
    // cap trades a rarely reached depth for a much slower worst case.
    const MAX_ROWS_PER_LIBRARY = 1000;
    const perLibraryLimit = request.limit > 0
        ? Math.min((offset + request.limit) * 2, MAX_ROWS_PER_LIBRARY)
        : request.limit;

    logger('handleItemSearchByMetadataRequest: Metadata search', {
        libraryIds,
        title_query: request.title_query,
        author_query: request.author_query,
        publication_query: request.publication_query,
    }, 1);

    // Collect unique items across all libraries
    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    let searchedLibraries = 0;
    let failedLibraries = 0;

    // Search each library using searchItemsByMetadata
    for (const libraryId of libraryIds) {
        const collectionKeys = collectionKeysByLibrary.get(libraryId);

        // A collection-scoped request must not fall back to a library-wide search
        // in libraries where no collection resolved.
        if (hasCollectionsFilter && !collectionKeys?.size) continue;

        const options: SearchItemsByMetadataOptions = {
            title_query: request.title_query,
            author_query: request.author_query,
            publication_query: request.publication_query,
            year_min: request.year_min,
            year_max: request.year_max,
            item_type: request.item_type_filter,
            tags: tagNames,
            collection_keys: collectionKeys ? Array.from(collectionKeys) : undefined,
            limit: perLibraryLimit,
        };

        searchedLibraries++;
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
            failedLibraries++;
            logger(`handleItemSearchByMetadataRequest: Error searching library ${libraryId}: ${error}`, 1);
        }
    }

    // A search that failed everywhere is reported as an error rather than an empty
    // result: "no matches" is an answer the model acts on and stops looking, so a
    // broken search must not be indistinguishable from an empty library. A partial
    // failure still returns the libraries that answered — dropping good results
    // because one library faulted is the worse trade.
    if (failedLibraries > 0 && failedLibraries === searchedLibraries) {
        return {
            type: 'item_search_by_metadata',
            request_id: request.request_id,
            items: [],
            error: 'Searching the Zotero library failed. Please try again.',
            error_code: 'internal_error',
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Convert to array
    let items = Array.from(uniqueItems.values());

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    items = deduplicateItems(items, 1);

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
    const candidates = items.slice(offset).filter(item => agentItemFilter(item));

    const resultItems = await serializeItemSearchRows(
        candidates,
        targetLimit,
        ta,
        'handleItemSearchByMetadataRequest',
    );

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
