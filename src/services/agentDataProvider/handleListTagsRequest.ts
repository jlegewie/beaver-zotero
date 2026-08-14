/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSListTagsRequest,
    WSListTagsResponse,
    TagInfo,
} from '@beaver/agent-core/protocol/agentProtocol';
import { getCollectionByIdOrName, validateLibraryAccess, isLibrarySearchable, getSearchableLibraries, excludedLibraryMessage } from './utils';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';


/** Per-tag counts broken down by the type of object carrying the tag. */
interface TagCounts {
    itemCount: number;
    attachmentCount: number;
    noteCount: number;
    annotationCount: number;
}

/** Upper bound on `limit`. */
const MAX_LIMIT = 1000;

/** Applied when the request omits `limit`. */
const DEFAULT_LIMIT = 50;

/**
 * Build the `LIKE` pattern for a `name_query` substring match.
 *
 * The wildcards a user can type (`%`, `_`) and the escape character itself are
 * escaped, so a query is matched literally rather than as a pattern.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII only, so a query in a
 * non-ASCII script matches case-sensitively. That is the trade for pushing the
 * filter into SQL, which is the whole point of `name_query`.
 */
function likeContainsPattern(query: string): string {
    return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}


/**
 * Handle list_tags request from backend.
 * Lists tags in a library.
 */
export async function handleListTagsRequest(
    request: WSListTagsRequest
): Promise<WSListTagsResponse> {
    logger(`handleListTagsRequest: library=${request.library_id}, collection=${request.collection_key}, name_query=${request.name_query ?? ''}`, 1);
    
    try {
        // Validate library (checks both existence and searchability)
        const validation = validateLibraryAccess(request.library_id);
        if (!validation.valid) {
            return {
                type: 'list_tags',
                request_id: request.request_id,
                tags: [],
                total_count: 0,
                error: validation.error,
                error_code: validation.error_code,
                available_libraries: validation.available_libraries,
            };
        }
        let library = validation.library!;
        let resolvedCollection: Zotero.Collection | null = null;
        
        // Resolve collection if specified, potentially updating library scope
        if (request.collection_key) {
            const result = getCollectionByIdOrName(request.collection_key, library.libraryID);
            
            if (!result) {
                return {
                    type: 'list_tags',
                    request_id: request.request_id,
                    tags: [],
                    total_count: 0,
                    library_id: library.libraryID,
                    library_name: library.name,
                    error: `Collection not found: ${request.collection_key}`,
                    error_code: 'collection_not_found',
                };
            }
            
            // Update library scope if collection was found in a different library
            if (result.libraryID !== library.libraryID) {
                const resolvedLib = Zotero.Libraries.get(result.libraryID);
                if (!resolvedLib || !isLibrarySearchable(result.libraryID)) {
                    return {
                        type: 'list_tags',
                        request_id: request.request_id,
                        tags: [],
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
            
            resolvedCollection = result.collection;
        }
        
        const libraryName = library.name;

        // Get tag colors (this is a sync operation from cache)
        const tagColors = Zotero.Tags.getColors(library.libraryID);

        // Build tag counts broken down by tagged-object type
        const tagMap: Map<string, TagCounts> = new Map();

        // Columns per row: name, itemCount, attachmentCount, noteCount, annotationCount.
        // Each (itemID, tagID) pair yields exactly one row, and the item-type
        // LEFT JOINs are 1:1, so SUM(CASE ...) counts each object exactly once.
        const accumulateRow = (row: any) => {
            const name = row.getResultByIndex(0) as string;
            const itemCount = (row.getResultByIndex(1) as number) || 0;
            const attachmentCount = (row.getResultByIndex(2) as number) || 0;
            const noteCount = (row.getResultByIndex(3) as number) || 0;
            const annotationCount = (row.getResultByIndex(4) as number) || 0;

            const existing = tagMap.get(name);
            if (existing) {
                existing.itemCount += itemCount;
                existing.attachmentCount += attachmentCount;
                existing.noteCount += noteCount;
                existing.annotationCount += annotationCount;
            } else {
                tagMap.set(name, { itemCount, attachmentCount, noteCount, annotationCount });
            }
        };

        // Per-type tag counts. Classify each tagged item by its type via the
        // item-type tables (an item belongs to exactly one of these, or is a
        // regular item when it appears in none).
        const COUNT_COLUMNS = `
                SUM(CASE WHEN IA.itemID IS NULL AND INo.itemID IS NULL AND IAn.itemID IS NULL THEN 1 ELSE 0 END) AS itemCount,
                SUM(CASE WHEN IA.itemID IS NOT NULL THEN 1 ELSE 0 END) AS attachmentCount,
                SUM(CASE WHEN INo.itemID IS NOT NULL THEN 1 ELSE 0 END) AS noteCount,
                SUM(CASE WHEN IAn.itemID IS NOT NULL THEN 1 ELSE 0 END) AS annotationCount`;

        const COUNT_JOINS = `
                LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
                LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
                LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID`;

        // Name filtering is pushed into SQL rather than applied to the finished
        // array: this handler groups over the whole library regardless of
        // `limit`, so the filter is what actually reduces the work, not just
        // the wire. `total_count` therefore counts matching tags only.
        const nameQuery = request.name_query?.trim();
        const nameFilterSql = nameQuery ? `\n                AND T.name LIKE ? ESCAPE '\\'` : '';
        const nameFilterParams = nameQuery ? [likeContainsPattern(nameQuery)] : [];

        if (resolvedCollection) {
            const collection = resolvedCollection;

            // Get all descendant collection IDs (including the collection itself)
            const allDescendants = collection.getDescendents(false, 'collection', false);
            const collectionIds = [collection.id, ...allDescendants.map((d: any) => d.id)];
            const placeholders = collectionIds.map(() => '?').join(',');

            // Tags for items in this collection (recursive across sub-collections).
            const sql = `
                WITH RECURSIVE scope(itemID) AS (
                    SELECT itemID FROM collectionItems WHERE collectionID IN (${placeholders})
                    UNION
                    SELECT children.itemID
                    FROM (
                        SELECT itemID, parentItemID FROM itemAttachments WHERE parentItemID IS NOT NULL
                        UNION ALL
                        SELECT itemID, parentItemID FROM itemNotes WHERE parentItemID IS NOT NULL
                        UNION ALL
                        SELECT itemID, parentItemID FROM itemAnnotations
                    ) AS children
                    JOIN scope ON children.parentItemID = scope.itemID
                )
                SELECT T.name,${COUNT_COLUMNS}
                FROM itemTags IT
                JOIN tags T ON IT.tagID = T.tagID
                JOIN items I ON IT.itemID = I.itemID
                JOIN scope S ON I.itemID = S.itemID${COUNT_JOINS}
                WHERE I.libraryID = ?
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)${nameFilterSql}
                GROUP BY T.tagID, T.name
            `;

            await Zotero.DB.queryAsync(sql, [...collectionIds, library.libraryID, ...nameFilterParams], {
                onRow: accumulateRow,
            });
        } else {
            // All tags in the library, counted across every tagged-object type.
            const sql = `
                SELECT T.name,${COUNT_COLUMNS}
                FROM itemTags IT
                JOIN tags T ON IT.tagID = T.tagID
                JOIN items I ON IT.itemID = I.itemID${COUNT_JOINS}
                WHERE I.libraryID = ?
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)${nameFilterSql}
                GROUP BY T.tagID, T.name
            `;

            await Zotero.DB.queryAsync(sql, [library.libraryID, ...nameFilterParams], {
                onRow: accumulateRow,
            });
        }

        // Build tag info array
        const tags: TagInfo[] = [];
        for (const [name, data] of tagMap) {
            // Filter on the total number of tagged objects so a tag is kept even
            // when it lives only on attachments/notes/annotations.
            const totalCount = data.itemCount + data.attachmentCount + data.noteCount + data.annotationCount;
            if (totalCount < (request.min_item_count ?? 0)) {
                continue;
            }

            // Get color if any
            const colorInfo = tagColors.get(name);

            tags.push({
                name,
                item_count: data.itemCount,
                attachment_count: data.attachmentCount,
                note_count: data.noteCount,
                annotation_count: data.annotationCount,
                color: colorInfo?.color || null,
            });
        }

        // Sort by total tagged-object count (descending), then by name
        const totalOf = (t: TagInfo) =>
            t.item_count + (t.attachment_count ?? 0) + (t.note_count ?? 0) + (t.annotation_count ?? 0);
        tags.sort((a, b) => {
            const diff = totalOf(b) - totalOf(a);
            if (diff !== 0) {
                return diff;
            }
            return a.name.localeCompare(b.name);
        });
        
        // Apply pagination. The cap matches list_collections: a client is meant
        // to be able to fetch a library's tags in one call and filter locally,
        // falling back to `name_query` only when it cannot.
        const totalCount = tags.length;
        const offset = Math.max(0, request.offset ?? 0);
        const limit = Math.max(0, Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
        const paginatedTags = tags.slice(offset, offset + limit);
        
        logger(`handleListTagsRequest: Returning ${paginatedTags.length}/${totalCount} tags`, 1);
        
        return {
            type: 'list_tags',
            request_id: request.request_id,
            tags: paginatedTags,
            total_count: totalCount,
            library_id: library.libraryID,
            library_ref: libraryRefForLibraryID(library.libraryID) ?? undefined,
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
