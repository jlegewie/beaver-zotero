/**
 * Quick search over the user's Zotero library.
 *
 * One raw string, ORed across title-like fields, creators and the year — the
 * semantics of Zotero's own item picker, and the shape a source picker needs.
 * `item_search_by_metadata` is the fielded counterpart, whose title/author/
 * publication queries are ANDed.
 *
 * The projection is a parameter rather than a second op: a picker wants a lean
 * row it can draw, an agent wants the full item plus attachments, and both must
 * agree on what "matches" means and in what order.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSItemQuickSearchRequest,
    WSItemQuickSearchResponse,
    ItemSearchFrontendResultItem,
    QuickSearchDetail,
    QuickSearchHit,
    FrontendTimingMetadata,
} from '@beaver/agent-core/protocol/agentProtocol';
import { deduplicateItems } from '../../utils/zoteroUtils';
import { agentItemFilter } from '../../utils/agentItemSupport';
import { quickSearchItems, QuickSearchItemsOptions } from '../librarySearch/quickSearch';
import { scoreSearchResult } from '../librarySearch/ranking';
import { serializeItemSearchRows, toQuickSearchHit } from './itemSearchSerialization';
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

/** Applied when the request omits `limit`. */
const DEFAULT_LIMIT = 20;

/** Upper bound on `limit`, matching the backend's own cap. */
const MAX_LIMIT = 50;

/**
 * Total candidates ranked per request, across every library in scope.
 *
 * The budget is global rather than per-library because the work that follows it
 * is global: loading each candidate's fields and creators, and above all
 * deduplication, whose cost grows faster than linearly in the size of the
 * candidate set. A per-library cap multiplies by the number of libraries, so a
 * broad query from a user with ten libraries would hand deduplication ten times
 * the set the cap was chosen for.
 *
 * Ranking is global too — a hit from any library can top the list — so the
 * budget is split evenly rather than spent on whichever library is searched
 * first. Zotero returns matches in item-id order, so a library over its share
 * is ranked on an arbitrary slice of its matches; the response says so via
 * `truncated` rather than presenting a partial ranking as complete.
 */
const MAX_CANDIDATES = 2000;

/**
 * This request's per-library share of {@link MAX_CANDIDATES}.
 *
 * Plain division, with no floor: the point is that the total never exceeds the
 * budget however many libraries are in scope. A user with enough libraries to
 * make each share shallow gets a coarser ranking, which is the right trade
 * against an unbounded candidate set.
 */
function perLibraryLimit(libraryCount: number): number {
    return Math.max(1, Math.floor(MAX_CANDIDATES / Math.max(1, libraryCount)));
}

/** Empty timing block for the early returns. */
function emptyTiming(startTime: number): FrontendTimingMetadata {
    return {
        total_ms: Date.now() - startTime,
        item_count: 0,
        attachment_count: 0,
    };
}

/**
 * Handle an item_quick_search_request event.
 *
 * 1. Resolve and validate the scope filters (libraries, collections, tags)
 * 2. Run Zotero's quicksearch per library, union and deduplicate
 * 3. Rank with `scoreSearchResult` — the same ranking the Zotero source picker
 *    uses — and page the ranked list
 * 4. Project each hit per `detail`
 */
export async function handleItemQuickSearchRequest(
    request: WSItemQuickSearchRequest
): Promise<WSItemQuickSearchResponse> {
    const startTime = Date.now();
    const detail: QuickSearchDetail = request.detail === 'full' ? 'full' : 'compact';

    const fail = (message: string, errorCode: WSItemQuickSearchResponse['error_code']): WSItemQuickSearchResponse => ({
        type: 'item_quick_search',
        request_id: request.request_id,
        items: [],
        detail,
        total_count: 0,
        error: message,
        error_code: errorCode,
        timing: emptyTiming(startTime),
    });

    const empty = (): WSItemQuickSearchResponse => ({
        type: 'item_quick_search',
        request_id: request.request_id,
        items: [],
        detail,
        total_count: 0,
        timing: emptyTiming(startTime),
    });

    const query = (request.query ?? '').trim();
    if (!query) {
        logger('handleItemQuickSearchRequest: No query provided', 1);
        return fail('A search query is required.', 'invalid_request');
    }

    // Apply libraries_filter if provided, but always intersect with searchable
    // libraries. Accepts portable library refs ("u"/"g<groupID>"), numeric IDs,
    // numeric-ID strings, and library name substrings.
    let libraryIds: number[] = getSearchableLibraryIds();
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        const resolution = resolveLibrariesFilter(request.libraries_filter);

        // A libraries_filter that resolves to nothing must narrow the search to
        // no results, never widen it to every library — and it is reported as
        // an error rather than an empty result so a bad library reference is
        // not mistaken for a library that holds no matching items.
        const filterError = librariesFilterError(resolution);
        if (filterError) {
            logger(`handleItemQuickSearchRequest: ${filterError.message}`, 1);
            return fail(filterError.message, filterError.error_code);
        }

        libraryIds = resolution.libraryIds;
    }

    // Resolve collections_filter to collection keys, bucketed by library. Keys
    // must stay library-scoped: a search scoped to library B that is given a
    // collection key from library A matches nothing, so a shared collection
    // name (e.g. "Papers") in two libraries would silently empty out both.
    const collectionsFilter = request.collections_filter ?? [];
    const hasCollectionsFilter = collectionsFilter.length > 0;
    const collectionKeysByLibrary = new Map<number, Set<string>>();
    if (hasCollectionsFilter) {
        const resolution = resolveCollectionsFilter(collectionsFilter, libraryIds);

        const filterError = collectionsFilterError(resolution);
        if (filterError) {
            logger(`handleItemQuickSearchRequest: ${filterError.message}`, 1);
            return fail(filterError.message, filterError.error_code);
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

    // Resolve tags_filter to the tag names Zotero stores. Rewriting the filter
    // is what makes it work at all: the Zotero search matches tags
    // case-sensitively, so a differently cased entry would match nothing.
    const tagsFilter = request.tags_filter ?? [];
    let tagNames: string[] | undefined;
    if (tagsFilter.length > 0) {
        const resolution = await resolveTagsFilter(tagsFilter, libraryIds);

        const filterError = tagsFilterError(resolution);
        if (filterError) {
            logger(`handleItemQuickSearchRequest: ${filterError.message}`, 1);
            return fail(filterError.message, filterError.error_code);
        }

        // A tags_filter must narrow the search, never drop off it: when nothing
        // resolved and no error explained why (no library in scope), return no
        // results instead of searching as if no tag had been requested.
        if (resolution.tags.length === 0) {
            logger('handleItemQuickSearchRequest: tags_filter resolved to no tags', 1);
            return empty();
        }

        tagNames = resolution.tags;
    }

    const offset = Math.max(0, request.offset ?? 0);
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

    logger('handleItemQuickSearchRequest: Quick search', {
        libraryIds,
        query,
        detail,
        limit,
        offset,
    }, 1);

    // A collection-scoped request must not fall back to a library-wide search
    // in libraries where no collection resolved, so those libraries drop out
    // here rather than inside the loop — the budget below is divided by the
    // libraries actually searched. Dividing by every searchable library instead
    // would spend most of the budget on libraries that are never searched,
    // leaving a collection-scoped search ranking an arbitrary sliver of its one
    // relevant library and reporting truncation that never had to happen.
    const librariesToSearch = hasCollectionsFilter
        ? libraryIds.filter((libraryId) => collectionKeysByLibrary.get(libraryId)?.size)
        : libraryIds;

    const rowsPerLibrary = perLibraryLimit(librariesToSearch.length);

    const uniqueItems = new Map<string, Zotero.Item>();
    let searchedLibraries = 0;
    let failedLibraries = 0;
    // True when any library held more matches than the ranking budget, so the
    // ranking — and with it `total_count` — covers only part of them.
    let truncated = false;

    for (const libraryId of librariesToSearch) {
        const collectionKeys = collectionKeysByLibrary.get(libraryId);

        const options: QuickSearchItemsOptions = {
            query,
            item_type: request.item_type_filter,
            tags: tagNames,
            collection_keys: collectionKeys ? Array.from(collectionKeys) : undefined,
            limit: rowsPerLibrary,
        };

        searchedLibraries++;
        try {
            const result = await quickSearchItems(libraryId, options);
            if (result.truncated) {
                truncated = true;
                logger(
                    `handleItemQuickSearchRequest: Library ${libraryId} matched ${result.matchCount} items, ranking the first ${rowsPerLibrary}`,
                    2,
                );
            }
            for (const item of result.items) {
                if (item.isRegularItem() && !item.deleted) {
                    const key = `${item.libraryID}-${item.key}`;
                    if (!uniqueItems.has(key)) {
                        uniqueItems.set(key, item);
                    }
                }
            }
        } catch (error) {
            failedLibraries++;
            logger(`handleItemQuickSearchRequest: Error searching library ${libraryId}: ${error}`, 1);
        }
    }

    // A search that failed everywhere is reported as an error rather than an
    // empty result: "no matches" is an answer a caller acts on and stops
    // looking, so a broken search must not be indistinguishable from an empty
    // library. A partial failure still returns the libraries that answered.
    if (failedLibraries > 0 && failedLibraries === searchedLibraries) {
        return fail('Searching the Zotero library failed. Please try again.', 'internal_error');
    }

    const searchEndTime = Date.now();

    // Deduplicate copies of the same work across libraries, preferring the
    // user's own library (id 1), as the fielded searches do.
    const deduplicated = deduplicateItems(Array.from(uniqueItems.values()), 1);

    // Rank with the same scorer the Zotero source picker uses: phrase hit,
    // first-author bonus, recency, title position.
    //
    // A zero score is kept, not dropped. `quicksearch-titleCreatorYear` also
    // matches publicationTitle, shortTitle, court, citationKey and the item key,
    // none of which the scorer indexes (it reads creators, year and title), so
    // dropping zero-score rows would silently discard real matches — a search
    // for a journal name would lose every article whose title omits it. They
    // sort last instead, behind everything the scorer could rank.
    const ranked = deduplicated
        .filter(item => agentItemFilter(item))
        .map(item => ({ item, score: scoreSearchResult(item, query) }))
        .sort((a, b) => (
            b.score - a.score
            // Deterministic order for equal scores, so `offset` pages a stable
            // list rather than one that depends on library iteration order.
            || a.item.libraryID - b.item.libraryID
            || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0)
        ));

    const totalCount = ranked.length;
    const page = ranked.slice(offset, offset + limit);

    const ta = new TimingAccumulator();
    let items: QuickSearchHit[] | ItemSearchFrontendResultItem[];

    if (detail === 'full') {
        // Exactly the page, never backfilled from beyond it. Pulling a
        // replacement for a row that failed to serialize would hand the next
        // page's first hit to this one, so consecutive offsets would overlap —
        // with [A(fails), B, C] and limit 2, offset 0 would return [B, C] and
        // offset 2 would return C a second time. This op publishes
        // `total_count` and promises that offsets page a stable list, so a page
        // that comes back short is the honest outcome; the item that failed is
        // one that could not have been returned on any page.
        items = await serializeItemSearchRows(
            page.map(entry => entry.item),
            page.length,
            ta,
            'handleItemQuickSearchRequest',
        );
    } else {
        // childItems is what `has_attachment` reads; the search loaded only
        // itemData and creators.
        if (page.length > 0) {
            await ta.track('data_loading_ms', () =>
                Zotero.Items.loadDataTypes(page.map(entry => entry.item), ['childItems'])
            );
        }
        items = page.map(entry => toQuickSearchHit(entry.item, entry.score));
    }

    const serializationEndTime = Date.now();
    const attachmentCount = detail === 'full'
        ? (items as ItemSearchFrontendResultItem[]).reduce((sum, row) => sum + row.attachments.length, 0)
        : 0;

    const timing: FrontendTimingMetadata = {
        total_ms: Date.now() - startTime,
        search_ms: searchEndTime - startTime,
        serialization_ms: serializationEndTime - searchEndTime,
        item_count: items.length,
        attachment_count: attachmentCount,
        ...ta.getAll(),
    };

    logger(`handleItemQuickSearchRequest: Returning ${items.length}/${totalCount} items (${detail}${truncated ? ', truncated' : ''}), timing: ${JSON.stringify(timing)}`, 1);

    return {
        type: 'item_quick_search',
        request_id: request.request_id,
        items,
        detail,
        total_count: totalCount,
        truncated,
        timing,
    };
}
