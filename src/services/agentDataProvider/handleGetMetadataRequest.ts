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
    WSGetMetadataRequest,
    WSGetMetadataResponse,
} from '../agentProtocol';


/**
 * Handle get_metadata request from backend.
 * Returns full Zotero metadata for specific items.
 */
export async function handleGetMetadataRequest(
    request: WSGetMetadataRequest
): Promise<WSGetMetadataResponse> {
    logger(`handleGetMetadataRequest: Getting metadata for ${request.item_ids.length} items`, 1);
    
    const items: Record<string, any>[] = [];
    const notFound: string[] = [];
    
    for (const itemId of request.item_ids) {
        try {
            // Parse item_id format: "<library_id>-<zotero_key>"
            const dashIndex = itemId.indexOf('-');
            if (dashIndex === -1) {
                notFound.push(itemId);
                continue;
            }
            
            const libraryId = parseInt(itemId.substring(0, dashIndex), 10);
            const key = itemId.substring(dashIndex + 1);
            
            if (isNaN(libraryId) || !key) {
                notFound.push(itemId);
                continue;
            }
            
            // Get the item
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, key);
            if (!item) {
                notFound.push(itemId);
                continue;
            }
            
            // Load necessary data types before accessing item data
            // Always load itemData and creators for basic fields
            const dataTypesToLoad: string[] = ['itemData', 'creators', 'relations', 'tags', 'collections', 'childItems'];
            await Zotero.Items.loadDataTypes([item], dataTypesToLoad);
            
            // Get full item data via toJSON() - this is the canonical Zotero method
            const itemData: Record<string, any> = item.toJSON();
            itemData.item_id = itemId;
            
            // Return all fields (including tags and collections)
            const result: Record<string, any> = { ...itemData };
            
            // Handle attachments if requested
            if (request.include_attachments && item.isRegularItem()) {
                const attachmentIds = item.getAttachments();
                if (attachmentIds.length > 0) {
                    // Batch fetch all attachments at once
                    const attachmentItems = await Zotero.Items.getAsync(attachmentIds);
                    
                    // Ensure attachment data is loaded
                    await Zotero.Items.loadDataTypes(attachmentItems, ['primaryData', 'itemData', 'tags', 'collections', 'childItems']);
                    
                    const attachments: any[] = [];
                    
                    for (const attachment of attachmentItems) {
                        if (!attachment) continue;
                        
                        try {
                            attachments.push({
                                attachment_id: `${libraryId}-${attachment.key}`,
                                title: attachment.getField('title') || null,
                                filename: attachment.attachmentFilename || null,
                                contentType: attachment.attachmentContentType || null,
                                path: await attachment.getFilePath() || null,
                                url: attachment.getField('url') || null,
                            });
                        } catch (error) {
                            logger(`handleGetMetadataRequest: Error processing attachment ${attachment.key}: ${error}`, 2);
                        }
                    }
                    
                    if (attachments.length > 0) {
                        result.attachments = attachments;
                    }
                }
            }
            
            // Handle notes if requested
            if (request.include_notes && item.isRegularItem()) {
                const noteIds = item.getNotes();
                if (noteIds.length > 0) {
                    // Batch fetch all notes at once
                    const noteItems = await Zotero.Items.getAsync(noteIds);
                    
                    // Ensure note data is loaded
                    await Zotero.Items.loadDataTypes(noteItems, ['primaryData', 'itemData', 'note', 'tags', 'collections', 'childItems']);
                    
                    const notes: any[] = [];
                    
                    for (const note of noteItems) {
                        if (!note || !note.isNote()) continue;
                        
                        try {
                            notes.push({
                                note_id: `${libraryId}-${note.key}`,
                                title: note.getDisplayTitle() || null,
                                note: note.getNote() || '',
                            });
                        } catch (error) {
                            logger(`handleGetMetadataRequest: Error processing note ${note.key}: ${error}`, 2);
                        }
                    }
                    
                    if (notes.length > 0) {
                        result.notes = notes;
                    }
                }
            }
            
            items.push(result);
            
        } catch (error) {
            logger(`handleGetMetadataRequest: Failed to get item ${itemId}: ${error}`, 1);
            notFound.push(itemId);
        }
    }
    
    logger(`handleGetMetadataRequest: Returning ${items.length} items, ${notFound.length} not found`, 1);
    
    return {
        type: 'get_metadata',
        request_id: request.request_id,
        items,
        not_found: notFound,
    };
}
