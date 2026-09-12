import { handleArtifactRequest, artifactFailure } from './artifacts/artifactProvider';
import type { OperationContext } from './agentDataProvider/operationContext';
/**
 * Zotero implementation of the agent data-provider map.
 *
 * Builds the `AgentDataProviderMap` (see `agentDataDispatch.ts`) backed by the
 * Zotero plugin's handlers, and registers it as the default provider via
 * `setDefaultAgentDataProvider`. This is the module that pulls in the full
 * handler tree, so shared transport code stays free of it until this file is
 * actually imported (see `registerZoteroDataProvider` below).
 */

import { AgentDataProviderMap, setDefaultAgentDataProvider } from '@beaver/agent-core/transport/agentDataDispatch';
import {
    handleAgentActionExecuteRequest,
    handleAgentActionValidateRequest,
    handleExternalReferenceCheckRequest,
    handleFindAnnotationsRequest,
    handleGetAnnotationsRequest,
    handleGetMetadataRequest,
    handleItemQuickSearchRequest,
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
    handleListCollectionsRequest,
    handleListItemsRequest,
    handleListLibrariesRequest,
    handleListTagsRequest,
    handleReadNoteRequest,
    handleResolvePopulationRequest,
    handleResolveSearchFiltersRequest,
    handleZoteroAttachmentImageRequest,
    handleZoteroAttachmentPageImagesRequest,
    handleZoteroAttachmentSearchRequest,
    handleZoteroDataRequest,
    handleZoteroDocumentRequest,
    handleZoteroSearchRequest,
    handleZoteroViewImagesRequest,
} from './agentDataProvider';
import {
    pauseSyncForMutatingRun
} from './syncPause';

export interface ZoteroDataProviderOptions {
    source?: "local" | "provider";
    operationContext?: () => OperationContext;
}

/**
 * Build the data-provider map backed by the Zotero plugin's handlers. This is
 * the default provider for `AgentService` and preserves the exact handlers and
 * per-request error fallbacks the plugin has always sent.
 */
export function createZoteroDataProvider(options: ZoteroDataProviderOptions = {}): AgentDataProviderMap {

    return {
        artifact_request: {
            handle: (event, context) => {
                const operation = options.operationContext?.();
                return handleArtifactRequest(event, {
                    ...context,
                    owner: operation?.owner ?? context?.owner,
                });
            },
            errorResponse: (event) => artifactFailure(event),
        },
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
        resolve_search_filters_request: {
            handle: handleResolveSearchFiltersRequest,
            errorResponse: (event, err) => ({
                type: 'resolve_search_filters',
                request_id: event.request_id,
                attachments: [],
                error: String(err),
                error_code: 'internal_error',
            }),
        },
        item_quick_search_request: {
            handle: handleItemQuickSearchRequest,
            errorResponse: (event, err) => ({
                type: 'item_quick_search',
                request_id: event.request_id,
                items: [],
                detail: event.detail === 'full' ? 'full' : 'compact',
                total_count: 0,
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
        resolve_population_request: {
            handle: handleResolvePopulationRequest,
            errorResponse: (event, err) => ({
                type: 'resolve_population',
                request_id: event.request_id,
                item_ids: [],
                total_count: 0,
                truncated: false,
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
            handle: event => handleAgentActionValidateRequest({ ...event, operation: options.operationContext?.() }),
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
            handle: async (event, context) => {
                // Capture source state immediately; the instance queue owns waiting
                // and starts the execution deadline when the operation enters.
                const operation = options.operationContext?.();
                if (operation?.runId && event.run_id && operation.runId !== event.run_id) {
                    throw Object.assign(new Error('Request belongs to another run'), { code: 'operation_cancelled' });
                }
                // Only local chats hold sync across requests. Originless writes
                // use the plugin-owned queue token, whose release survives closing
                // the renderer that currently hosts this transport.
                if (operation?.owner && operation.runId) {
                    pauseSyncForMutatingRun(`chat:${operation.owner}:${operation.runId}`);
                }
                return handleAgentActionExecuteRequest({ ...event, operation }, {
                    ...context,
                    receivedAt: context?.receivedAt ?? Date.now(),
                    reportPhase: context?.reportPhase ?? (() => {}),
                    owner: operation?.owner ?? context?.owner,
                });
            },
            // No transport-local queue: capture identity/citations at receipt, then
            // serialize all clients through the instance mutation service.
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

/**
 * Register the Zotero data-provider factory as the default. Call once at
 * webpack bundle init (from `react/index.tsx`), alongside `registerZoteroHost()`.
 */
export function registerZoteroDataProvider(factory = createZoteroDataProvider): void {
    setDefaultAgentDataProvider(factory);
}
