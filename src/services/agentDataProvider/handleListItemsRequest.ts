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
    WSListItemsRequest,
    WSListItemsResponse,
    ListItemsResultItem,
    RegularListResultItem,
    AttachmentResultItem,
} from '../agentProtocol';
import { serializeNote } from '../../utils/zoteroSerializers';
import { getCollectionByIdOrName, validateLibraryAccess, isLibrarySearchable, getSearchableLibraries, extractYear, formatCreatorsString } from './utils';

function isAnnotationItem(item: Zotero.Item): boolean {
    return String(item.itemType) === 'annotation' || (item as { isAnnotation?: () => boolean }).isAnnotation?.() === true;
}

/**
 * Handle list_items request from backend.
 * Lists items in a library, collection, or by tag.
 */
export async function handleListItemsRequest(
    request: WSListItemsRequest
): Promise<WSListItemsResponse> {
    logger(`handleListItemsRequest: collection=${request.collection_key}, tag=${request.tag}`, 1);
    
    try {
        // Validate library (checks both existence and searchability)
        const validation = validateLibraryAccess(request.library_id);
        if (!validation.valid) {
            return {
                type: 'list_items',
                request_id: request.request_id,
                items: [],
                total_count: 0,
                error: validation.error,
                error_code: validation.error_code,
                available_libraries: validation.available_libraries,
            };
        }
        let library = validation.library!;
        let collectionName: string | null = null;
        let resolvedCollectionId: number | null = null;
        
        // Resolve collection if specified (supports both key and name)
        if (request.collection_key) {
            const result = getCollectionByIdOrName(request.collection_key, library.libraryID);
            
            if (!result) {
                return {
                    type: 'list_items',
                    request_id: request.request_id,
                    items: [],
                    total_count: 0,
                    error: `Collection not found: ${request.collection_key}`,
                    error_code: 'collection_not_found',
                };
            }
            
            // Update library scope if collection was found in a different library
            if (result.libraryID !== library.libraryID) {
                const resolvedLib = Zotero.Libraries.get(result.libraryID);
                if (!resolvedLib || !isLibrarySearchable(result.libraryID)) {
                    return {
                        type: 'list_items',
                        request_id: request.request_id,
                        items: [],
                        total_count: 0,
                        error: `Collection "${result.collection.name}" is in library "${(resolvedLib && resolvedLib.name) || result.libraryID}" which is not synced with Beaver.`,
                        error_code: 'library_not_searchable',
                        available_libraries: getSearchableLibraries(),
                    };
                }
                library = resolvedLib;
            }
            
            collectionName = result.collection.name;
            resolvedCollectionId = result.collection.id;
        }
        
        const libraryName = library.name;
        
        // Build search to list items
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID || Zotero.Libraries.userLibraryID;
        
        // Apply collection filter to search
        if (resolvedCollectionId !== null) {
            search.addCondition('collectionID', 'is', String(resolvedCollectionId));
            if (request.recursive !== false) {
                search.addCondition('recursive', 'true', '');
            }
        }
        
        // Validate and add tag filter if specified
        if (request.tag) {
            // Check if the tag exists in the library
            const allTags = await Zotero.Tags.getAll(library.libraryID);
            const tagExists = (allTags as { tag: string }[]).some(
                (t) => t.tag.toLowerCase() === request.tag!.toLowerCase()
            );
            
            if (!tagExists) {
                return {
                    type: 'list_items',
                    request_id: request.request_id,
                    items: [],
                    total_count: 0,
                    error: `Tag not found: "${request.tag}" in library "${library.name}"`,
                    error_code: 'tag_not_found',
                };
            }
            
            search.addCondition('tag', 'is', request.tag);
        }
        
        // Item category: Filter by Zotero item category (regular/attachment/note/annotation)
        const itemCategory = request.item_category ?? 'regular';
        if (itemCategory === 'all') {
            // Do nothing - include all item types
        } else if (itemCategory === 'regular') {
            search.addCondition('itemType', 'isNot', 'attachment');
            search.addCondition('itemType', 'isNot', 'note');
            search.addCondition('itemType', 'isNot', 'annotation');
        } else if (itemCategory === 'attachment') {
            search.addCondition('itemType', 'is', 'attachment');
        } else if (itemCategory === 'note') {
            search.addCondition('itemType', 'is', 'note');
        } else if (itemCategory === 'annotation') {
            search.addCondition('itemType', 'is', 'annotation');
        }
        
        // Exclude child items only for regular category.
        // Notes and attachments are typically child items, so noChildren would hide them.
        if (itemCategory === 'regular') {
            search.addCondition('noChildren', 'true', '');
        }
        
        // Execute search
        const itemIds = await search.search();

        // Batch fetch all items at once
        const allItems = await Zotero.Items.getAsync(itemIds);
        let validItems = allItems
            .filter((item): item is Zotero.Item => item !== null)
            // Annotation results are not supported by the list_items response
            // schema yet
            .filter(item => !isAnnotationItem(item));

        // Zotero's `collectionID is X` only matches items directly in the collection.
        // Child items (notes/attachments) are linked to a collection
        // through their parent, so they aren't returned by the primary search. When
        // a child category is requested with a collection filter, walk the parents
        // and pull their children of the requested type(s).
        const wantsChildItems =
            itemCategory === 'note' ||
            itemCategory === 'attachment' ||
            itemCategory === 'all';

        if (resolvedCollectionId !== null && wantsChildItems) {
            const wantNotes = itemCategory === 'note' || itemCategory === 'all';
            const wantAttachments = itemCategory === 'attachment' || itemCategory === 'all';

            const parentSearch = new Zotero.Search() as unknown as ZoteroSearchWritable;
            parentSearch.libraryID = library.libraryID;
            parentSearch.addCondition('collectionID', 'is', String(resolvedCollectionId));
            if (request.recursive !== false) {
                parentSearch.addCondition('recursive', 'true', '');
            }
            parentSearch.addCondition('noChildren', 'true', '');
            parentSearch.addCondition('itemType', 'isNot', 'note');
            parentSearch.addCondition('itemType', 'isNot', 'annotation');
            parentSearch.addCondition('itemType', 'isNot', 'attachment');

            const parentIds = await parentSearch.search();
            const parents = (await Zotero.Items.getAsync(parentIds))
                .filter((p): p is Zotero.Item => p !== null);
            if (parents.length > 0) {
                await Zotero.Items.loadDataTypes(parents, ['childItems']);
            }

            const childIds = new Set<number>();
            for (const parent of parents) {
                if (wantNotes) {
                    for (const id of parent.getNotes()) childIds.add(id);
                }
                if (wantAttachments) {
                    for (const id of parent.getAttachments()) childIds.add(id);
                }
            }

            const existingIds = new Set(validItems.map(i => i.id));
            const newChildIds = [...childIds].filter(id => !existingIds.has(id));

            if (newChildIds.length > 0) {
                const children = (await Zotero.Items.getAsync(newChildIds))
                    .filter((c): c is Zotero.Item => c !== null);

                let filteredChildren = children;
                if (request.tag) {
                    await Zotero.Items.loadDataTypes(children, ['tags']);
                    const tagExact = request.tag;
                    filteredChildren = children.filter(c => {
                        const tags = c.getTags?.() ?? [];
                        return tags.some((t: { tag: string }) => t.tag === tagExact);
                    });
                }

                validItems.push(...filteredChildren.filter(child => !isAnnotationItem(child)));
            }
        }

        // Load item data in bulk for efficiency (include childItems when filtering by attachment)
        const dataTypes = ['primaryData', 'creators', 'itemData'];
        if (request.has_attachments != null) {
            dataTypes.push('childItems');
        }
        if (validItems.length > 0) {
            await Zotero.Items.loadDataTypes(validItems, dataTypes);
        }

        // Post-filter by attachment status if requested
        if (request.has_attachments != null) {
            validItems = validItems.filter(item => {
                // Only apply attachment filter to regular items
                if (!item.isRegularItem()) return true;
                const hasAtt = item.numAttachments() > 0;
                return request.has_attachments ? hasAtt : !hasAtt;
            });
        }

        const totalCount = validItems.length;
        
        // Build items with sort values
        const itemsWithData: { id: number; item: Zotero.Item; sortValue: any }[] = [];
        for (const item of validItems) {
            let sortValue: any;
            switch (request.sort_by) {
                case 'dateAdded':
                    sortValue = item.dateAdded || '';
                    break;
                case 'dateModified':
                    sortValue = item.dateModified || '';
                    break;
                case 'title':
                    try {
                        sortValue = (item.getField('title', false, true) as string) || '';
                    } catch {
                        sortValue = (item.getDisplayTitle?.() || '').toLowerCase();
                    }
                    break;
                case 'creator': {
                    try {
                        const creators = item.getCreators();
                        sortValue = creators.length > 0 ? (creators[0].lastName || '') : '';
                    } catch {
                        sortValue = '';
                    }
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

            itemsWithData.push({ id: item.id, item, sortValue });
        }
        
        // Sort
        itemsWithData.sort((a, b) => {
            if (a.sortValue < b.sortValue) return request.sort_order === 'asc' ? -1 : 1;
            if (a.sortValue > b.sortValue) return request.sort_order === 'asc' ? 1 : -1;
            return 0;
        });
        
        // Apply pagination
        const paginatedItems = itemsWithData.slice(request.offset, request.offset + request.limit);

        // Batch-load parent items for child items (notes, attachments)
        const childParentIds = new Set<number>();
        for (const { item } of paginatedItems) {
            if ((item.isNote() || item.isAttachment()) && item.parentItemID) {
                childParentIds.add(item.parentItemID);
            }
        }
        const parentMap = new Map<number, { item_id: string; title: string }>();
        if (childParentIds.size > 0) {
            const parentItems = await Zotero.Items.getAsync([...childParentIds]);
            const validParents = parentItems.filter((p): p is Zotero.Item => p !== null);
            if (validParents.length > 0) {
                await Zotero.Items.loadDataTypes(validParents, ['primaryData', 'itemData']);
            }
            for (const parent of validParents) {
                let ptitle = '';
                try { ptitle = (parent.getField('title', false, true) as string) || ''; }
                catch { ptitle = parent.getDisplayTitle?.() || ''; }
                parentMap.set(parent.id, { item_id: `${parent.libraryID}-${parent.key}`, title: ptitle });
            }
        }

        // Build result items
        const items: ListItemsResultItem[] = [];
        for (const { item } of paginatedItems) {
            if (item.isNote()) {
                const parentInfo = item.parentItemID ? parentMap.get(item.parentItemID) : null;
                items.push(serializeNote(item, parentInfo));
            } else if (item.isAttachment()) {
                const parentInfo = item.parentItemID ? parentMap.get(item.parentItemID) : null;
                const attachmentItem: AttachmentResultItem = {
                    result_type: 'attachment',
                    item_id: `${library.libraryID}-${item.key}`,
                    title: item.getDisplayTitle?.() || '',
                    filename: item.attachmentFilename || null,
                    content_type: item.attachmentContentType || null,
                    parent_item_id: parentInfo?.item_id ?? null,
                    parent_title: parentInfo?.title ?? null,
                    date_modified: item.dateModified,
                };
                items.push(attachmentItem);
            } else {
                const creators = item.getCreators();
                let date = '';
                try { date = item.getField('date', false, true) as string; } catch { /* */ }
                let title = '';
                try { title = item.getField('title', false, true) as string; }
                catch { title = item.getDisplayTitle?.() || ''; }

                const resultItem: RegularListResultItem = {
                    result_type: 'regular',
                    item_id: `${library.libraryID}-${item.key}`,
                    item_type: item.itemType,
                    title,
                    creators: formatCreatorsString(creators),
                    year: extractYear(date),
                    date_added: item.dateAdded,
                    date_modified: item.dateModified,
                };
                items.push(resultItem);
            }
        }
        
        logger(`handleListItemsRequest: Returning ${items.length}/${totalCount} items`, 1);
        
        return {
            type: 'list_items',
            request_id: request.request_id,
            items,
            total_count: totalCount,
            library_name: libraryName,
            collection_name: collectionName,
        };
    } catch (error) {
        logger(`handleListItemsRequest: Error: ${error}`, 1);
        return {
            type: 'list_items',
            request_id: request.request_id,
            items: [],
            total_count: 0,
            error: String(error),
            error_code: 'list_failed',
        };
    }
}
