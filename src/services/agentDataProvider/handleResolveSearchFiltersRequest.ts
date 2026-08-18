/**
 * Resolve-search-filters handler.
 *
 * Resolves structured item filters into attachment references for full-text
 * search, where item-level metadata filters must be resolved against the local
 * Zotero library first.
 *
 * Values are OR'd within a dimension and AND'd across dimensions. Each matched
 * item contributes all agent-supported attachments.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { agentItemFilter } from '../../utils/agentItemSupport';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import {
    WSResolveSearchFiltersRequest,
    WSResolveSearchFiltersResponse,
    ResolveSearchFiltersUnresolved,
} from '@beaver/agent-core/protocol/agentProtocol';
import { resolveItemsByFilters } from '../../../react/utils/searchTools';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import {
    getCollectionByIdOrName,
    getSearchableLibraryIds,
    isLibraryAccessReady,
    librariesFilterError,
    resolveLibrariesFilter,
} from './utils';

/** Build the response envelope with timing metadata. */
function buildResponse(
    request: WSResolveSearchFiltersRequest,
    attachments: ZoteroItemReference[],
    unresolved: ResolveSearchFiltersUnresolved | undefined,
    startTime: number,
    itemCount: number,
    error?: { message: string; error_code: WSResolveSearchFiltersResponse['error_code'] },
): WSResolveSearchFiltersResponse {
    return {
        type: 'resolve_search_filters',
        request_id: request.request_id,
        attachments,
        ...(unresolved ? { unresolved } : {}),
        ...(error ? { error: error.message, error_code: error.error_code } : {}),
        timing: {
            total_ms: Date.now() - startTime,
            item_count: itemCount,
            attachment_count: attachments.length,
        },
    };
}

export async function handleResolveSearchFiltersRequest(
    request: WSResolveSearchFiltersRequest
): Promise<WSResolveSearchFiltersResponse> {
    const startTime = Date.now();

    const hasCollections = !!(request.collections?.length);
    const hasTags = !!(request.tags?.length);
    const hasAuthors = !!(request.authors?.length);
    const hasYear = !!request.year && (
        (request.year.min ?? 0) > 0 ||
        (request.year.max ?? 0) > 0 ||
        (request.year.exact ?? 0) > 0
    );

    // Intersect the library filter with searchable libraries, through the same
    // resolution every other search op uses: portable refs ("u"/"g<groupID>")
    // resolve, and a library the user excluded is reported as excluded rather
    // than as unknown.
    let libraryIds: number[] = getSearchableLibraryIds();
    const unresolvedLibraries: (string | number)[] = [];
    if (request.libraries && request.libraries.length > 0) {
        const resolution = resolveLibrariesFilter(request.libraries);

        // A filter that resolves to nothing must narrow the search to no
        // results, never widen it to every library — and it is reported as an
        // error so a bad reference is not mistaken for an empty library.
        const filterError = librariesFilterError(resolution);
        if (filterError) {
            logger(`handleResolveSearchFiltersRequest: ${filterError.message}`, 1);
            return buildResponse(request, [], undefined, startTime, 0, filterError);
        }

        libraryIds = resolution.libraryIds;
        unresolvedLibraries.push(
            ...resolution.unresolved,
            ...resolution.excluded.map((entry) => entry.input),
        );
    }

    // `librariesFilterError` returns null while the library-access snapshot is
    // still loading, so the fail-closed empty scope has to be handled here too.
    // In that state every classification above is wrong — the searchable set is
    // `[]`, so a valid reference looks excluded — hence no reason is reported
    // rather than a misleading one, the same rule `librariesFilterError` follows.
    if (libraryIds.length === 0) {
        logger('handleResolveSearchFiltersRequest: no searchable library to resolve against', 1);
        const reportable = isLibraryAccessReady() && unresolvedLibraries.length > 0;
        return buildResponse(
            request,
            [],
            reportable ? { libraries: unresolvedLibraries } : undefined,
            startTime,
            0,
        );
    }

    // No item-level filters means there is no attachment set to resolve.
    if (!hasCollections && !hasTags && !hasAuthors && !hasYear) {
        logger('handleResolveSearchFiltersRequest: no item-level filters provided', 1);
        return buildResponse(request, [], undefined, startTime, 0);
    }

    // Resolve collection inputs to keys per library.
    const collectionKeysByLibrary = new Map<number, string[]>();
    const resolvedCollectionInputs = new Set<string | number>();
    if (hasCollections) {
        for (const libId of libraryIds) collectionKeysByLibrary.set(libId, []);
        for (const coll of request.collections!) {
            for (const libId of libraryIds) {
                const result = getCollectionByIdOrName(coll as number | string, libId);
                if (result && result.libraryID === libId) {
                    collectionKeysByLibrary.get(libId)!.push(result.collection.key);
                    resolvedCollectionInputs.add(coll);
                }
            }
        }
    }

    // Aggregate matched items and attachments across libraries.
    const attachmentRefs = new Map<string, ZoteroItemReference>();
    const matchedTagsGlobal = new Set<string>();
    const matchedAuthorsGlobal = new Set<string>();
    let matchedItemCount = 0;

    const addAttachment = (item: Zotero.Item) => {
        const key = `${item.libraryID}-${item.key}`;
        if (!attachmentRefs.has(key)) {
            attachmentRefs.set(key, {
                library_id: item.libraryID,
                library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
                zotero_key: item.key,
            });
        }
    };

    for (const libId of libraryIds) {
        const collectionKeys = collectionKeysByLibrary.get(libId) ?? [];
        // The collection dimension is required when present.
        if (hasCollections && collectionKeys.length === 0) continue;

        let resolved;
        try {
            resolved = await resolveItemsByFilters(libId, {
                collectionKeys: hasCollections ? collectionKeys : undefined,
                tags: request.tags,
                authors: request.authors,
                year: request.year,
                recursive: request.recursive_collections ?? true,
            });
        } catch (error) {
            logger(`handleResolveSearchFiltersRequest: error resolving library ${libId}: ${error}`, 1);
            continue;
        }

        for (const t of resolved.matchedTags) matchedTagsGlobal.add(t);
        for (const a of resolved.matchedAuthors) matchedAuthorsGlobal.add(a);

        if (resolved.itemIDs.length === 0) continue;

        const items = await Zotero.Items.getAsync(resolved.itemIDs);
        await Zotero.Items.loadDataTypes(items, ['childItems']);

        for (const item of items) {
            if (item.isRegularItem()) {
                if (!agentItemFilter(item)) continue;
                matchedItemCount++;
                const attachments = await Zotero.Items.getAsync(item.getAttachments());
                for (const att of attachments) {
                    if (att && !att.deleted && agentItemFilter(att)) addAttachment(att);
                }
            } else if (item.isAttachment()) {
                if (!item.deleted && agentItemFilter(item)) {
                    matchedItemCount++;
                    addAttachment(item);
                }
            }
        }
    }

    // A value is unresolved only when it matched in no searched library.
    const unresolved: ResolveSearchFiltersUnresolved = {};
    if (hasCollections) {
        const missing = request.collections!.filter((c) => !resolvedCollectionInputs.has(c));
        if (missing.length) unresolved.collections = missing;
    }
    if (hasTags) {
        const missing = request.tags!.filter((t) => !matchedTagsGlobal.has(t));
        if (missing.length) unresolved.tags = missing;
    }
    if (hasAuthors) {
        const missing = request.authors!.filter((a) => !matchedAuthorsGlobal.has(a));
        if (missing.length) unresolved.authors = missing;
    }
    if (unresolvedLibraries.length) unresolved.libraries = unresolvedLibraries;
    const hasUnresolved = Object.keys(unresolved).length > 0;

    const attachments = Array.from(attachmentRefs.values());
    logger(
        `handleResolveSearchFiltersRequest: ${attachments.length} attachments from ${matchedItemCount} items` +
        (hasUnresolved ? ` (unresolved: ${JSON.stringify(unresolved)})` : ''),
        1,
    );

    return buildResponse(request, attachments, hasUnresolved ? unresolved : undefined, startTime, matchedItemCount);
}
