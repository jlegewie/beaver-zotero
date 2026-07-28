/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import {
    // Library management tools
    WSZoteroSearchRequest,
    WSZoteroSearchResponse,
    ZoteroSearchResultItem,
    RegularSearchResultItem,
    AttachmentRowResult,
} from '../agentProtocol';
import { ItemStub } from '../../../react/types/zotero';
import { serializeNote, serializeItemStub } from '../../utils/zoteroSerializers';
import { libraryRefForLibraryID, modelObjectId } from '../../utils/libraryIdentity';
import { validateLibraryAccess, extractYear, formatCreatorsString, getAttachmentInfoForItem } from './utils';


/**
 * How each `item_category` maps onto a set of Zotero item types.
 *
 * A Map, not an object literal: `item_category` arrives over the wire, and a
 * plain-object lookup would resolve inherited keys ("constructor", "toString")
 * to truthy non-filters. Unrecognized categories must degrade to "no filter".
 */
const ITEM_CATEGORY_TYPE_FILTERS = new Map<string, { itemTypes: string[]; mode: 'include' | 'exclude' }>([
    ['regular', { itemTypes: ['attachment', 'note', 'annotation'], mode: 'exclude' }],
    ['attachment', { itemTypes: ['attachment'], mode: 'include' }],
    ['note', { itemTypes: ['note'], mode: 'include' }],
    // 'all' is absent because it filters nothing; 'annotation' is absent because
    // it returns early (zotero_search cannot return annotations at all).
]);

/**
 * Keep (`include`) or drop (`exclude`) the given itemIDs by item type,
 * preserving the incoming order. Chunked to stay under SQLite's bound-variable
 * limit.
 */
async function filterItemIdsByItemType(
    itemIds: number[],
    itemTypes: string[],
    mode: 'include' | 'exclude',
): Promise<number[]> {
    if (itemIds.length === 0 || itemTypes.length === 0) return itemIds;

    const itemTypeIDs = itemTypes
        .map(itemType => Zotero.ItemTypes.getID(itemType))
        .filter((id): id is number => typeof id === 'number');
    if (itemTypeIDs.length === 0) return itemIds;

    const comparison = mode === 'include' ? 'IN' : 'NOT IN';
    const typePlaceholders = itemTypeIDs.map(() => '?').join(', ');
    const matchingItemIds = new Set<number>();
    const chunkSize = 500;

    for (let i = 0; i < itemIds.length; i += chunkSize) {
        const chunk = itemIds.slice(i, i + chunkSize);
        const idPlaceholders = chunk.map(() => '?').join(', ');
        await Zotero.DB.queryAsync(
            `SELECT itemID FROM items WHERE itemID IN (${idPlaceholders}) `
                + `AND itemTypeID ${comparison} (${typePlaceholders})`,
            [...chunk, ...itemTypeIDs],
            {
                onRow: (row: any) => {
                    matchingItemIds.add(row.getResultByIndex(0));
                },
            },
        );
    }

    return itemIds.filter(id => matchingItemIds.has(id));
}

function filterOutAnnotationItemIds(itemIds: number[]): Promise<number[]> {
    return filterItemIdsByItemType(itemIds, ['annotation'], 'exclude');
}


/**
 * Handle zotero_search request from backend.
 * Uses Zotero's native search API.
 */
export async function handleZoteroSearchRequest(
    request: WSZoteroSearchRequest
): Promise<WSZoteroSearchResponse> {
    logger(`handleZoteroSearchRequest: Processing ${request.conditions.length} conditions`, 1);

    try {
        // Validate library (checks both existence and searchability)
        const validation = validateLibraryAccess(request.library_id);
        if (!validation.valid) {
            return {
                type: 'zotero_search',
                request_id: request.request_id,
                items: [],
                total_count: 0,
                error: validation.error,
                error_code: validation.error_code,
                available_libraries: validation.available_libraries,
            };
        }
        const library = validation.library!;

        const anyItemTypeCondition = request.conditions.some((condition) => condition.field === 'itemType');
        const itemCategory = request.item_category ?? 'regular';

        // zotero_search has no annotation result shape, so annotations are always
        // dropped from the result set. An annotation-only search can therefore
        // never return a row: settle it here rather than running the search and
        // handing back an empty page the model would read as "no matches".
        if (!anyItemTypeCondition && itemCategory === 'annotation') {
            return {
                type: 'zotero_search',
                request_id: request.request_id,
                items: [],
                total_count: 0,
                warnings: [
                    "item_category='annotation' returns no results because zotero_search cannot return annotations. "
                        + 'Use find_annotations to search annotation text and comments.',
                ],
            };
        }

        // Create search object
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;

        // Set join mode first (if 'any')
        if (request.join_mode === 'any') {
            search.addCondition('joinMode', 'any', '');
        }

        // Warnings are surfaced to the backend so the agent can correct bad
        // conditions rather than receive a silently-relaxed result set.
        const warnings: string[] = [];

        // Add search conditions
        for (const condition of request.conditions) {
            let operator = condition.operator;
            let value = condition.value ?? '';
            const originalOperator = operator;

            // Map operator names if needed
            const operatorMap: Record<string, string> = {
                'is': 'is',
                'isNot': 'isNot',
                'contains': 'contains',
                'doesNotContain': 'doesNotContain',
                'beginsWith': 'beginsWith',
                'isLessThan': 'isLessThan',
                'isGreaterThan': 'isGreaterThan',
                'isBefore': 'isBefore',
                'isAfter': 'isAfter',
                'isInTheLast': 'isInTheLast',
            };

            operator = operatorMap[operator] || operator;

            // Handle search for empty fields (Zotero quirk)
            // "field is empty" must be expressed as "field doesNotContain ''"
            if (operator === 'is' && (value === null || value === undefined || value === '')) {
                operator = 'doesNotContain';
                value = '';
            }

            try {
                search.addCondition(
                    condition.field as _ZoteroTypes.Search.Conditions,
                    operator as _ZoteroTypes.Search.Operator,
                    String(value)  // Ensure value is always a string
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger(`handleZoteroSearchRequest: Invalid condition ${condition.field} ${originalOperator}: ${msg}`, 1);
                warnings.push(
                    `Dropped condition field='${condition.field}' operator='${originalOperator}' value='${String(condition.value ?? '')}': ${msg}`
                );
            }
        }

        // Item category filter.
        //
        // Zotero ORs together every non-special condition when joinMode is 'any';
        // only the special conditions (joinMode/noChildren/recursive/…) and the
        // search's libraryID *property* — set above, not added as a condition —
        // are ANDed outside the join. Adding itemType conditions there would make
        // the category an always-true disjunct — e.g. "isNot attachment OR isNot
        // note" holds for every item — so an 'any' search would silently match
        // the whole library. For 'any' the category is therefore applied as a
        // post-filter on the matched itemIDs instead; 'all' keeps the
        // condition-based filter so Zotero's SQL does the work.
        const categoryFilter = anyItemTypeCondition ? undefined : ITEM_CATEGORY_TYPE_FILTERS.get(itemCategory);
        const categoryNeedsPostFilter = request.join_mode === 'any';

        if (categoryFilter && !categoryNeedsPostFilter) {
            const operator = categoryFilter.mode === 'include' ? 'is' : 'isNot';
            for (const itemType of categoryFilter.itemTypes) {
                search.addCondition('itemType', operator, itemType);
            }
        }

        // Search recursively within collections (only affects collectionID conditions)
        if (request.recursive) {
            search.addCondition('recursive', 'true', '');
        }
        
        // Exclude child items
        if (!request.include_children) {
            search.addCondition('noChildren', 'true', '');
        }
        
        // Execute search
        let itemIds = await search.search();

        // Apply the item category as a post-filter for 'any' searches (see above).
        // Runs before every other filter so the cheap itemType query shrinks the
        // set before items get loaded, and before total_count/pagination.
        if (categoryFilter && categoryNeedsPostFilter) {
            itemIds = await filterItemIdsByItemType(itemIds, categoryFilter.itemTypes, categoryFilter.mode);
        }

        // Post-filter by attachment status if requested
        if (request.has_attachments != null) {
            const allForFilter = await Zotero.Items.getAsync(itemIds);
            const validForFilter = allForFilter.filter((item): item is Zotero.Item => item !== null);
            if (validForFilter.length > 0) {
                await Zotero.Items.loadDataTypes(validForFilter, ['childItems']);
            }
            const matchingItemIds = new Set<number>();
            for (const item of validForFilter) {
                // Only apply attachment filter to regular items
                let matches = true;
                if (item.isRegularItem()) {
                    const hasAtt = item.numAttachments() > 0;
                    matches = request.has_attachments ? hasAtt : !hasAtt;
                }
                if (matches) {
                    matchingItemIds.add(item.id);
                }
            }
            itemIds = itemIds.filter(id => matchingItemIds.has(id));
        }

        // zotero_search has no annotation result shape. When annotations can
        // reach the result set, drop them BEFORE counting and paginating, so
        // total_count and page boundaries reflect only returnable items.
        // A category filter has already excluded them (as conditions or as the
        // post-filter above); the remaining cases — an explicit itemType
        // condition, 'all', or an unrecognized category — still need this pass.
        const mayContainAnnotations = !categoryFilter;
        if (mayContainAnnotations) {
            itemIds = await filterOutAnnotationItemIds(itemIds);
        }

        const totalCount = itemIds.length;

        // Apply pagination
        const offset = request.offset || 0;
        const limit = request.limit || 50;
        const sortRequested = request.sort_by != null;

        // When sorting is requested, we need to fetch all items to sort them
        // before paginating. When not sorting, paginate on IDs first (faster).
        let paginatedZoteroItems: Zotero.Item[];

        if (sortRequested) {
            // Fetch all items for sorting
            const allItems = await Zotero.Items.getAsync(itemIds);
            const validItems = allItems.filter((item): item is Zotero.Item => item !== null);

            if (validItems.length > 0) {
                await Zotero.Items.loadDataTypes(validItems, ['primaryData', 'creators', 'itemData']);
            }

            const sortBy = request.sort_by!;
            const sortOrder = request.sort_order || 'desc';

            // Compute sort values
            const itemsWithSortKey: { item: Zotero.Item; sortValue: any }[] = [];
            for (const item of validItems) {
                let sortValue: any;
                switch (sortBy) {
                    case 'dateAdded':
                        sortValue = item.dateAdded || '';
                        break;
                    case 'dateModified':
                        sortValue = item.dateModified || '';
                        break;
                    case 'title':
                        try {
                            sortValue = ((item.getField('title', false, true) as string) || '').toLowerCase();
                        } catch {
                            sortValue = (item.getDisplayTitle?.() || '').toLowerCase();
                        }
                        break;
                    case 'creator': {
                        const creators = item.getCreators();
                        // lastName covers both personal authors and corporate/institutional
                        // names (fieldMode=1 stores the full name in lastName)
                        sortValue = creators.length > 0
                            ? (creators[0].lastName || '').toLowerCase()
                            : '';
                        break;
                    }
                    case 'year': {
                        try {
                            const date = item.getField('date', false, true) as string;
                            sortValue = extractYear(date) || 0;
                        } catch {
                            sortValue = 0;
                        }
                        break;
                    }
                    case 'itemType':
                        sortValue = item.itemType || '';
                        break;
                    default:
                        sortValue = item.dateModified || '';
                }
                itemsWithSortKey.push({ item, sortValue });
            }

            // Sort
            itemsWithSortKey.sort((a, b) => {
                if (a.sortValue < b.sortValue) return sortOrder === 'asc' ? -1 : 1;
                if (a.sortValue > b.sortValue) return sortOrder === 'asc' ? 1 : -1;
                return 0;
            });

            paginatedZoteroItems = itemsWithSortKey
                .slice(offset, offset + limit)
                .map(({ item }) => item);
        } else {
            // No sorting — paginate on IDs first, then fetch only the page
            const paginatedIds = itemIds.slice(offset, offset + limit);
            const fetchedItems = await Zotero.Items.getAsync(paginatedIds);
            const fetchedItemsById = new Map<number, Zotero.Item>();
            for (const item of fetchedItems) {
                if (item !== null) {
                    fetchedItemsById.set(item.id, item);
                }
            }
            paginatedZoteroItems = paginatedIds
                .map(id => fetchedItemsById.get(id))
                .filter((item): item is Zotero.Item => item != null);

            if (paginatedZoteroItems.length > 0) {
                await Zotero.Items.loadDataTypes(paginatedZoteroItems, ['primaryData', 'creators', 'itemData']);
            }
        }

        const attachmentItems = paginatedZoteroItems.filter((item) => item.isAttachment());
        if (attachmentItems.length) {
            await Zotero.Items.loadDataTypes(attachmentItems, ["childItems"]);
        }

        // Batch-load parent items for child items (notes, attachments)
        const childParentIds = new Set<number>();
        for (const item of paginatedZoteroItems) {
            if ((item.isNote() || item.isAttachment()) && item.parentItemID) {
                childParentIds.add(item.parentItemID);
            }
        }
        const parentMap = new Map<number, ItemStub>();
        if (childParentIds.size > 0) {
            const parentItems = await Zotero.Items.getAsync([...childParentIds]);
            const validParents = parentItems.filter((p): p is Zotero.Item => p !== null);
            if (validParents.length > 0) {
                await Zotero.Items.loadDataTypes(validParents, ['primaryData', 'itemData', 'creators']);
                validParents.forEach(parent => parentMap.set(parent.id, serializeItemStub(parent)));
            }
        }

        // Build results
        const items: ZoteroSearchResultItem[] = [];

        for (const item of paginatedZoteroItems) {
            if (item.isNote()) {
                const parentInfo = item.parentItemID ? parentMap.get(item.parentItemID) : null;
                items.push(serializeNote(item, parentInfo));
            } else if (item.isAttachment()) {
                const parentInfo = item.parentItemID ? parentMap.get(item.parentItemID) : null;
                const attachmentInfo = await getAttachmentInfoForItem(item, {
                    parentItemId: parentInfo?.item_id ?? null,
                    isPrimary: false,
                    includeAnnotationsCount: true,
                    skipWorkerFallback: true,
                });
                const attachmentItem: AttachmentRowResult = {
                    ...attachmentInfo,
                    result_type: 'attachment',
                    parent_title: parentInfo?.title ?? null,
                    parent_item: parentInfo ?? null,
                    date_modified: item.dateModified,
                };
                items.push(attachmentItem);
            } else {
                // Get creators
                const creators = item.getCreators();

                // Get date and extract year
                let year: number | null = null;
                try {
                    const dateStr = item.getField('date', false, true) as string;
                    if (dateStr) {
                        year = extractYear(dateStr);
                    }
                } catch {
                    // Date field may not exist for some item types
                }

                // Get title safely
                let title = '';
                try {
                    title = (item.getField('title', false, true) as string) || '';
                } catch {
                    // Some item types (like annotations) may not have title field
                    title = item.getDisplayTitle?.() || '';
                }

                const resultItem: RegularSearchResultItem = {
                    result_type: 'regular',
                    item_id: modelObjectId(item.libraryID, item.key),
                    library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
                    item_type: item.itemType,
                    title,
                    creators: formatCreatorsString(creators),
                    year,
                };

                // Include extra fields if requested
                if (request.fields && request.fields.length > 0) {
                    const extraFields: Record<string, any> = {};
                    for (const field of request.fields) {
                        try {
                            // includeBaseMapped=true so base fields resolve to type-specific fields
                            const value = item.getField(field, false, true);
                            if (value !== undefined && value !== '') {
                                extraFields[field] = value;
                            }
                        } catch {
                            // Field not valid for this item type - skip silently
                        }
                    }
                    if (Object.keys(extraFields).length > 0) {
                        resultItem.extra_fields = extraFields;
                    }
                }

                items.push(resultItem);
            }
        }

        logger(`handleZoteroSearchRequest: Returning ${items.length}/${totalCount} items${sortRequested ? ` (sorted by ${request.sort_by} ${request.sort_order || 'desc'})` : ''}${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`, 1);

        return {
            type: 'zotero_search',
            request_id: request.request_id,
            items,
            total_count: totalCount,
            warnings: warnings.length ? warnings : undefined,
        };
    } catch (error) {
        logger(`handleZoteroSearchRequest: Error: ${error}`, 1);
        return {
            type: 'zotero_search',
            request_id: request.request_id,
            items: [],
            total_count: 0,
            error: String(error),
            error_code: 'search_failed',
        };
    }
}
