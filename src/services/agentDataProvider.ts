/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../utils/logger';
import { ZoteroItemStatus, ItemDataWithStatus, AttachmentDataWithStatus } from '../../react/types/zotero';
import { safeIsInTrash } from '../utils/zoteroUtils';
import { syncingItemFilterAsync } from '../utils/sync';
import { syncLibraryIdsAtom, syncWithZoteroAtom } from '../../react/atoms/profile';
import { userIdAtom } from '../../react/atoms/auth';

import { store } from '../../react/store';
import { isAttachmentOnServer } from '../utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../../react/utils/sourceUtils';
import { serializeAttachment, serializeItem } from '../utils/zoteroSerializers';
import { FindReferenceData, findExistingReference } from '../../react/utils/findExistingReference';
import {
    WSZoteroDataRequest,
    WSZoteroDataResponse,
    WSDataError,
    WSExternalReferenceCheckRequest,
    WSExternalReferenceCheckResponse,
    ExternalReferenceCheckResult,
    WSAttachmentContentRequest,
    WSAttachmentContentResponse,
    WSPageContent,
    WSZoteroItemSearchRequest,
    WSZoteroItemSearchResponse,
    ZoteroItemSearchResultItem,
} from './agentProtocol';
import { searchItemsByTopic, searchItemsByAuthor, searchItemsByPublication, TopicSearchParams, ZoteroItemSearchFilters } from '../../react/utils/searchTools';

/**
 * Handle zotero_data_request event.
 * Fetches item/attachment metadata for the requested references.
 */
export async function handleZoteroDataRequest(request: WSZoteroDataRequest): Promise<WSZoteroDataResponse> {
    const errors: WSDataError[] = [];

    // Get sync configuration from store
    const syncLibraryIds = store.get(syncLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Track keys to avoid duplicates when including parents/attachments
    const itemKeys = new Set<string>();
    const attachmentKeys = new Set<string>();

    // Collect Zotero items to serialize
    const itemsToSerialize: Zotero.Item[] = [];
    const attachmentsToSerialize: Zotero.Item[] = [];

    const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

    // Phase 1: Collect primary items from request (don't access parentID/getAttachments yet)
    const primaryItems: Zotero.Item[] = [];
    const referenceToItem = new Map<string, Zotero.Item>();
    
    for (const reference of request.items) {
        try {
            const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
            if (!zoteroItem) {
                errors.push({
                    reference,
                    error: 'Item not found in local database',
                    error_code: 'not_found'
                });
                continue;
            }
            primaryItems.push(zoteroItem);
            referenceToItem.set(makeKey(reference.library_id, reference.zotero_key), zoteroItem);
        } catch (error: any) {
            logger(`AgentService: Failed to load zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            errors.push({
                reference,
                error: 'Failed to load item',
                error_code: 'load_failed'
            });
        }
    }

    // Phase 2: Load data types for primary items BEFORE accessing parentID/getAttachments
    if (primaryItems.length > 0) {
        await Zotero.Items.loadDataTypes(primaryItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    // Phase 3: Now expand to parents and children (safe to access parentID/getAttachments)
    for (const reference of request.items) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue; // Already recorded error in Phase 1

        try {
            if (zoteroItem.isAttachment()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!attachmentKeys.has(key)) {
                    attachmentKeys.add(key);
                    attachmentsToSerialize.push(zoteroItem);
                }

                // Include parent item if requested
                if (request.include_parents && zoteroItem.parentID) {
                    const parentItem = await Zotero.Items.getAsync(zoteroItem.parentID);
                    if (parentItem && !parentItem.isAttachment()) {
                        const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                        if (!itemKeys.has(parentKey)) {
                            itemKeys.add(parentKey);
                            itemsToSerialize.push(parentItem);
                        }
                    }
                }
            } else if (zoteroItem.isRegularItem()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!itemKeys.has(key)) {
                    itemKeys.add(key);
                    itemsToSerialize.push(zoteroItem);
                }

                // Include attachments if requested
                if (request.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        const attachment = await Zotero.Items.getAsync(attachmentId);
                        if (attachment) {
                            const attKey = makeKey(attachment.libraryID, attachment.key);
                            if (!attachmentKeys.has(attKey)) {
                                attachmentKeys.add(attKey);
                                attachmentsToSerialize.push(attachment);
                            }
                        }
                    }
                }
            } else {
                errors.push({
                    reference,
                    error: 'Item is not a regular item or attachment',
                    error_code: 'filtered_from_sync'
                });
            }
        } catch (error: any) {
            logger(`AgentService: Failed to expand zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed'
            });
        }
    }

    // Phase 4: Load data for all items (including newly discovered parents and children)
    const allItems = [...itemsToSerialize, ...attachmentsToSerialize];
    if (allItems.length > 0) {
        // Load all item data in bulk
        await Zotero.Items.loadDataTypes(allItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
        
        // Load parent items for attachments (needed for isInTrash() to check parent trash status)
        const parentIds = [...new Set(
            allItems
                .filter(item => item.parentID)
                .map(item => item.parentID as number)
        )];
        if (parentIds.length > 0) {
            const parentItems = await Zotero.Items.getAsync(parentIds);
            if (parentItems.length > 0) {
                await Zotero.Items.loadDataTypes(parentItems, ["primaryData"]);
            }
        }
    }

    // Helper function to compute status for an item
    const computeStatus = async (item: Zotero.Item): Promise<ZoteroItemStatus> => {
        const isSyncedLibrary = syncLibraryIds.includes(item.libraryID);
        const trashState = safeIsInTrash(item);
        const isInTrash = trashState === true;
        const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
        const passesSyncFilters = availableLocallyOrOnServer && (await syncingItemFilterAsync(item));
        
        // Compute is_pending_sync only if we have a userId
        let isPendingSync: boolean | null = null;
        if (userId) {
            try {
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                isPendingSync = !wasAddedBeforeSync;
            } catch (e) {
                // Unable to determine pending status
                isPendingSync = null;
            }
        }

        return {
            is_synced_library: isSyncedLibrary,
            is_in_trash: isInTrash,
            available_locally_or_on_server: availableLocallyOrOnServer,
            passes_sync_filters: passesSyncFilters,
            is_pending_sync: isPendingSync
        };
    };

    // Phase 3: Serialize all items and attachments with status
    const [itemResults, attachmentResults] = await Promise.all([
        Promise.all(itemsToSerialize.map(async (item): Promise<ItemDataWithStatus | null> => {
            const serialized = await serializeItem(item, undefined);
            const status = await computeStatus(item);
            return { item: serialized, status };
        })),
        Promise.all(attachmentsToSerialize.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
            const serialized = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
            if (!serialized) {
                errors.push({
                    reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                    error: 'Attachment not available locally',
                    error_code: 'not_available'
                });
                return null;
            }
            const status = await computeStatus(attachment);
            return { attachment: serialized, status };
        }))
    ]);

    // Filter out null results
    const items = itemResults.filter((i): i is ItemDataWithStatus => i !== null);
    const attachments = attachmentResults.filter((a): a is AttachmentDataWithStatus => a !== null);

    const response: WSZoteroDataResponse = {
        type: 'zotero_data',
        request_id: request.request_id,
        items,
        attachments,
        errors: errors.length > 0 ? errors : undefined
    };

    return response;   
}


/**
 * Handle attachment_content_request event.
 * Currently returns placeholder content until full extraction is implemented.
 */
export async function handleAttachmentContentRequest(request: WSAttachmentContentRequest): Promise<WSAttachmentContentResponse> {
    const pageNumbers = request.page_numbers && request.page_numbers.length > 0
        ? request.page_numbers
        : [1];

    const pages: WSPageContent[] = pageNumbers.map((pageNumber) => ({
        page_number: pageNumber,
        content: 'Attachment content retrieval not implemented yet.'
    }));

    const response: WSAttachmentContentResponse = {
        type: 'attachment_content',
        request_id: request.request_id,
        attachment: request.attachment,
        pages,
        total_pages: null,
        error: 'Attachment content retrieval not implemented'
    };

    return response;
}


/**
 * Handle external_reference_check_request event.
 */
export async function handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<WSExternalReferenceCheckResponse> {
    const results: ExternalReferenceCheckResult[] = [];

    // Process all items in parallel for efficiency
    const checkPromises = request.items.map(async (item): Promise<ExternalReferenceCheckResult> => {
        try {
            const referenceData: FindReferenceData = {
                title: item.title,
                date: item.date,
                DOI: item.doi,
                ISBN: item.isbn,
                creators: item.creators
            };

            const existingItem = await findExistingReference(request.library_id, referenceData);

            if (existingItem) {
                return {
                    id: item.id,
                    exists: true,
                    item: {
                        library_id: existingItem.libraryID,
                        zotero_key: existingItem.key
                    }
                };
            }

            return {
                id: item.id,
                exists: false
            };
        } catch (error) {
            logger(`AgentService: Failed to check reference ${item.id}: ${error}`, 1);
            // Return as not found on error
            return {
                id: item.id,
                exists: false
            };
        }
    });

    const resolvedResults = await Promise.all(checkPromises);
    results.push(...resolvedResults);

    const response: WSExternalReferenceCheckResponse = {
        type: 'external_reference_check',
        request_id: request.request_id,
        results
    };

    return response;
}


/**
 * Handle zotero_item_search_request event.
 * Searches the user's Zotero library and returns matching items with attachments.
 * 
 * Algorithm:
 * 1. Validate: At least one query parameter must be provided
 * 2. Apply query matching (AND logic between different query types):
 *    - topic_query: search title+abstract for each phrase (OR within)
 *    - author_query: search creator names
 *    - publication_query: search publication/journal name
 * 3. Apply filters to narrow results (year, type, libraries, tags, collections)
 * 4. Return items with attachments
 */
export async function handleZoteroItemSearchRequest(request: WSZoteroItemSearchRequest): Promise<WSZoteroItemSearchResponse> {
    // Validate: at least one query parameter must be provided
    const hasQuery = (request.topic_query && request.topic_query.length > 0) ||
                     !!request.author_query ||
                     !!request.publication_query;

    if (!hasQuery) {
        logger('handleZoteroItemSearchRequest: No query parameters provided', 1);
        return {
            type: 'zotero_item_search',
            request_id: request.request_id,
            items: [],
            matched_tier: 'primary',
        };
    }

    // Get synced library IDs and apply libraries_filter if provided
    let syncLibraryIds = store.get(syncLibraryIdsAtom);
    
    if (syncLibraryIds.length === 0) {
        logger('handleZoteroItemSearchRequest: No synced libraries configured', 1);
        return {
            type: 'zotero_item_search',
            request_id: request.request_id,
            items: [],
            matched_tier: 'primary',
        };
    }

    // Apply libraries_filter if provided
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        // Convert library names/IDs to library IDs
        const requestedLibraryIds = new Set<number>();
        
        for (const libraryFilter of request.libraries_filter) {
            if (typeof libraryFilter === 'number') {
                // It's a library ID
                if (syncLibraryIds.includes(libraryFilter)) {
                    requestedLibraryIds.add(libraryFilter);
                }
            } else if (typeof libraryFilter === 'string') {
                // It's a library name - find matching libraries
                const allLibraries = Zotero.Libraries.getAll();
                for (const lib of allLibraries) {
                    if (syncLibraryIds.includes(lib.libraryID) && 
                        lib.name.toLowerCase().includes(libraryFilter.toLowerCase())) {
                        requestedLibraryIds.add(lib.libraryID);
                    }
                }
            }
        }

        if (requestedLibraryIds.size > 0) {
            syncLibraryIds = Array.from(requestedLibraryIds);
        } else {
            // No matching libraries found
            logger('handleZoteroItemSearchRequest: No matching libraries found in filter', 1);
            return {
                type: 'zotero_item_search',
                request_id: request.request_id,
                items: [],
                matched_tier: 'primary',
            };
        }
    }

    // Convert collections_filter names to keys if needed
    const collectionKeys: string[] = [];
    if (request.collections_filter && request.collections_filter.length > 0) {
        for (const collectionFilter of request.collections_filter) {
            if (typeof collectionFilter === 'string') {
                // Could be a key or a name
                // Check if it looks like a Zotero key (8 alphanumeric characters)
                if (/^[A-Z0-9]{8}$/i.test(collectionFilter)) {
                    collectionKeys.push(collectionFilter);
                } else {
                    // Treat as name, search for matching collections across libraries
                    for (const libraryId of syncLibraryIds) {
                        const collections = Zotero.Collections.getByLibrary(libraryId);
                        for (const collection of collections) {
                            if (collection.name.toLowerCase().includes(collectionFilter.toLowerCase())) {
                                collectionKeys.push(collection.key);
                            }
                        }
                    }
                }
            } else if (typeof collectionFilter === 'number') {
                // It's a collection ID - convert to key
                const collection = Zotero.Collections.get(collectionFilter);
                if (collection) {
                    collectionKeys.push(collection.key);
                }
            }
        }
    }

    // Build filters from request
    const filters: ZoteroItemSearchFilters = {
        year_min: request.year_min,
        year_max: request.year_max,
        item_type_filter: request.item_type_filter,
        libraries_filter: syncLibraryIds,
        collections_filter: collectionKeys.length > 0 ? collectionKeys : undefined,
        tags_filter: request.tags_filter,
        limit: request.limit,
    };

    // Step 1: Execute queries based on what's provided
    let items: Zotero.Item[] = [];

    // Topic query (searches title + abstract)
    if (request.topic_query && request.topic_query.length > 0) {
        const topicParams: TopicSearchParams = {
            topic_phrases: request.topic_query,
            author_query: request.author_query,
            publication_query: request.publication_query,
        };
        items = await searchItemsByTopic(syncLibraryIds, topicParams, filters);
    }
    // Author-only query
    else if (request.author_query && !request.publication_query) {
        items = await searchItemsByAuthor(syncLibraryIds, request.author_query, filters);
    }
    // Publication-only query
    else if (request.publication_query && !request.author_query) {
        items = await searchItemsByPublication(syncLibraryIds, request.publication_query, filters);
    }
    // Both author and publication (need to intersect results)
    else if (request.author_query && request.publication_query) {
        // Search by author first
        const authorItems = await searchItemsByAuthor(syncLibraryIds, request.author_query, {
            ...filters,
            limit: 0, // No limit for intermediate result
        });
        
        // Filter by publication
        const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;
        const authorItemKeys = new Set(authorItems.map(item => makeKey(item.libraryID, item.key)));
        
        const publicationItems = await searchItemsByPublication(syncLibraryIds, request.publication_query, {
            ...filters,
            limit: 0, // No limit for intermediate result
        });
        
        // Keep only items that match both
        items = publicationItems.filter(item => 
            authorItemKeys.has(makeKey(item.libraryID, item.key))
        );
    }

    // Step 2: Apply limit
    const limitedItems = request.limit > 0 ? items.slice(0, request.limit) : items;

    // Step 3: Serialize items with attachments
    const resultItems: ZoteroItemSearchResultItem[] = [];
    
    // Load all item data in bulk for efficiency
    if (limitedItems.length > 0) {
        await Zotero.Items.loadDataTypes(limitedItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    for (const item of limitedItems) {
        try {
            // Serialize the item
            const itemData = await serializeItem(item, undefined);

            // Get and serialize attachments
            const attachmentIds = item.getAttachments();
            const attachments: import('../../react/types/zotero').AttachmentData[] = [];

            if (attachmentIds.length > 0) {
                const attachmentItems = await Zotero.Items.getAsync(attachmentIds);
                await Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData"]);

                for (const attachment of attachmentItems) {
                    if (!attachment.deleted) {
                        const attachmentData = await serializeAttachment(attachment, undefined, { skipSyncingFilter: true });
                        if (attachmentData) {
                            attachments.push(attachmentData);
                        }
                    }
                }
            }

            resultItems.push({
                item: itemData,
                attachments,
            });
        } catch (error) {
            logger(`handleZoteroItemSearchRequest: Failed to serialize item ${item.key}: ${error}`, 1);
        }
    }

    const response: WSZoteroItemSearchResponse = {
        type: 'zotero_item_search',
        request_id: request.request_id,
        items: resultItems,
        matched_tier: 'primary',
    };

    return response;
}