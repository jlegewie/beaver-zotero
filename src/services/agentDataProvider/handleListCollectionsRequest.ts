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
    WSListCollectionsRequest,
    WSListCollectionsResponse,
    CollectionInfo,
} from '../agentProtocol';
import { getCollectionByIdOrName, getLibraryByIdOrName, getAvailableLibraries } from './utils';


/**
 * Handle list_collections request from backend.
 * Lists collections in a library.
 */
export async function handleListCollectionsRequest(
    request: WSListCollectionsRequest
): Promise<WSListCollectionsResponse> {
    logger(`handleListCollectionsRequest: library=${request.library_id}, parent=${request.parent_collection_key}`, 1);
    
    try {
        // Validate library
        const libraryResult = getLibraryByIdOrName(request.library_id);
        if (libraryResult.wasExplicitlyRequested && !libraryResult.library) {
            return {
                type: 'list_collections',
                request_id: request.request_id,
                collections: [],
                total_count: 0,
                error: `Library not found: "${libraryResult.searchInput}"`,
                error_code: 'library_not_found',
                available_libraries: getAvailableLibraries(),
            };
        }
        const library = libraryResult.library!;
        const libraryName = library.name;
        
        // Get all collections from the library (excluding deleted)
        const allCollections = Zotero.Collections.getByLibrary(library.libraryID, true);
        
        // Filter by parent collection if specified
        let filteredCollections: any[];
        
        if (request.parent_collection_key) {
            const parentCollection = getCollectionByIdOrName(request.parent_collection_key, library.libraryID);
            
            if (!parentCollection) {
                return {
                    type: 'list_collections',
                    request_id: request.request_id,
                    collections: [],
                    total_count: 0,
                    library_name: libraryName,
                    error: `Parent collection not found: ${request.parent_collection_key}`,
                    error_code: 'collection_not_found',
                };
            }
            
            filteredCollections = allCollections.filter((c: any) => c.parentID === parentCollection.id);
        } else {
            filteredCollections = allCollections.filter((c: any) => !c.parentID);
        }
        
        // Build lookup maps
        const collectionIdToName: Map<number, string> = new Map(
            allCollections.map((c: any) => [c.id, c.name])
        );
        
        const subcollectionCountById: Map<number, number> = new Map();
        for (const coll of allCollections) {
            if (coll.parentID) {
                subcollectionCountById.set(coll.parentID, (subcollectionCountById.get(coll.parentID) || 0) + 1);
            }
        }
        
        // Pre-fetch item counts for all collections if needed
        const itemCountById: Map<number, number> = new Map();
        const attachmentCountById: Map<number, number> = new Map();
        const noteCountById: Map<number, number> = new Map();
        
        if (request.include_item_counts) {
            try {
                const collectionIds = filteredCollections.map((c: any) => c.id);
                if (collectionIds.length > 0) {
                    const placeholders = collectionIds.map(() => '?').join(',');
                    
                    // Count top-level regular items (same as library count for consistency)
                    const itemSql = `
                        SELECT CI.collectionID, COUNT(*) as itemCount
                        FROM collectionItems CI
                        JOIN items I ON CI.itemID = I.itemID
                        LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
                        LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
                        LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID
                        WHERE CI.collectionID IN (${placeholders})
                        AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                        AND IA.itemID IS NULL
                        AND INo.itemID IS NULL
                        AND IAn.itemID IS NULL
                        GROUP BY CI.collectionID
                    `;
                    await Zotero.DB.queryAsync(itemSql, collectionIds, {
                        onRow: (row: any) => {
                            const collectionID = row.getResultByIndex(0);
                            const count = row.getResultByIndex(1);
                            itemCountById.set(collectionID, count);
                        }
                    });
                    
                    // Count standalone attachments (no parent)
                    const attachmentSql = `
                        SELECT CI.collectionID, COUNT(*) as attachmentCount
                        FROM collectionItems CI
                        JOIN items I ON CI.itemID = I.itemID
                        JOIN itemAttachments IA ON I.itemID = IA.itemID
                        WHERE CI.collectionID IN (${placeholders})
                        AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                        AND IA.parentItemID IS NULL
                        GROUP BY CI.collectionID
                    `;
                    await Zotero.DB.queryAsync(attachmentSql, collectionIds, {
                        onRow: (row: any) => {
                            const collectionID = row.getResultByIndex(0);
                            const count = row.getResultByIndex(1);
                            attachmentCountById.set(collectionID, count);
                        }
                    });
                    
                    // Count standalone notes (no parent)
                    const noteSql = `
                        SELECT CI.collectionID, COUNT(*) as noteCount
                        FROM collectionItems CI
                        JOIN items I ON CI.itemID = I.itemID
                        JOIN itemNotes INo ON I.itemID = INo.itemID
                        WHERE CI.collectionID IN (${placeholders})
                        AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                        AND INo.parentItemID IS NULL
                        GROUP BY CI.collectionID
                    `;
                    await Zotero.DB.queryAsync(noteSql, collectionIds, {
                        onRow: (row: any) => {
                            const collectionID = row.getResultByIndex(0);
                            const count = row.getResultByIndex(1);
                            noteCountById.set(collectionID, count);
                        }
                    });
                }
            } catch (error) {
                logger(`handleListCollectionsRequest: Error fetching item counts: ${error}`, 2);
            }
        }
        
        // Build results
        const allResults: CollectionInfo[] = filteredCollections.map((collection: any) => ({
            collection_key: collection.key,
            name: collection.name,
            parent_key: collection.parentKey || null,
            parent_name: collection.parentID ? collectionIdToName.get(collection.parentID) || null : null,
            item_count: request.include_item_counts ? (itemCountById.get(collection.id) || 0) : 0,
            standalone_attachment_count: request.include_item_counts ? (attachmentCountById.get(collection.id) || 0) : 0,
            standalone_note_count: request.include_item_counts ? (noteCountById.get(collection.id) || 0) : 0,
            subcollection_count: subcollectionCountById.get(collection.id) || 0,
        }));
        
        // Sort by name
        allResults.sort((a, b) => a.name.localeCompare(b.name));
        
        // Apply pagination
        const totalCount = allResults.length;
        const offset = request.offset ?? 0;
        const limit = request.limit ?? 50;
        const collections = allResults.slice(offset, offset + limit);
        
        logger(`handleListCollectionsRequest: Returning ${collections.length}/${totalCount} collections`, 1);
        
        return {
            type: 'list_collections',
            request_id: request.request_id,
            collections,
            total_count: totalCount,
            library_id: library.libraryID,
            library_name: libraryName,
        };
    } catch (error) {
        logger(`handleListCollectionsRequest: Error: ${error}`, 1);
        return {
            type: 'list_collections',
            request_id: request.request_id,
            collections: [],
            total_count: 0,
            error: String(error),
            error_code: 'list_failed',
        };
    }
}