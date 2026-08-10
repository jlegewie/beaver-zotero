/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getCollectionItemCounts } from './collectionCounts';
import {
    WSListCollectionsRequest,
    WSListCollectionsResponse,
    CollectionInfo,
} from '@beaver/agent-core/protocol/agentProtocol';
import { resolveSingleCollection, getSearchableLibraryIds, librariesForCollectionError, validateLibraryAccess } from './utils';
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
        
        // Resolve parent collection if specified (scoped identifier, key, name, or
        // row id), potentially updating library scope. An explicitly requested
        // library confines resolution to that library; otherwise the library in
        // play is tried first and any other searchable library is eligible. A
        // *name* never widens: names like "Inbox" are commonly duplicated across
        // libraries, so a widened name lookup would silently retarget the
        // request at another library's collection.
        let parentCollectionId: number | null = null;
        if (request.parent_collection_key) {
            const resolved = resolveSingleCollection(request.parent_collection_key, {
                eligibleLibraryIds: validation.wasExplicitlyRequested
                    ? [library.libraryID]
                    : [library.libraryID, ...getSearchableLibraryIds().filter(id => id !== library.libraryID)],
                nameLibraryIds: [library.libraryID],
                explicitLibrary: validation.wasExplicitlyRequested,
            });

            if (!resolved.ok) {
                return {
                    type: 'list_collections',
                    request_id: request.request_id,
                    collections: [],
                    total_count: 0,
                    library_name: library.name,
                    error: resolved.message,
                    error_code: resolved.code,
                    available_libraries: librariesForCollectionError(resolved.code),
                };
            }

            // The resolver only matches inside searchable libraries, so a
            // different library here is a scope switch, not an access decision.
            if (resolved.match.libraryID !== library.libraryID) {
                const resolvedLib = Zotero.Libraries.get(resolved.match.libraryID);
                if (resolvedLib) library = resolvedLib;
            }

            parentCollectionId = resolved.match.collection.id;
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
            // Left off entirely when counts were not requested: absent means
            // "not reported", which a zero would misrepresent as "none here".
            standalone_attachment_count: request.include_item_counts ? (attachmentCountById.get(collection.id) || 0) : undefined,
            standalone_note_count: request.include_item_counts ? (noteCountById.get(collection.id) || 0) : undefined,
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
