/**
 * Hook to register HTTP endpoints for local FrontendCapability.
 * 
 * This hook registers HTTP endpoints on Zotero's local server (port 23119)
 * that expose the agent data provider handlers. The endpoints are only
 * registered when the user is authenticated and the React store is available.
 * 
 * Endpoints are unregistered when the hook unmounts (e.g., user logs out).
 */

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { isAuthenticatedAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import {
    handleZoteroDataRequest,
    handleExternalReferenceCheckRequest,
    handleZoteroAttachmentPagesRequest,
    handleZoteroAttachmentPageImagesRequest,
    handleZoteroAttachmentSearchRequest,
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
    // Library management tools
    handleZoteroSearchRequest,
    handleListItemsRequest,
    handleGetMetadataRequest,
    handleListLibrariesRequest,
} from '../../src/services/agentDataProvider';
import type {
    WSZoteroDataRequest,
    WSExternalReferenceCheckRequest,
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentSearchRequest,
    WSItemSearchByMetadataRequest,
    WSItemSearchByTopicRequest,
    // Library management tools
    WSZoteroSearchRequest,
    WSListItemsRequest,
    WSGetMetadataRequest,
    WSListLibrariesRequest,
} from '../../src/services/agentProtocol';


// =============================================================================
// Types
// =============================================================================

interface ZoteroRequestData {
    method: string;
    pathname: string;
    pathParams: Record<string, string>;
    searchParams: URLSearchParams;
    headers: Headers;
    data: any;
}


// =============================================================================
// Endpoint Helpers
// =============================================================================

/** List of registered endpoint paths for cleanup */
const ENDPOINT_PATHS = [
    '/beaver/zotero-data',
    '/beaver/external-reference-check',
    '/beaver/search/metadata',
    '/beaver/search/topic',
    '/beaver/attachment/pages',
    '/beaver/attachment/page-images',
    '/beaver/attachment/search',
    // Library management tools
    '/beaver/library/search',
    '/beaver/library/list',
    '/beaver/library/metadata',
    '/beaver/library/libraries',
] as const;

/**
 * Generate a simple unique ID for requests.
 */
function generateRequestId(): string {
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.randomString) {
        return Zotero.Utilities.randomString(16);
    }
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Creates a Zotero HTTP endpoint from an async handler function.
 */
function createEndpoint<TRequest, TResponse>(
    handler: (request: TRequest) => Promise<TResponse>
): new () => { supportedMethods: string[]; supportedDataTypes: string[]; init: (requestData: ZoteroRequestData) => Promise<[number, string, string]> } {
    const Endpoint = function(this: any) {} as any;
    
    Endpoint.prototype = {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json"],
        
        async init(requestData: ZoteroRequestData): Promise<[number, string, string]> {
            try {
                const result = await handler(requestData.data);
                return [200, "application/json", JSON.stringify(result)];
            } catch (error) {
                logger(`useHttpEndpoints: Endpoint error: ${error}`, 1);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return [500, "application/json", JSON.stringify({
                    error: errorMessage
                })];
            }
        }
    };
    
    return Endpoint;
}


// =============================================================================
// Endpoint Handlers
// =============================================================================

async function handleZoteroDataHttpRequest(request: any) {
    const wsRequest: WSZoteroDataRequest = {
        event: 'zotero_data_request',
        request_id: generateRequestId(),
        items: request.items,
        include_attachments: request.include_attachments,
        include_parents: request.include_parents,
    };
    
    const response = await handleZoteroDataRequest(wsRequest);
    
    return {
        items: response.items,
        attachments: response.attachments,
        errors: response.errors,
    };
}

async function handleExternalReferenceCheckHttpRequest(request: any) {
    const wsRequest: WSExternalReferenceCheckRequest = {
        event: 'external_reference_check_request',
        request_id: generateRequestId(),
        library_ids: request.library_ids,
        items: request.items,
    };
    
    const response = await handleExternalReferenceCheckRequest(wsRequest);
    
    return {
        results: response.results,
    };
}

async function handleMetadataSearchHttpRequest(request: any) {
    const wsRequest: WSItemSearchByMetadataRequest = {
        event: 'item_search_by_metadata_request',
        request_id: generateRequestId(),
        title_query: request.title_query,
        author_query: request.author_query,
        publication_query: request.publication_query,
        year_min: request.year_min,
        year_max: request.year_max,
        item_type_filter: request.item_type_filter,
        libraries_filter: request.libraries_filter,
        tags_filter: request.tags_filter,
        collections_filter: request.collections_filter,
        limit: request.limit,
    };
    
    const response = await handleItemSearchByMetadataRequest(wsRequest);
    
    return {
        items: response.items,
    };
}

async function handleTopicSearchHttpRequest(request: any) {
    const wsRequest: WSItemSearchByTopicRequest = {
        event: 'item_search_by_topic_request',
        request_id: generateRequestId(),
        topic_query: request.topic_query,
        author_filter: request.author_filter,
        year_min: request.year_min,
        year_max: request.year_max,
        libraries_filter: request.libraries_filter,
        tags_filter: request.tags_filter,
        collections_filter: request.collections_filter,
        limit: request.limit,
    };
    
    const response = await handleItemSearchByTopicRequest(wsRequest);
    
    return {
        items: response.items,
    };
}

async function handleAttachmentPagesHttpRequest(request: any) {
    const wsRequest: WSZoteroAttachmentPagesRequest = {
        event: 'zotero_attachment_pages_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        start_page: request.start_page,
        end_page: request.end_page,
        skip_local_limits: request.skip_local_limits,
    };
    
    const response = await handleZoteroAttachmentPagesRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        pages: response.pages,
        total_pages: response.total_pages,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleAttachmentPageImagesHttpRequest(request: any) {
    const wsRequest: WSZoteroAttachmentPageImagesRequest = {
        event: 'zotero_attachment_page_images_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        pages: request.pages,
        scale: request.scale,
        dpi: request.dpi,
        format: request.format,
        jpeg_quality: request.jpeg_quality,
        skip_local_limits: request.skip_local_limits,
    };
    
    const response = await handleZoteroAttachmentPageImagesRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        pages: response.pages,
        total_pages: response.total_pages,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleAttachmentSearchHttpRequest(request: any) {
    const wsRequest: WSZoteroAttachmentSearchRequest = {
        event: 'zotero_attachment_search_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        query: request.query,
        max_hits_per_page: request.max_hits_per_page,
        skip_local_limits: request.skip_local_limits,
    };
    
    const response = await handleZoteroAttachmentSearchRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        query: response.query,
        total_matches: response.total_matches,
        pages_with_matches: response.pages_with_matches,
        total_pages: response.total_pages,
        pages: response.pages,
        error: response.error,
        error_code: response.error_code,
    };
}


// =============================================================================
// Library Management HTTP Handlers
// =============================================================================

async function handleLibrarySearchHttpRequest(request: any) {
    const wsRequest: WSZoteroSearchRequest = {
        event: 'zotero_search_request',
        request_id: generateRequestId(),
        conditions: request.conditions || [],
        join_mode: request.join_mode || 'all',
        library_id: request.library_id,
        include_children: request.include_children ?? false,
        item_category: request.item_category ?? 'regular',
        recursive: request.recursive ?? true,
        limit: request.limit ?? 10,
        offset: request.offset ?? 0,
        fields: request.fields,
    };
    
    const response = await handleZoteroSearchRequest(wsRequest);
    
    return {
        items: response.items,
        total_count: response.total_count,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleLibraryListHttpRequest(request: any) {
    const wsRequest: WSListItemsRequest = {
        event: 'list_items_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        collection_key: request.collection_key,
        tag: request.tag,
        item_category: request.item_category ?? 'regular',
        recursive: request.recursive ?? true,
        sort_by: request.sort_by || 'dateModified',
        sort_order: request.sort_order || 'desc',
        limit: request.limit ?? 20,
        offset: request.offset ?? 0,
    };
    
    const response = await handleListItemsRequest(wsRequest);
    
    return {
        items: response.items,
        total_count: response.total_count,
        library_name: response.library_name,
        collection_name: response.collection_name,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleLibraryMetadataHttpRequest(request: any) {
    const wsRequest: WSGetMetadataRequest = {
        event: 'get_metadata_request',
        request_id: generateRequestId(),
        item_ids: request.item_ids || [],
        fields: request.fields,
        include_attachments: request.include_attachments ?? false,
        include_notes: request.include_notes ?? false,
        include_tags: request.include_tags ?? true,
        include_collections: request.include_collections ?? false,
    };

    const response = await handleGetMetadataRequest(wsRequest);

    return {
        items: response.items,
        not_found: response.not_found,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleListLibrariesHttpRequest(_request: any) {
    const wsRequest: WSListLibrariesRequest = {
        event: 'list_libraries_request',
        request_id: generateRequestId(),
    };

    const response = await handleListLibrariesRequest(wsRequest);

    return {
        libraries: response.libraries,
        total_count: response.total_count,
        error: response.error,
        error_code: response.error_code,
    };
}


// =============================================================================
// Registration Functions
// =============================================================================

function registerEndpoints(): boolean {
    if (!Zotero?.Server?.Endpoints) {
        logger('useHttpEndpoints: Zotero.Server.Endpoints not available', 2);
        return false;
    }
    
    Zotero.Server.Endpoints['/beaver/zotero-data'] = 
        createEndpoint(handleZoteroDataHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/external-reference-check'] = 
        createEndpoint(handleExternalReferenceCheckHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/search/metadata'] = 
        createEndpoint(handleMetadataSearchHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/search/topic'] = 
        createEndpoint(handleTopicSearchHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/attachment/pages'] = 
        createEndpoint(handleAttachmentPagesHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/attachment/page-images'] = 
        createEndpoint(handleAttachmentPageImagesHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/attachment/search'] = 
        createEndpoint(handleAttachmentSearchHttpRequest);
    
    // Library management endpoints
    Zotero.Server.Endpoints['/beaver/library/search'] = 
        createEndpoint(handleLibrarySearchHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/library/list'] = 
        createEndpoint(handleLibraryListHttpRequest);
    
    Zotero.Server.Endpoints['/beaver/library/metadata'] =
        createEndpoint(handleLibraryMetadataHttpRequest);

    Zotero.Server.Endpoints['/beaver/library/libraries'] =
        createEndpoint(handleListLibrariesHttpRequest);

    logger(`useHttpEndpoints: Registered ${ENDPOINT_PATHS.length} HTTP endpoints`, 3);
    return true;
}

function unregisterEndpoints(): void {
    if (!Zotero?.Server?.Endpoints) {
        return;
    }
    
    for (const path of ENDPOINT_PATHS) {
        if (Zotero.Server.Endpoints[path]) {
            delete Zotero.Server.Endpoints[path];
        }
    }
    
    logger('useHttpEndpoints: Unregistered HTTP endpoints', 3);
}


// =============================================================================
// Hook
// =============================================================================

/**
 * Hook that registers HTTP endpoints when authenticated and unregisters on unmount.
 * 
 * The endpoints are accessible at http://localhost:23119/beaver/...
 * They expose the same handlers used by the WebSocket agent protocol.
 */
export function useHttpEndpoints() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);

    useEffect(() => {
        // Only register endpoints when authenticated (store is available)
        if (!isAuthenticated) {
            return;
        }
        // Only register endpoints in development and staging
        if(process.env.NODE_ENV !== 'development' && process.env.BUILD_ENV !== 'staging') {
            logger('useHttpEndpoints: Not registering endpoints in production', 3);
            return;
        }

        logger('useHttpEndpoints: Registering endpoints (authenticated)', 3);
        const registered = registerEndpoints();

        // Cleanup on unmount or when auth state changes
        return () => {
            if (registered) {
                logger('useHttpEndpoints: Cleaning up endpoints', 3);
                unregisterEndpoints();
            }
        };
    }, [isAuthenticated]);
}
