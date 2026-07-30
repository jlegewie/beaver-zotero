/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { getCollectionItemCounts } from './collectionCounts';
import {
    WSListCollectionsRequest,
    WSListCollectionsResponse,
    CollectionInfo,
} from '../agentProtocol';
import { getCollectionByIdOrName, validateLibraryAccess, isLibrarySearchable, getSearchableLibraries, excludedLibraryMessage } from './utils';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';


/**
 * Handle list_collections request from backend.
 * Lists collections in a library.
 */
export async function handleListCollectionsRequest(
    request: WSListCollectionsRequest
): Promise<WSListCollectionsResponse> {
    logger(`handleListCollectionsRequest: library=${request.library_id}, parent=${request.parent_collection_key}`, 1);
    
    try {
        // Validate library (checks both existence and searchability)
        const validation = validateLibraryAccess(request.library_id);
        if (!validation.valid) {
            return {
                type: 'list_collections',
                request_id: request.request_id,
                collections: [],
                total_count: 0,
                error: validation.error,
                error_code: validation.error_code,
                available_libraries: validation.available_libraries,
            };
        }
        let library = validation.library!;
        
        // Resolve parent collection if specified, potentially updating library scope
        let parentCollectionId: number | null = null;
        if (request.parent_collection_key) {
            const result = getCollectionByIdOrName(request.parent_collection_key, library.libraryID);
            
            if (!result) {
                return {
                    type: 'list_collections',
                    request_id: request.request_id,
                    collections: [],
                    total_count: 0,
                    library_name: library.name,
                    error: `Parent collection not found: ${request.parent_collection_key}`,
                    error_code: 'collection_not_found',
                };
            }
            
            // Update library scope if collection was found in a different library
            if (result.libraryID !== library.libraryID) {
                const resolvedLib = Zotero.Libraries.get(result.libraryID);
                if (!resolvedLib || !isLibrarySearchable(result.libraryID)) {
                    return {
                        type: 'list_collections',
                        request_id: request.request_id,
                        collections: [],
                        total_count: 0,
                        // Do not echo the collection's name: it is content from a
                        // library the user excluded from Beaver.
                        error: excludedLibraryMessage(result.libraryID),
                        error_code: 'library_not_searchable',
                        available_libraries: getSearchableLibraries(),
                    };
                }
                library = resolvedLib;
            }
            
            parentCollectionId = result.collection.id;
        }
        
        const libraryName = library.name;
        
        // Get all collections from the library (excluding deleted)
        const allCollections = Zotero.Collections.getByLibrary(library.libraryID, true);
        
        // Filter by parent collection if specified
        let filteredCollections: any[];
        
        if (parentCollectionId !== null) {
            filteredCollections = allCollections.filter((c: any) => c.parentID === parentCollectionId);
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
            // Shared with the application-state snapshot so both report the
            // same numbers for the same collection.
            const counts = await getCollectionItemCounts(
                filteredCollections.map((c: any) => c.id)
            );
            for (const [collectionId, collectionCounts] of counts) {
                itemCountById.set(collectionId, collectionCounts.itemCount);
                attachmentCountById.set(collectionId, collectionCounts.standaloneAttachmentCount);
                noteCountById.set(collectionId, collectionCounts.standaloneNoteCount);
            }
        }
        
        // Constant for the whole request; computed once.
        const libraryRef = libraryRefForLibraryID(library.libraryID) ?? undefined;

        // Build results
        const allResults: CollectionInfo[] = filteredCollections.map((collection: any) => ({
            library_id: library.libraryID,
            library_ref: libraryRef,
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
            library_ref: libraryRef,
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
