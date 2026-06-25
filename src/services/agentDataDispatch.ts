/**
 * Agent data-request dispatch map.
 *
 * Maps each backend data-request event to a handler plus the error-fallback
 * response sent when the handler throws (so the backend never times out).
 * `AgentService` looks requests up here instead of hardcoding a switch case per
 * request type, which makes the data layer injectable: the Zotero plugin uses
 * `createZoteroDataProvider()`; a different host (e.g. a Word add-in) can inject
 * its own map (e.g. forwarding requests to a local Zotero HTTP server) without
 * touching the WebSocket/streaming logic.
 *
 * Behavior note: entries marked `serialize` are chained onto the action
 * execution queue so concurrent mutating actions don't race.
 */

import {
    handleZoteroDataRequest,
    handleExternalReferenceCheckRequest,
    handleZoteroDocumentRequest,
    handleZoteroAttachmentPageImagesRequest,
    handleZoteroAttachmentImageRequest,
    handleZoteroViewImagesRequest,
    handleZoteroAttachmentSearchRequest,
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
    handleZoteroSearchRequest,
    handleListItemsRequest,
    handleListCollectionsRequest,
    handleListTagsRequest,
    handleListLibrariesRequest,
    handleGetMetadataRequest,
    handleGetAnnotationsRequest,
    handleFindAnnotationsRequest,
    handleAgentActionValidateRequest,
    handleAgentActionExecuteRequest,
    handleReadNoteRequest,
} from './agentDataProvider';
import type { PreparedJsonMessage } from './preparedJsonMessage';
import {
    SyncPauseOwner,
    LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER,
    pauseSyncForMutatingRun,
} from './syncPause';

/** A single data-request handler plus its error-fallback response. */
export interface AgentDataRequestEntry {
    /** Run the request and resolve with the response object to send back. */
    handle: (event: any) => Promise<Record<string, any> | PreparedJsonMessage>;
    /** Build the response to send when `handle` rejects (keeps the backend from timing out). */
    errorResponse: (event: any, err: unknown) => Record<string, any>;
    /**
     * When true, the request is chained onto the serialized action-execution
     * queue (prevents concurrent mutating actions from racing).
     */
    serialize?: boolean;
    /** Sync pause owner to release when this mutating request settles. */
    syncPauseOwner?: SyncPauseOwner;
}

/** Map from backend request event name to its handler entry. */
export type AgentDataProviderMap = Record<string, AgentDataRequestEntry>;

export interface ZoteroDataProviderOptions {
    /** Owner token used for sync suppression around mutating actions. */
    syncPauseOwner?: SyncPauseOwner;
}

/**
 * Build the data-provider map backed by the Zotero plugin's handlers. This is
 * the default provider for `AgentService` and preserves the exact handlers and
 * per-request error fallbacks the plugin has always sent.
 */
export function createZoteroDataProvider(options: ZoteroDataProviderOptions = {}): AgentDataProviderMap {
    const syncPauseOwner = options.syncPauseOwner ?? LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER;

    return {
        zotero_document_request: {
            handle: (event) => handleZoteroDocumentRequest(event, { responseMode: 'websocket' }),
            errorResponse: (event, err) => ({
                type: 'zotero_document',
                request_id: event.request_id,
                external_file_key: event.external_file_key ?? null,
                content_kind: null,
                total_pages: null,
                error: String(err),
                error_code: 'extraction_failed',
            }),
        },
        zotero_attachment_page_images_request: {
            handle: handleZoteroAttachmentPageImagesRequest,
            errorResponse: (event, err) => ({
                type: 'zotero_attachment_page_images',
                request_id: event.request_id,
                attachment: event.attachment,
                pages: [],
                total_pages: null,
                error: String(err),
                error_code: 'render_failed',
            }),
        },
        zotero_attachment_image_request: {
            handle: handleZoteroAttachmentImageRequest,
            errorResponse: (event, err) => ({
                type: 'zotero_attachment_image',
                request_id: event.request_id,
                attachment: event.attachment,
                resolved_attachment: null,
                image: null,
                error: String(err),
                error_code: 'image_processing_failed',
            }),
        },
        zotero_view_images_request: {
            handle: handleZoteroViewImagesRequest,
            errorResponse: (event, err) => ({
                type: 'zotero_view_images',
                request_id: event.request_id,
                // Echo whichever identity the request carried (external-file
                // requests have no attachment reference).
                attachment: event.attachment ?? null,
                external_file_key: event.external_file_key ?? null,
                resolved_attachment: null,
                kind: null,
                images: [],
                total_pages: null,
                error: String(err),
                error_code: 'view_failed',
            }),
        },
        zotero_attachment_search_request: {
            handle: handleZoteroAttachmentSearchRequest,
            errorResponse: (event, err) => ({
                type: 'zotero_attachment_search',
                request_id: event.request_id,
                attachment: event.attachment,
                query: event.query,
                total_matches: 0,
                pages_with_matches: 0,
                total_pages: null,
                pages: [],
                error: String(err),
                error_code: 'search_failed',
            }),
        },
        external_reference_check_request: {
            handle: handleExternalReferenceCheckRequest,
            // Empty results - backend treats as "none found"
            errorResponse: (event) => ({
                type: 'external_reference_check',
                request_id: event.request_id,
                results: [],
            }),
        },
        zotero_data_request: {
            handle: handleZoteroDataRequest,
            errorResponse: (event, err) => ({
                type: 'zotero_data',
                request_id: event.request_id,
                items: [],
                attachments: [],
                errors: (event.items ?? []).map((ref: any) => ({
                    reference: ref,
                    error: String(err),
                    error_code: 'load_failed',
                })),
            }),
        },
        item_search_by_metadata_request: {
            handle: handleItemSearchByMetadataRequest,
            errorResponse: (event, err) => ({
                type: 'item_search_by_metadata',
                request_id: event.request_id,
                items: [],
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        item_search_by_topic_request: {
            handle: handleItemSearchByTopicRequest,
            errorResponse: (event, err) => ({
                type: 'item_search_by_topic',
                request_id: event.request_id,
                items: [],
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        zotero_search_request: {
            handle: handleZoteroSearchRequest,
            errorResponse: (event, err) => ({
                type: 'zotero_search',
                request_id: event.request_id,
                items: [],
                total_count: 0,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        list_items_request: {
            handle: handleListItemsRequest,
            errorResponse: (event, err) => ({
                type: 'list_items',
                request_id: event.request_id,
                items: [],
                total_count: 0,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        get_metadata_request: {
            handle: handleGetMetadataRequest,
            errorResponse: (event, err) => ({
                type: 'get_metadata',
                request_id: event.request_id,
                items: [],
                not_found: event.item_ids,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        get_annotations_request: {
            handle: handleGetAnnotationsRequest,
            errorResponse: (event, err) => ({
                type: 'get_annotations',
                request_id: event.request_id,
                annotations: [],
                total_count: 0,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        find_annotations_request: {
            handle: handleFindAnnotationsRequest,
            errorResponse: (event, err) => ({
                type: 'find_annotations',
                request_id: event.request_id,
                annotations: [],
                total_count: 0,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        list_collections_request: {
            handle: handleListCollectionsRequest,
            errorResponse: (event, err) => ({
                type: 'list_collections',
                request_id: event.request_id,
                collections: [],
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        list_tags_request: {
            handle: handleListTagsRequest,
            errorResponse: (event, err) => ({
                type: 'list_tags',
                request_id: event.request_id,
                tags: [],
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        list_libraries_request: {
            handle: handleListLibrariesRequest,
            errorResponse: (event, err) => ({
                type: 'list_libraries',
                request_id: event.request_id,
                libraries: [],
                total_count: 0,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        read_note_request: {
            handle: handleReadNoteRequest,
            errorResponse: (event, err) => ({
                type: 'read_note',
                request_id: event.request_id,
                success: false,
                error: String(err),
            }),
        },
        agent_action_validate: {
            handle: handleAgentActionValidateRequest,
            errorResponse: (event, err) => ({
                type: 'agent_action_validate_response',
                request_id: event.request_id,
                valid: false,
                error: String(err),
                error_code: 'internal_error',
                preference: 'always_ask',
            }),
        },
        agent_action_execute: {
            handle: async (event) => {
                pauseSyncForMutatingRun(syncPauseOwner);
                return handleAgentActionExecuteRequest(event);
            },
            syncPauseOwner,
            // Serialized: concurrent edit_note actions on the same note otherwise
            // race (each reads the original HTML and saves its own edit, so only
            // the last save survives).
            serialize: true,
            errorResponse: (event, err) => ({
                type: 'agent_action_execute_response',
                request_id: event.request_id,
                success: false,
                error: String(err),
                error_code: 'internal_error',
            }),
        },
    };
}
