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
} from '../agentProtocol';
import { getCollectionByIdOrName, validateLibraryAccess, extractYear, formatCreatorsString } from './utils';


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
        const library = validation.library!;
        const libraryName = library.name;
        let collectionName: string | null = null;
        
        // Build search to list items
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID || Zotero.Libraries.userLibraryID;
        
        // Add collection filter if specified (supports both key and name)
        if (request.collection_key) {
            const collection = getCollectionByIdOrName(request.collection_key, library.libraryID);
            
            if (collection) {
                collectionName = collection.name;
                search.addCondition('collectionID', 'is', String(collection.id));
                // Use recursive parameter from request (default true)
                if (request.recursive !== false) {
                    search.addCondition('recursive', 'true', '');
                }
            } else {
                return {
                    type: 'list_items',
                    request_id: request.request_id,
                    items: [],
                    total_count: 0,
                    error: `Collection not found: ${request.collection_key}`,
                    error_code: 'collection_not_found',
                };
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
        
        // Exclude attachments and notes from top-level results
        search.addCondition('noChildren', 'true', '');
        
        // Execute search
        const itemIds = await search.search();
        const totalCount = itemIds.length;
        
        // Batch fetch all items at once
        const allItems = await Zotero.Items.getAsync(itemIds);
        const validItems = allItems.filter((item): item is Zotero.Item => item !== null);
        
        // Load item data in bulk for efficiency
        if (validItems.length > 0) {
            await Zotero.Items.loadDataTypes(validItems, ['primaryData', 'creators', 'itemData']);
        }
        
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
                    sortValue = (item.getField('title', false, true) as string) || '';
                    break;
                case 'creator': {
                    const creators = item.getCreators();
                    sortValue = creators.length > 0 ? (creators[0].lastName || '') : '';
                    break;
                }
                case 'year': {
                    const date = item.getField('date', false, true) as string;
                    sortValue = extractYear(date) || 0;
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
        
        // Build result items
        const items: ListItemsResultItem[] = [];
        for (const { item } of paginatedItems) {
            const creators = item.getCreators();
            const date = item.getField('date', false, true) as string;

            const resultItem: ListItemsResultItem = {
                item_id: `${library.libraryID}-${item.key}`,
                item_type: item.itemType,
                title: item.getField('title', false, true) as string,
                creators: formatCreatorsString(creators),
                year: extractYear(date),
                date_added: item.dateAdded,
                date_modified: item.dateModified,
            };
            
            items.push(resultItem);
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