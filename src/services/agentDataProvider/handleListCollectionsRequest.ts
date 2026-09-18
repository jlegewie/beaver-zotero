/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { collectionNotFoundError, CollectionResolutionError, serializeCollectionIdentity } from '../collections/collectionIdentity';

import { logger } from '@beaver/agent-core/platform/logger';
import { getCollectionItemCounts } from './collectionCounts';
import {
    WSListCollectionsRequest,
    WSListCollectionsResponse,
    CollectionInfo,
} from '@beaver/agent-core/protocol/agentProtocol';
import { getCollectionByIdOrName, validateLibraryAccess } from './utils';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';


/**
 * Upper bound on `limit`.
 *
 * A recursive listing is meant to be one call per library, and ~1000 rows
 * covers the collection count of any real library while still bounding what a
 * bad `limit` can serialize.
 */
const MAX_LIMIT = 1000;

/** Applied when the request omits `limit`. */
const DEFAULT_LIMIT = 50;

/**
 * Handle list_collections request from backend.
 * Lists collections in a library.
 */
export async function handleListCollectionsRequest(
    request: WSListCollectionsRequest
): Promise<WSListCollectionsResponse> {
    logger(`handleListCollectionsRequest: library=${request.library_id}, parent=${request.parent_collection_key}, recursive=${request.recursive === true}`, 1);
    
    try {
        // Validate library (checks both existence and searchability)
        let validation = validateLibraryAccess(request.library_id);
        const resolvedCollection = request.parent_collection_key && (request.library_id == null || validation.valid)
            ? getCollectionByIdOrName(request.parent_collection_key, request.library_id != null ? validation.library!.libraryID : undefined)
            : null;
        if (request.library_id == null && resolvedCollection) {
            validation = validateLibraryAccess(resolvedCollection.libraryID);
        }
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
        const library = validation.library!;
        
        // Use the resolved parent to constrain the listing
        let parentCollectionId: number | null = null;
        if (request.parent_collection_key) {
            const result = resolvedCollection;
            
            if (!result) {
                return {
                    type: 'list_collections',
                    request_id: request.request_id,
                    collections: [],
                    total_count: 0,
                    library_name: library.name,
                    error: collectionNotFoundError(request.parent_collection_key).message,
                    error_code: 'collection_not_found',
                };
            }

            parentCollectionId = result.collection.id;
        }
        
        const libraryName = library.name;
        
        // Get all collections from the library (excluding deleted)
        const allCollections = Zotero.Collections.getByLibrary(library.libraryID, true);

        // Build lookup maps
        const collectionIdToName: Map<number, string> = new Map(
            allCollections.map((c: any) => [c.id, c.name])
        );

        const childrenByParent: Map<number, any[]> = new Map();
        for (const coll of allCollections) {
            if (coll.parentID) {
                const siblings = childrenByParent.get(coll.parentID);
                if (siblings) {
                    siblings.push(coll);
                } else {
                    childrenByParent.set(coll.parentID, [coll]);
                }
            }
        }

        // Filter to the requested scope: the direct children of the parent (or
        // of the library root), or every descendant when `recursive` is set so
        // a whole library is one call. Each row carries `parent_key` either
        // way, so a recursive listing is a flat tree the caller can rebuild.
        const recursive = request.recursive === true;
        let filteredCollections: any[];

        if (recursive) {
            // `allCollections` is already the whole library, so the root case
            // needs no walk at all.
            filteredCollections = parentCollectionId === null
                ? allCollections.slice()
                : Zotero.Collections.getByParent(parentCollectionId, true);
        } else if (parentCollectionId !== null) {
            filteredCollections = childrenByParent.get(parentCollectionId) ?? [];
        } else {
            filteredCollections = allCollections.filter((c: any) => !c.parentID);
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
            ...serializeCollectionIdentity(collection),
            library_id: library.libraryID,
            library_ref: libraryRef,
            collection_key: collection.key,
            name: collection.name,
            parent_key: collection.parentKey || null,
            parent_name: collection.parentID ? collectionIdToName.get(collection.parentID) || null : null,
            item_count: request.include_item_counts ? (itemCountById.get(collection.id) || 0) : undefined,
            // Left off entirely when counts were not requested: absent means
            // "not reported", which a zero would misrepresent as "none here".
            standalone_attachment_count: request.include_item_counts ? (attachmentCountById.get(collection.id) || 0) : undefined,
            standalone_note_count: request.include_item_counts ? (noteCountById.get(collection.id) || 0) : undefined,
            subcollection_count: childrenByParent.get(collection.id)?.length ?? 0,
        }));

        // Sort by name
        allResults.sort((a, b) => a.name.localeCompare(b.name));

        // Apply pagination
        const totalCount = allResults.length;
        const offset = Math.max(0, request.offset ?? 0);
        const limit = Math.max(0, Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
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
            error: error instanceof Error ? error.message : String(error),
            error_code: error instanceof CollectionResolutionError ? error.code : 'list_failed',
        };
    }
}
