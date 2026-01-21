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
    WSListTagsRequest,
    WSListTagsResponse,
    TagInfo,
} from '../agentProtocol';
import { getCollectionByIdOrName, getLibraryByIdOrName, getAvailableLibraries } from './utils';


/**
 * Handle list_tags request from backend.
 * Lists tags in a library.
 */
export async function handleListTagsRequest(
    request: WSListTagsRequest
): Promise<WSListTagsResponse> {
    logger(`handleListTagsRequest: library=${request.library_id}, collection=${request.collection_key}`, 1);
    
    try {
        // Validate library
        const libraryResult = getLibraryByIdOrName(request.library_id);
        if (libraryResult.wasExplicitlyRequested && !libraryResult.library) {
            return {
                type: 'list_tags',
                request_id: request.request_id,
                tags: [],
                total_count: 0,
                error: `Library not found: "${libraryResult.searchInput}"`,
                error_code: 'library_not_found',
                available_libraries: getAvailableLibraries(),
            };
        }
        const library = libraryResult.library!;
        const libraryName = library.name;
        
        // Get tag colors (this is a sync operation from cache)
        const tagColors = Zotero.Tags.getColors(library.libraryID);
        
        // Build tag info with item counts using efficient SQL
        const tagMap: Map<string, { count: number; type: number }> = new Map();
        
        if (request.collection_key) {
            // Find collection by key or name
            const collection = getCollectionByIdOrName(request.collection_key, library.libraryID);
            
            if (!collection) {
                return {
                    type: 'list_tags',
                    request_id: request.request_id,
                    tags: [],
                    total_count: 0,
                    library_id: library.libraryID,
                    library_name: libraryName,
                    error: `Collection not found: ${request.collection_key}`,
                    error_code: 'collection_not_found',
                };
            }
            
            // Get all descendant collection IDs (including the collection itself)
            const allDescendants = collection.getDescendents(false, 'collection', false);
            const collectionIds = [collection.id, ...allDescendants.map((d: any) => d.id)];
            const placeholders = collectionIds.map(() => '?').join(',');
            
            // Get tags with item counts for items in this collection (recursive)
            // Only count top-level regular items (not attachments, notes, annotations)
            const sql = `
                SELECT T.name, IT.type, COUNT(DISTINCT I.itemID) as itemCount
                FROM itemTags IT
                JOIN tags T ON IT.tagID = T.tagID
                JOIN items I ON IT.itemID = I.itemID
                JOIN collectionItems CI ON I.itemID = CI.itemID
                LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
                LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
                LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID
                WHERE I.libraryID = ?
                AND CI.collectionID IN (${placeholders})
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                AND IA.itemID IS NULL
                AND INo.itemID IS NULL
                AND IAn.itemID IS NULL
                GROUP BY T.tagID, T.name, IT.type
            `;
            
            await Zotero.DB.queryAsync(sql, [library.libraryID, ...collectionIds], {
                onRow: (row: any) => {
                    const name = row.getResultByIndex(0) as string;
                    const type = row.getResultByIndex(1) as number;
                    const count = row.getResultByIndex(2) as number;
                    
                    // Combine counts for same tag name (different types)
                    const existing = tagMap.get(name);
                    if (existing) {
                        existing.count += count;
                    } else {
                        tagMap.set(name, { count, type });
                    }
                }
            });
        } else {
            // Get all tags with item counts for the entire library
            // Only count top-level regular items (not attachments, notes, annotations)
            const sql = `
                SELECT T.name, IT.type, COUNT(DISTINCT I.itemID) as itemCount
                FROM itemTags IT
                JOIN tags T ON IT.tagID = T.tagID
                JOIN items I ON IT.itemID = I.itemID
                LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
                LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
                LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID
                WHERE I.libraryID = ?
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                AND IA.itemID IS NULL
                AND INo.itemID IS NULL
                AND IAn.itemID IS NULL
                GROUP BY T.tagID, T.name, IT.type
            `;
            
            await Zotero.DB.queryAsync(sql, [library.libraryID], {
                onRow: (row: any) => {
                    const name = row.getResultByIndex(0) as string;
                    const type = row.getResultByIndex(1) as number;
                    const count = row.getResultByIndex(2) as number;
                    
                    // Combine counts for same tag name (different types)
                    const existing = tagMap.get(name);
                    if (existing) {
                        existing.count += count;
                    } else {
                        tagMap.set(name, { count, type });
                    }
                }
            });
        }
        
        // Build tag info array
        const tags: TagInfo[] = [];
        for (const [name, data] of tagMap) {
            // Skip if below minimum count
            if (data.count < (request.min_item_count ?? 0)) {
                continue;
            }
            
            // Get color if any
            const colorInfo = tagColors.get(name);
            
            tags.push({
                name,
                item_count: data.count,
                color: colorInfo?.color || null,
            });
        }
        
        // Sort by item count (descending), then by name
        tags.sort((a, b) => {
            if (b.item_count !== a.item_count) {
                return b.item_count - a.item_count;
            }
            return a.name.localeCompare(b.name);
        });
        
        // Apply pagination
        const totalCount = tags.length;
        const offset = request.offset ?? 0;
        const limit = request.limit ?? 50;
        const paginatedTags = tags.slice(offset, offset + limit);
        
        logger(`handleListTagsRequest: Returning ${paginatedTags.length}/${totalCount} tags`, 1);
        
        return {
            type: 'list_tags',
            request_id: request.request_id,
            tags: paginatedTags,
            total_count: totalCount,
            library_id: library.libraryID,
            library_name: libraryName,
        };
    } catch (error) {
        logger(`handleListTagsRequest: Error: ${error}`, 1);
        return {
            type: 'list_tags',
            request_id: request.request_id,
            tags: [],
            total_count: 0,
            error: String(error),
            error_code: 'list_failed',
        };
    }
}
