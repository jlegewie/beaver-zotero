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
import { ItemStub } from '../../../react/types/zotero';
import { serializeNote, serializeAnnotation, serializeItemStub } from '../../utils/zoteroSerializers';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { checkLibraryExcluded, getAttachmentInfoForItem, formatCreatorsString, extractYear } from './utils';


/**
 * Enrich an item's collection memberships into {collection_key, name} objects
 * so the agent sees meaningful names instead of opaque keys.
 */
function enrichItemCollections(item: Zotero.Item): { collection_key: string; name: string }[] {
    return item.getCollections().map((collId: number) => {
        const coll = Zotero.Collections.get(collId);
        return {
            collection_key: coll ? coll.key : String(collId),
            name: coll ? coll.name : String(collId),
        };
    });
}

/**
 * Handle get_metadata request from backend.
 * Returns full Zotero metadata for specific items.
 *
 * Regular items get the rich toJSON passthrough plus optional attachment/note
 * children. Directly-requested attachments, notes, and annotations are
 * normalized into the same shapes used elsewhere in the agent surface
 * (AttachmentInfo, serializeNote, serializeAnnotation) so the backend can
 * return a consistent, type-appropriate result rather than raw toJSON.
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

            // Never serve metadata for items in libraries the user excluded from
            // Beaver; report them as not found so no data leaks.
            if (checkLibraryExcluded(libraryId)) {
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

            // --- Attachment: normalize to the unified AttachmentInfo shape ---
            if (item.isAttachment()) {
                // Resolve the parent via parentItemID + getAsync rather than the
                // synchronous `parentItem` getter, which returns undefined when
                // the parent shell isn't cached (common for a cold WS fetch).
                const parentId = item.parentItemID;
                const parent = parentId ? await Zotero.Items.getAsync(parentId) : null;
                let parentItemId: string | undefined;
                let parentSummary: ItemStub | null = null;
                let isPrimary = false;
                if (parent) {
                    parentItemId = `${parent.libraryID}-${parent.key}`;
                    await Zotero.Items.loadDataTypes([parent], ['primaryData', 'itemData', 'creators']);
                    parentSummary = serializeItemStub(parent);
                    try {
                        const best = await parent.getBestAttachment();
                        isPrimary = best ? best.id === item.id : false;
                    } catch {
                        // getBestAttachment failure is non-fatal — is_primary stays false.
                    }
                }
                const info = await getAttachmentInfoForItem(item, {
                    parentItemId,
                    isPrimary,
                    includeAnnotationsCount: true,
                    skipWorkerFallback: true,
                });
                items.push({
                    ...info,
                    item_id: itemId,
                    itemType: 'attachment',
                    parent_item: parentSummary,
                    collections: enrichItemCollections(item),
                    tags: item.getTags(),
                    // Emit ISO-8601 to match the regular-item toJSON path (the
                    // backend tolerates raw SQL too, but keep the wire consistent).
                    dateAdded: item.dateAdded ? Zotero.Date.sqlToISO8601(item.dateAdded) : null,
                    dateModified: item.dateModified ? Zotero.Date.sqlToISO8601(item.dateModified) : null,
                });
                continue;
            }

            // --- Note: structured fields only (no body) ---
            if (item.isNote()) {
                const parentId = item.parentItemID;
                const parent = parentId ? await Zotero.Items.getAsync(parentId) : null;
                let parentSummary: ItemStub | null = null;
                if (parent) {
                    await Zotero.Items.loadDataTypes([parent], ['primaryData', 'itemData', 'creators']);
                    parentSummary = serializeItemStub(parent);
                }
                items.push({
                    ...serializeNote(item, parentSummary),
                    itemType: 'note',
                });
                continue;
            }

            // --- Annotation: normalize via serializeAnnotation (type/text/comment/page/parents) ---
            if (item.isAnnotation()) {
                // Annotation field getters (annotationType/Text/Comment/Color/
                // AuthorName) require the 'annotation' data type, and
                // annotationPosition requires 'annotationDeferred'. Neither is in
                // the shared load above, so without this the getters throw
                // UnloadedDataException and the annotation is wrongly reported as
                // not_found. Load them before serializing.
                await Zotero.Items.loadDataTypes([item], ['annotation', 'annotationDeferred']);

                // The annotation's parent is the attachment (the PDF); the
                // attachment's parent is the bibliographic regular item. Resolve
                // both async so a cold cache doesn't drop the parent linkage.
                const attachmentId = item.parentItemID;
                const attachment = attachmentId ? await Zotero.Items.getAsync(attachmentId) : null;
                let attachmentInfo: { item_id: string } | null = null;
                let itemInfo: {
                    item_id: string;
                    item_type?: string | null;
                    title: string;
                    creators?: string | null;
                    year?: number | null;
                } | null = null;
                if (attachment) {
                    attachmentInfo = { item_id: `${attachment.libraryID}-${attachment.key}` };
                    const regularId = attachment.parentItemID;
                    const regular = regularId ? await Zotero.Items.getAsync(regularId) : null;
                    if (regular) {
                        await Zotero.Items.loadDataTypes([regular], ['itemData', 'creators']);
                        itemInfo = {
                            item_id: `${regular.libraryID}-${regular.key}`,
                            item_type: regular.itemType,
                            title: regular.getDisplayTitle?.() || '',
                            creators: formatCreatorsString(regular.getCreators?.()),
                            year: extractYear(regular.getField('date')),
                        };
                    }
                }
                // serializeAnnotation sets item_id to the bibliographic parent and
                // annotation_id to the annotation itself. The backend correlates
                // annotations by annotation_id, so do NOT overwrite item_id here;
                // only tag the type for the backend's per-type branch.
                items.push({
                    ...serializeAnnotation(item, attachmentInfo, itemInfo),
                    itemType: 'annotation',
                });
                continue;
            }

            // Get full item data via toJSON({ mode: 'full' }) - includes all fields
            const itemData: Record<string, any> = item.toJSON({ mode: 'full' });
            itemData.item_id = itemId;
            itemData.library_ref = libraryRefForLibraryID(libraryId) ?? undefined;
            
            // Return all fields (including tags and collections)
            const result: Record<string, any> = { ...itemData };

            // Enrich collection keys with names for agent readability
            // toJSON() returns collections as plain key strings: ["ABCD1234", ...]
            // We convert to [{collection_key, name}, ...] so the agent sees meaningful names
            if (Array.isArray(result.collections)) {
                result.collections = result.collections.map((collKey: string) => {
                    try {
                        const coll = Zotero.Collections.getByLibraryAndKey(libraryId, collKey);
                        return {
                            collection_key: collKey,
                            name: coll ? coll.name : collKey,
                        };
                    } catch {
                        return { collection_key: collKey, name: collKey };
                    }
                });
            }
            
            // Handle attachments if requested
            if (request.include_attachments && item.isRegularItem()) {
                const attachmentIds = item.getAttachments();
                if (attachmentIds.length > 0) {
                    // Batch fetch all attachments at once
                    const attachmentItems = await Zotero.Items.getAsync(attachmentIds);
                    
                    // Ensure attachment data is loaded
                    await Zotero.Items.loadDataTypes(attachmentItems, ['primaryData', 'itemData', 'tags', 'collections', 'childItems']);
                    
                    const attachments: any[] = [];
                    const bestAttachment = await item.getBestAttachment();
                    
                    for (const attachment of attachmentItems) {
                        if (!attachment) continue;
                        
                        try {
                            const attachmentInfo = await getAttachmentInfoForItem(attachment, {
                                parentItemId: itemId,
                                isPrimary: bestAttachment ? attachment.id === bestAttachment.id : false,
                                includeAnnotationsCount: true,
                                skipWorkerFallback: true,
                            });
                            attachments.push({
                                ...attachmentInfo,
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
                    await Zotero.Items.loadDataTypes(noteItems, ['primaryData', 'itemData']);

                    const notes: any[] = [];
                    // The requested regular item is the parent; it was loaded with
                    // itemData + creators above, so the bibliographic anchor is
                    // available without another load.
                    const parentSummary = serializeItemStub(item);

                    for (const note of noteItems) {
                        if (!note || !note.isNote()) continue;

                        try {
                            notes.push(serializeNote(note, parentSummary));
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
