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
    WSListLibrariesRequest,
    WSListLibrariesResponse,
    LibraryInfo,
} from '../agentProtocol';


/**
 * Handle list_libraries request from backend.
 * Lists all available libraries in the user's Zotero.
 *
 * Primarily for testing purposes.
 */
export async function handleListLibrariesRequest(
    request: WSListLibrariesRequest
): Promise<WSListLibrariesResponse> {
    logger(`handleListLibrariesRequest: Listing all libraries`, 1);

    try {
        const allLibraries = Zotero.Libraries.getAll();
        const libraries: LibraryInfo[] = [];

        for (const library of allLibraries) {
            // Get top-level regular item count (excluding attachments, notes, annotations, and deleted)
            let itemCount = 0;
            try {
                const sql = `
                    SELECT COUNT(*) as cnt
                    FROM items A
                    LEFT JOIN itemNotes B USING (itemID)
                    LEFT JOIN itemAttachments C USING (itemID)
                    LEFT JOIN itemAnnotations D USING (itemID)
                    WHERE A.libraryID = ?
                    AND B.itemID IS NULL
                    AND C.itemID IS NULL
                    AND D.itemID IS NULL
                    AND A.itemID NOT IN (SELECT itemID FROM deletedItems)
                `;
                await Zotero.DB.queryAsync(sql, [library.libraryID], {
                    onRow: (row: any) => {
                        itemCount = row.getResultByIndex(0) as number;
                    }
                });
            } catch (error) {
                logger(`handleListLibrariesRequest: Error counting items for library ${library.libraryID}: ${error}`, 2);
            }

            // Get collection count (excluding deleted)
            let collectionCount = 0;
            try {
                const sql = `
                    SELECT COUNT(*) as cnt
                    FROM collections 
                    WHERE libraryID = ?
                    AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
                `;
                await Zotero.DB.queryAsync(sql, [library.libraryID], {
                    onRow: (row: any) => {
                        collectionCount = row.getResultByIndex(0) as number;
                    }
                });
            } catch (error) {
                logger(`handleListLibrariesRequest: Error counting collections for library ${library.libraryID}: ${error}`, 2);
            }

            // Get tag count
            let tagCount = 0;
            try {
                const tags = await Zotero.Tags.getAll(library.libraryID);
                tagCount = (tags as any[]).length;
            } catch (error) {
                logger(`handleListLibrariesRequest: Error counting tags for library ${library.libraryID}: ${error}`, 2);
            }

            libraries.push({
                library_id: library.libraryID,
                name: library.name,
                is_group: library.isGroup,
                read_only: !library.editable || !library.filesEditable,
                item_count: itemCount,
                collection_count: collectionCount,
                tag_count: tagCount,
            });
        }

        libraries.sort((a, b) => a.library_id - b.library_id);

        logger(`handleListLibrariesRequest: Returning ${libraries.length} libraries`, 1);

        return {
            type: 'list_libraries',
            request_id: request.request_id,
            libraries,
            total_count: libraries.length,
        };
    } catch (error) {
        logger(`handleListLibrariesRequest: Error: ${error}`, 1);
        return {
            type: 'list_libraries',
            request_id: request.request_id,
            libraries: [],
            total_count: 0,
            error: String(error),
            error_code: 'list_failed',
        };
    }
}
