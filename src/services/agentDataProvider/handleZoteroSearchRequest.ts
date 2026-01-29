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
} from '../agentProtocol';
import { validateLibraryAccess, extractYear } from './utils';


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
        
        // Create search object
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;
        
        // Set join mode first (if 'any')
        if (request.join_mode === 'any') {
            search.addCondition('joinMode', 'any', '');
        }
        
        // Add search conditions
        for (const condition of request.conditions) {
            let operator = condition.operator;
            let value = condition.value ?? '';
            
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
                logger(`handleZoteroSearchRequest: Invalid condition ${condition.field} ${operator}: ${err}`, 1);
            }
        }

        // Item category filter
        const anyItemTypeCondition = request.conditions.some((condition) => condition.field === 'itemType');
        if (!anyItemTypeCondition) {
            const itemCategory = request.item_category ?? 'regular';
            if (itemCategory === 'regular') {
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
            // 'all' = no filter, do nothing
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
        const itemIds = await search.search();
        const totalCount = itemIds.length;
        
        // Apply pagination
        const offset = request.offset || 0;
        const limit = request.limit || 50;
        const paginatedIds = itemIds.slice(offset, offset + limit);
        
        // Batch fetch items
        const zoteroItems = await Zotero.Items.getAsync(paginatedIds);
        
        // Ensure item data is loaded (Zotero uses lazy loading)
        await Zotero.Items.loadDataTypes(zoteroItems, ['primaryData', 'creators', 'itemData']);
        
        // Build results
        const items: ZoteroSearchResultItem[] = [];
        
        for (const item of zoteroItems) {
            if (!item) continue;
            
            // Get creators
            const creators = item.getCreators();
            const creatorsString = creators
                .map((c: any) => c.lastName || c.name || '')
                .filter((n: string) => n)
                .join(', ');
            
            // Get date and extract year
            let year: number | null = null;
            try {
                const dateStr = item.getField('date') as string;
                if (dateStr) {
                    year = extractYear(dateStr);
                }
            } catch {
                // Date field may not exist for some item types
            }
            
            // Get title safely
            let title = '';
            try {
                title = (item.getField('title') as string) || '';
            } catch {
                // Some item types (like annotations) may not have title field
                title = item.getDisplayTitle?.() || '';
            }
            
            const resultItem: ZoteroSearchResultItem = {
                item_id: `${item.libraryID}-${item.key}`,
                item_type: item.itemType,
                title,
                creators: creatorsString || null,
                year,
            };
            
            // Include extra fields if requested
            if (request.fields && request.fields.length > 0) {
                const extraFields: Record<string, any> = {};
                for (const field of request.fields) {
                    try {
                        const value = item.getField(field);
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
        
        logger(`handleZoteroSearchRequest: Returning ${items.length}/${totalCount} items`, 1);
        
        return {
            type: 'zotero_search',
            request_id: request.request_id,
            items,
            total_count: totalCount,
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