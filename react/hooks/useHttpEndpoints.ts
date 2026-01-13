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
} from '../../src/services/agentDataProvider';
import type {
    WSZoteroDataRequest,
    WSExternalReferenceCheckRequest,
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentSearchRequest,
    WSItemSearchByMetadataRequest,
    WSItemSearchByTopicRequest,
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
