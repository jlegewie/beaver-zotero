/**
 * HTTP Endpoints for Local FrontendCapability
 * 
 * This module registers HTTP endpoints on Zotero's local server (port 23119)
 * that expose the same handlers used by the WebSocket agent protocol.
 * 
 * These endpoints enable the backend to communicate with the Zotero plugin
 * via HTTP for testing, evaluations, and local-only usage scenarios.
 * 
 * Note: We use dynamic imports to avoid loading agentDataProvider at startup,
 * which would cause "process is not defined" errors due to React store dependencies.
 * 
 * Note: We use Zotero.debug() directly instead of the logger utility because
 * this module loads during bootstrap when console is not available.
 */


// Type-only imports (don't cause runtime loading)
import type {
    WSZoteroDataRequest,
    WSExternalReferenceCheckRequest,
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPageImagesRequest,
    WSItemSearchByMetadataRequest,
    WSItemSearchByTopicRequest,
} from './agentProtocol';

// Lazy-loaded handler module reference
let _handlers: typeof import('./agentDataProvider') | null = null;

/**
 * Get the handlers module, loading it lazily on first use.
 * This avoids loading agentDataProvider (and its React dependencies) at startup.
 */
async function getHandlers() {
    if (!_handlers) {
        _handlers = await import('./agentDataProvider');
    }
    return _handlers;
}


// =============================================================================
// Types for HTTP Request/Response
// =============================================================================

/**
 * Request body for /beaver/zotero-data endpoint
 */
interface ZoteroDataHttpRequest {
    items: Array<{ library_id: number; zotero_key: string }>;
    include_attachments: boolean;
    include_parents: boolean;
}

/**
 * Request body for /beaver/external-reference-check endpoint
 */
interface ExternalReferenceCheckHttpRequest {
    library_ids?: number[];
    items: Array<{
        id: string;
        title?: string;
        date?: string;
        doi?: string;
        isbn?: string;
        creators?: string[];
    }>;
}

/**
 * Request body for /beaver/search/metadata endpoint
 */
interface MetadataSearchHttpRequest {
    title_query?: string;
    author_query?: string;
    publication_query?: string;
    year_min?: number;
    year_max?: number;
    item_type_filter?: string;
    libraries_filter?: (string | number)[];
    tags_filter?: string[];
    collections_filter?: (string | number)[];
    limit: number;
}

/**
 * Request body for /beaver/search/topic endpoint
 */
interface TopicSearchHttpRequest {
    topic_query: string;
    author_filter?: string[];
    year_min?: number;
    year_max?: number;
    libraries_filter?: (string | number)[];
    tags_filter?: string[];
    collections_filter?: (string | number)[];
    limit: number;
}

/**
 * Request body for /beaver/attachment/pages endpoint
 */
interface AttachmentPagesHttpRequest {
    attachment: { library_id: number; zotero_key: string };
    start_page?: number;
    end_page?: number;
    skip_local_limits?: boolean;
}

/**
 * Request body for /beaver/attachment/page-images endpoint
 */
interface AttachmentPageImagesHttpRequest {
    attachment: { library_id: number; zotero_key: string };
    pages?: number[];
    scale?: number;
    dpi?: number;
    format?: 'png' | 'jpeg';
    jpeg_quality?: number;
    skip_local_limits?: boolean;
}

/**
 * Zotero HTTP server request data structure
 */
interface ZoteroRequestData {
    method: string;
    pathname: string;
    pathParams: Record<string, string>;
    searchParams: URLSearchParams;
    headers: Headers;
    data: any;
}


// =============================================================================
// Endpoint Factory
// =============================================================================

/**
 * Creates a Zotero HTTP endpoint from an async handler function.
 * Handles JSON parsing, error handling, and response formatting.
 * 
 * @param handler Async function that processes the request data and returns a response
 * @returns Endpoint constructor for Zotero.Server.Endpoints
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
                ztoolkit.log(`createEndpoint: Endpoint error: ${error}`);
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

/**
 * Generate a simple unique ID for requests.
 * Uses Zotero's utility if available, falls back to timestamp-based ID.
 */
function generateRequestId(): string {
    // Use Zotero's built-in random string generator if available
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.randomString) {
        return Zotero.Utilities.randomString(16);
    }
    // Fallback to timestamp + random
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Handler for /beaver/zotero-data endpoint.
 * Fetches item/attachment metadata for the requested references.
 */
async function handleZoteroDataHttpRequest(request: ZoteroDataHttpRequest) {
    const handlers = await getHandlers();
    
    // Convert HTTP request to WebSocket request format
    const wsRequest: WSZoteroDataRequest = {
        event: 'zotero_data_request',
        request_id: generateRequestId(),
        items: request.items,
        include_attachments: request.include_attachments,
        include_parents: request.include_parents,
    };
    
    const response = await handlers.handleZoteroDataRequest(wsRequest);
    
    // Strip WebSocket-specific fields from response
    return {
        items: response.items,
        attachments: response.attachments,
        errors: response.errors,
    };
}

/**
 * Handler for /beaver/external-reference-check endpoint.
 * Checks if external references already exist in the user's Zotero library.
 */
async function handleExternalReferenceCheckHttpRequest(request: ExternalReferenceCheckHttpRequest) {
    const handlers = await getHandlers();
    
    const wsRequest: WSExternalReferenceCheckRequest = {
        event: 'external_reference_check_request',
        request_id: generateRequestId(),
        library_ids: request.library_ids,
        items: request.items,
    };
    
    const response = await handlers.handleExternalReferenceCheckRequest(wsRequest);
    
    return {
        results: response.results,
    };
}

/**
 * Handler for /beaver/search/metadata endpoint.
 * Searches the user's Zotero library by metadata fields.
 */
async function handleMetadataSearchHttpRequest(request: MetadataSearchHttpRequest) {
    const handlers = await getHandlers();
    
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
    
    const response = await handlers.handleItemSearchByMetadataRequest(wsRequest);
    
    return {
        items: response.items,
    };
}

/**
 * Handler for /beaver/search/topic endpoint.
 * Searches the user's Zotero library using semantic similarity.
 */
async function handleTopicSearchHttpRequest(request: TopicSearchHttpRequest) {
    const handlers = await getHandlers();
    
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
    
    const response = await handlers.handleItemSearchByTopicRequest(wsRequest);
    
    return {
        items: response.items,
    };
}

/**
 * Handler for /beaver/attachment/pages endpoint.
 * Extracts text content from PDF attachment pages.
 */
async function handleAttachmentPagesHttpRequest(request: AttachmentPagesHttpRequest) {
    const handlers = await getHandlers();
    
    const wsRequest: WSZoteroAttachmentPagesRequest = {
        event: 'zotero_attachment_pages_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        start_page: request.start_page,
        end_page: request.end_page,
        skip_local_limits: request.skip_local_limits,
    };
    
    const response = await handlers.handleZoteroAttachmentPagesRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        pages: response.pages,
        total_pages: response.total_pages,
        error: response.error,
        error_code: response.error_code,
    };
}

/**
 * Handler for /beaver/attachment/page-images endpoint.
 * Renders PDF pages as images (base64-encoded).
 */
async function handleAttachmentPageImagesHttpRequest(request: AttachmentPageImagesHttpRequest) {
    const handlers = await getHandlers();
    
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
    
    const response = await handlers.handleZoteroAttachmentPageImagesRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        pages: response.pages,
        total_pages: response.total_pages,
        error: response.error,
        error_code: response.error_code,
    };
}


// =============================================================================
// Endpoint Registration
// =============================================================================

/** List of registered endpoint paths for cleanup */
const ENDPOINT_PATHS = [
    '/beaver/zotero-data',
    '/beaver/external-reference-check',
    '/beaver/search/metadata',
    '/beaver/search/topic',
    '/beaver/attachment/pages',
    '/beaver/attachment/page-images',
] as const;

/**
 * Registers all Beaver HTTP endpoints with Zotero's local server.
 * 
 * The endpoints are accessible at http://localhost:23119/beaver/...
 * 
 * Call this during plugin startup (onStartup).
 */
export function registerHttpEndpoints(): void {
    ztoolkit.log('registerHttpEndpoints: Registering Beaver HTTP endpoints');
    
    // Check if Zotero.Server.Endpoints exists
    if (!Zotero?.Server?.Endpoints) {
        ztoolkit.log('registerHttpEndpoints: Zotero.Server.Endpoints not available - HTTP endpoints not registered');
        return;
    }
    
    // Register each endpoint
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
    
    ztoolkit.log(`registerHttpEndpoints: Registered ${ENDPOINT_PATHS.length} Beaver HTTP endpoints`);
}

/**
 * Unregisters all Beaver HTTP endpoints from Zotero's local server.
 * 
 * Call this during plugin shutdown (onShutdown).
 */
export function unregisterHttpEndpoints(): void {
    ztoolkit.log('unregisterHttpEndpoints: Unregistering Beaver HTTP endpoints');
    
    if (!Zotero?.Server?.Endpoints) {
        return;
    }
    
    for (const path of ENDPOINT_PATHS) {
        if (Zotero.Server.Endpoints[path]) {
            delete Zotero.Server.Endpoints[path];
        }
    }
    
    ztoolkit.log('unregisterHttpEndpoints: Beaver HTTP endpoints unregistered');
}
