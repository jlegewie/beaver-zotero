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
import { getZoteroUserIdentifier } from '../../src/utils/zoteroUtils';
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
    handleListCollectionsRequest,
    handleListTagsRequest,
    // Deferred tools
    handleAgentActionValidateRequest,
    handleAgentActionExecuteRequest,
    // Utility
    handleDeleteItemsRequest,
    // Notes
    handleReadNoteRequest,
} from '../../src/services/agentDataProvider';
import { wrapWithSchemaVersion } from '../utils/noteActions';
import { undoEditNoteAction } from '../utils/editNoteActions';
import { getLatestNoteHtml } from '../../src/utils/noteEditorIO';
import type { AgentAction } from '../agents/agentActions';
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
    WSListCollectionsRequest,
    WSListTagsRequest,
    // Deferred tools
    WSAgentActionValidateRequest,
    WSAgentActionExecuteRequest,
    // Notes
    WSReadNoteRequest,
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
    '/beaver/library/collections',
    '/beaver/library/tags',
    // Deferred tools
    '/beaver/agent-action/validate',
    '/beaver/agent-action/execute',
    // Utility
    '/beaver/user-info',
    '/beaver/delete-items',
    // Notes
    '/beaver/note/read',
    // Test-only endpoints (cache inspection/manipulation)
    '/beaver/test/ping',
    '/beaver/test/cache-metadata',
    '/beaver/test/cache-invalidate',
    '/beaver/test/cache-clear-memory',
    '/beaver/test/cache-delete-content',
    '/beaver/test/resolve-item',
    // Test-only endpoints (note seeding/teardown/inspection)
    '/beaver/test/note-create',
    '/beaver/test/note-delete',
    '/beaver/test/note-read',
    '/beaver/test/note-open-editor',
    '/beaver/test/note-close-editor',
    '/beaver/test/note-undo',
    // Test-only endpoints (sentence bbox feasibility probe)
    '/beaver/test/sentence-bboxes',
    // Test-only endpoints (MuPDF worker plumbing)
    '/beaver/test/pdf-page-count',
    '/beaver/test/pdf-page-labels',
    '/beaver/test/pdf-render-pages',
    '/beaver/test/pdf-extract-raw',
    '/beaver/test/pdf-extract-raw-detailed',
    '/beaver/test/pdf-search',
    // orchestration parity endpoints
    '/beaver/test/pdf-extract',
    '/beaver/test/pdf-extract-by-lines',
    '/beaver/test/pdf-has-text-layer',
    '/beaver/test/pdf-analyze-ocr',
    '/beaver/test/pdf-search-scored',
    '/beaver/test/pdf-sentence-bboxes',
    '/beaver/test/pdf-render-page',
    '/beaver/test/set-pref',
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
        file_status_level: request.file_status_level,
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
        offset: request.offset,
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
        offset: request.offset,
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
        sort_by: request.sort_by ?? null,
        sort_order: request.sort_order ?? null,
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
        include_attachments: request.include_attachments ?? false,
        include_notes: request.include_notes ?? false,
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

async function handleListCollectionsHttpRequest(request: any) {
    const wsRequest: WSListCollectionsRequest = {
        event: 'list_collections_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        parent_collection_key: request.parent_collection_key,
        include_item_counts: request.include_item_counts ?? false,
        limit: request.limit ?? 50,
        offset: request.offset ?? 0,
    };

    const response = await handleListCollectionsRequest(wsRequest);

    return {
        collections: response.collections,
        total_count: response.total_count,
        library_id: response.library_id,
        library_name: response.library_name,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleListTagsHttpRequest(request: any) {
    const wsRequest: WSListTagsRequest = {
        event: 'list_tags_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        collection_key: request.collection_key,
        min_item_count: request.min_item_count ?? 0,
        limit: request.limit ?? 50,
        offset: request.offset ?? 0,
    };

    const response = await handleListTagsRequest(wsRequest);

    return {
        tags: response.tags,
        total_count: response.total_count,
        library_id: response.library_id,
        library_name: response.library_name,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleAgentActionValidateHttpRequest(request: any) {
    const wsRequest: WSAgentActionValidateRequest = {
        event: 'agent_action_validate',
        request_id: generateRequestId(),
        action_type: request.action_type,
        action_data: request.action_data,
    };

    const response = await handleAgentActionValidateRequest(wsRequest);

    return {
        valid: response.valid,
        error: response.error,
        error_code: response.error_code,
        error_candidates: response.error_candidates,
        current_value: response.current_value,
        normalized_action_data: response.normalized_action_data,
        preference: response.preference,
    };
}

async function handleAgentActionExecuteHttpRequest(request: any) {
    const wsRequest: WSAgentActionExecuteRequest = {
        event: 'agent_action_execute',
        request_id: generateRequestId(),
        action_type: request.action_type,
        action_data: request.action_data,
        timeout_seconds: request.timeout_seconds,
    };

    const response = await handleAgentActionExecuteRequest(wsRequest);

    return {
        success: response.success,
        error: response.error,
        error_code: response.error_code,
        error_candidates: response.error_candidates,
        result_data: response.result_data,
    };
}

async function handleUserInfoHttpRequest(_request: any) {
    return getZoteroUserIdentifier();
}

async function handleDeleteItemsHttpRequest(request: any) {
    return await handleDeleteItemsRequest({
        item_ids: request.item_ids || [],
    });
}

async function handleReadNoteHttpRequest(request: any) {
    const wsRequest: WSReadNoteRequest = {
        event: 'read_note_request',
        request_id: generateRequestId(),
        note_id: request.note_id,
        offset: request.offset,
        limit: request.limit,
    };

    return await handleReadNoteRequest(wsRequest);
}


// =============================================================================
// Test-Only HTTP Handlers (cache inspection / manipulation)
// =============================================================================

async function handleTestPingHttpRequest(_request: any) {
    const cache = Zotero.Beaver?.attachmentFileCache;
    const db = Zotero.Beaver?.db;
    return {
        ok: true,
        cache_available: !!cache,
        db_available: !!db,
    };
}

async function handleTestCacheMetadataHttpRequest(request: any) {
    const { library_id, zotero_key, item_id } = request;
    const db = Zotero.Beaver?.db;
    if (!db) return { error: 'db not available' };

    let record;
    if (item_id != null) {
        record = await db.getAttachmentFileCache(item_id);
    } else if (library_id != null && zotero_key != null) {
        record = await db.getAttachmentFileCacheByKey(library_id, zotero_key);
    } else {
        return { error: 'Provide item_id or library_id + zotero_key' };
    }
    return { record: record ?? null };
}

async function handleTestCacheInvalidateHttpRequest(request: any) {
    const { library_id, zotero_key, item_id } = request;
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return { error: 'cache not available' };

    if (item_id != null && library_id != null && zotero_key != null) {
        await cache.invalidate(item_id, library_id, zotero_key);
    } else if (library_id != null && zotero_key != null) {
        // Resolve item_id from DB
        const db = Zotero.Beaver?.db;
        if (!db) return { error: 'db not available' };
        const record = await db.getAttachmentFileCacheByKey(library_id, zotero_key);
        if (record) {
            await cache.invalidate(record.item_id, library_id, zotero_key);
        } else {
            // No cache entry, nothing to invalidate
        }
    } else {
        return { error: 'Provide library_id + zotero_key (and optionally item_id)' };
    }
    return { ok: true };
}

async function handleTestCacheClearMemoryHttpRequest(_request: any) {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return { error: 'cache not available' };
    cache.clearMemoryCache();
    return { ok: true };
}

async function handleTestCacheDeleteContentHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return { error: 'cache not available' };
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    await cache.deleteContent(library_id, zotero_key);
    return { ok: true };
}

async function handleTestNoteCreateHttpRequest(request: any) {
    const { library_id, html, title, parent_key, wrap_schema } = request as {
        library_id?: number;
        html: string;
        title?: string;
        parent_key?: string;
        wrap_schema?: boolean;
    };
    if (typeof html !== 'string') {
        return { error: 'html is required' };
    }
    const note = new Zotero.Item('note');
    if (typeof library_id === 'number') note.libraryID = library_id;
    if (parent_key) note.parentKey = parent_key;

    const body = title ? `<h1>${title}</h1>${html}` : html;
    const wrapped = wrap_schema === false ? body : wrapWithSchemaVersion(body);
    note.setNote(wrapped);
    await note.saveTx();

    return {
        library_id: note.libraryID,
        zotero_key: note.key,
        item_id: note.id,
    };
}

async function handleTestNoteDeleteHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: true, deleted: false };
    if (!item.isNote()) return { error: 'not_a_note' };
    await Zotero.Items.erase([item.id]);
    return { ok: true, deleted: true };
}

async function handleTestNoteReadHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };
    if (!item.isNote()) return { error: 'not_a_note' };
    await item.loadDataType('note');
    const savedHtml: string = item.getNote();
    let liveHtml: string | null = null;
    try {
        liveHtml = getLatestNoteHtml(item);
    } catch {
        liveHtml = null;
    }
    let inEditor = false;
    try {
        const instances = (Zotero as any).Notes._editorInstances;
        if (Array.isArray(instances)) {
            inEditor = instances.some((inst: any) => {
                if (!inst._item || inst._item.id !== item.id) return false;
                try {
                    const frameElement = inst._iframeWindow?.frameElement;
                    return frameElement?.isConnected === true;
                } catch {
                    return false;
                }
            });
        }
    } catch {
        inEditor = false;
    }
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        item_id: item.id,
        saved_html: savedHtml,
        live_html: liveHtml,
        in_editor: inEditor,
    };
}

async function handleTestNoteOpenEditorHttpRequest(request: any) {
    const { library_id, zotero_key, open_in_window } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };
    if (!item.isNote()) return { error: 'not_a_note' };

    const openInWindow = open_in_window !== false;
    await (Zotero as any).Notes.open(item.id, undefined, { openInWindow });

    // Wait briefly for the editor instance to attach
    let inEditor = false;
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
            const instances = (Zotero as any).Notes._editorInstances;
            if (Array.isArray(instances)) {
                inEditor = instances.some((inst: any) => {
                    if (!inst._item || inst._item.id !== item.id) return false;
                    const frame = inst._iframeWindow?.frameElement;
                    return frame?.isConnected === true;
                });
            }
        } catch {
            inEditor = false;
        }
        if (inEditor) break;
    }
    return { ok: true, in_editor: inEditor };
}

async function handleTestNoteCloseEditorHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };

    let closed = 0;
    try {
        const instances = (Zotero as any).Notes._editorInstances ?? [];
        for (const inst of [...instances]) {
            if (!inst._item || inst._item.id !== item.id) continue;
            const frame = inst._iframeWindow?.frameElement;
            const instanceWin = frame?.ownerDocument?.defaultView;
            try {
                if (inst.viewMode === 'window' && instanceWin && instanceWin.close) {
                    instanceWin.close();
                    closed++;
                    continue;
                }
                if (inst.tabID) {
                    const mainWin: any = Zotero.getMainWindow?.();
                    if (mainWin?.Zotero_Tabs?.close) {
                        mainWin.Zotero_Tabs.close(inst.tabID);
                        closed++;
                        continue;
                    }
                }
                if (typeof inst.uninit === 'function') {
                    await inst.uninit();
                    closed++;
                }
            } catch {
                // best-effort
            }
        }
    } catch {
        // best-effort
    }
    // Let Zotero settle
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, closed };
}

async function handleTestNoteUndoHttpRequest(request: any) {
    const { action } = request as { action: AgentAction };
    if (!action || !action.proposed_data) {
        return { error: 'action with proposed_data is required' };
    }
    try {
        await undoEditNoteAction(action);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}

async function handleTestResolveItemHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { item_id: null, item_type: null };
    return {
        item_id: item.id,
        item_type: item.itemType,
        is_attachment: item.isAttachment(),
        parent_id: item.parentID || null,
        attachment_content_type: item.isAttachment() ? item.attachmentContentType : null,
    };
}

/**
 * Sentence-level bbox feasibility probe.
 *
 * Runs both the page-wide (`SentenceMapper`) and the paragraph-scoped
 * (`ParagraphSentenceMapper`) prototypes against a Zotero attachment and
 * returns diagnostic reports for each. The two pipelines coexist — this
 * endpoint is the side-by-side harness used by the integration test.
 *
 * Dev-only. Request body:
 *   { library_id, zotero_key, page_index?, mode? }
 * where `mode` is "page" (SentenceMapper only), "paragraph"
 * (ParagraphSentenceMapper only), or "both" (default).
 */
async function handleTestSentenceBBoxesHttpRequest(request: any) {
    const { MuPDFService } = await import('../../src/services/pdf/MuPDFService');
    const { buildFeasibilityReport } = await import('../../src/services/pdf/SentenceMapper');
    const { buildParagraphFeasibilityReport } = await import(
        '../../src/services/pdf/ParagraphSentenceMapper'
    );

    const { library_id, zotero_key, page_index, mode } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const pageIndex = typeof page_index === 'number' ? page_index : 0;
    const runMode: 'page' | 'paragraph' | 'both' =
        mode === 'page' || mode === 'paragraph' ? mode : 'both';

    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item || !item.isAttachment() || !item.isPDFAttachment()) {
        return { error: 'Item is not a PDF attachment' };
    }
    const filePath = await item.getFilePathAsync();
    if (!filePath) return { error: 'PDF file not available locally' };

    const pdfData = await IOUtils.read(filePath);
    const mupdf = new MuPDFService();
    try {
        await mupdf.open(pdfData);
        const pageCount = mupdf.getPageCount();
        if (pageIndex < 0 || pageIndex >= pageCount) {
            return { error: `page_index out of range (0..${pageCount - 1})` };
        }

        // Time the shared walk pass once so we can report it.
        const walkStart = Date.now();
        const detailed = mupdf.extractRawPageDetailed(pageIndex);
        const walkMs = Date.now() - walkStart;

        let pageReport: unknown = null;
        let pageMs = 0;
        if (runMode === 'page' || runMode === 'both') {
            const t = Date.now();
            pageReport = buildFeasibilityReport(detailed);
            pageMs = Date.now() - t;
        }

        let paragraphReport: unknown = null;
        let paragraphMs = 0;
        if (runMode === 'paragraph' || runMode === 'both') {
            const t = Date.now();
            paragraphReport = buildParagraphFeasibilityReport(detailed);
            paragraphMs = Date.now() - t;
        }

        return {
            ok: true,
            page_count: pageCount,
            page_width: detailed.width,
            page_height: detailed.height,
            num_blocks: detailed.blocks.length,
            timings_ms: {
                walk: walkMs,
                page_mapper: pageMs,
                paragraph_mapper: paragraphMs,
            },
            report: pageReport,
            paragraph_report: paragraphReport,
        };
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    } finally {
        mupdf.close();
    }
}

/**
 * Dev-only PDF page-count endpoint.
 *
 * Bypasses `createEndpoint`'s thrown-error → HTTP 500 path so live tests can
 * see structured `{ ok: false, error: { code } }` responses for parity checks
 * (encrypted vs invalid PDFs).
 *
 * Request body:
 *   { library_id, zotero_key }     // read attachment bytes
 *   { raw_bytes_base64 }            // bypass attachment-type check
 */
async function handleTestPdfPageCountHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../src/services/pdf'
    );

    let pdfData: Uint8Array;
    if (typeof request?.raw_bytes_base64 === 'string') {
        try {
            const binary = atob(request.raw_bytes_base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            pdfData = bytes;
        } catch (e) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: `Invalid raw_bytes_base64: ${e instanceof Error ? e.message : String(e)}`,
                },
            };
        }
    } else {
        const { library_id, zotero_key } = request || {};
        if (library_id == null || zotero_key == null) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: 'Provide library_id + zotero_key, or raw_bytes_base64',
                },
            };
        }
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            library_id,
            zotero_key,
        );
        if (!item || !item.isAttachment() || !item.isPDFAttachment()) {
            return {
                ok: false,
                error: { name: 'Error', message: 'Item is not a PDF attachment' },
            };
        }
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            return {
                ok: false,
                error: { name: 'Error', message: 'PDF file not available locally' },
            };
        }
        pdfData = await IOUtils.read(filePath);
    }

    try {
        const count = await new PDFExtractor().getPageCount(pdfData);
        return { ok: true, count };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Resolve a request body to PDF bytes — accepts either an attachment ref
 * `{ library_id, zotero_key }` or raw `{ raw_bytes_base64 }`.
 *
 * Returns a discriminated result so callers can return a structured
 * `{ ok: false, error: { name, message } }` response without throwing.
 */
async function loadPdfBytesForTestEndpoint(
    request: any,
): Promise<
    | { ok: true; pdfData: Uint8Array }
    | { ok: false; error: { name: string; message: string } }
> {
    if (typeof request?.raw_bytes_base64 === 'string') {
        try {
            const binary = atob(request.raw_bytes_base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return { ok: true, pdfData: bytes };
        } catch (e) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: `Invalid raw_bytes_base64: ${e instanceof Error ? e.message : String(e)}`,
                },
            };
        }
    }
    const { library_id, zotero_key } = request || {};
    if (library_id == null || zotero_key == null) {
        return {
            ok: false,
            error: {
                name: 'Error',
                message: 'Provide library_id + zotero_key, or raw_bytes_base64',
            },
        };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        library_id,
        zotero_key,
    );
    if (!item || !item.isAttachment() || !item.isPDFAttachment()) {
        return {
            ok: false,
            error: { name: 'Error', message: 'Item is not a PDF attachment' },
        };
    }
    const filePath = await item.getFilePathAsync();
    if (!filePath) {
        return {
            ok: false,
            error: { name: 'Error', message: 'PDF file not available locally' },
        };
    }
    const pdfData = await IOUtils.read(filePath);
    return { ok: true, pdfData };
}

function uint8ToBase64ForTest(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

/**
 * Dev-only PDF page labels endpoint. Routes through `PDFExtractor`, so it
 * picks up the worker when `mupdf.useWorker` is on.
 */
async function handleTestPdfPageLabelsHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    try {
        const { count, labels } = await new PDFExtractor().getPageCountAndLabels(
            pdfData,
        );
        return { ok: true, count, labels };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF render endpoint. Routes through `PDFExtractor`. Image bytes
 * are base64-encoded for JSON transport; live tests decode for parity.
 */
async function handleTestPdfRenderPagesHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;
    const options = request?.options || {};

    try {
        const results = await new PDFExtractor().renderPagesToImages(
            pdfData,
            pageIndices,
            options,
        );
        const pages = results.map((r) => ({
            pageIndex: r.pageIndex,
            format: r.format,
            width: r.width,
            height: r.height,
            scale: r.scale,
            dpi: r.dpi,
            data_base64: uint8ToBase64ForTest(r.data),
            data_byte_length: r.data.byteLength,
        }));
        return { ok: true, pages };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF raw-extract endpoint. Routes through `PDFExtractor`.
 */
async function handleTestPdfExtractRawHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;

    try {
        const result = await new PDFExtractor().extractRaw(pdfData, pageIndices);
        return { ok: true, result };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF detailed-extract endpoint — primitive level.
 *
 * Pref on  → `getMuPDFWorkerClient().extractRawPageDetailed` (worker
 *            validates `pageIndex` and emits PAGE_OUT_OF_RANGE).
 * Pref off → bare `MuPDFService` open + explicit pageIndex bounds check
 *            (mirroring the precondition in
 *            `PDFExtractor.extractSentenceBBoxes`) + extractRawPageDetailed
 *            + close. We bypass `PDFExtractor.extractSentenceBBoxes` so the
 *            test exercises the raw detailed page, not the sentence mapper.
 */
async function handleTestPdfExtractRawDetailedHttpRequest(request: any) {
    const { ExtractionError, ExtractionErrorCode } = await import(
        '../../src/services/pdf'
    );
    const { MuPDFService } = await import(
        '../../src/services/pdf/MuPDFService'
    );
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const { getPref } = await import('../../src/utils/prefs');

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex: unknown = request?.page_index;
    if (typeof pageIndex !== 'number') {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (number) is required' },
        };
    }
    const includeImages = request?.include_images === true;

    try {
        if (getPref('mupdf.useWorker')) {
            const result = await getMuPDFWorkerClient().extractRawPageDetailed(
                pdfData,
                pageIndex,
                { includeImages },
            );
            return { ok: true, result };
        }

        const mupdf = new MuPDFService();
        try {
            await mupdf.open(pdfData);
            const pageCount = mupdf.getPageCount();
            if (pageIndex < 0 || pageIndex >= pageCount) {
                throw new ExtractionError(
                    ExtractionErrorCode.PAGE_OUT_OF_RANGE,
                    `Page index ${pageIndex} out of range (0..${pageCount - 1})`,
                );
            }
            const result = mupdf.extractRawPageDetailed(pageIndex, {
                includeImages,
            });
            return { ok: true, result };
        } finally {
            mupdf.close();
        }
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF search endpoint — primitive level (no SearchScorer).
 *
 * To exercise the worker primitive in isolation, this endpoint bypasses
 * `PDFExtractor`:
 *   pref on  → `getMuPDFWorkerClient().searchPages`
 *   pref off → bare `MuPDFService` open + searchPages + close
 */
async function handleTestPdfSearchHttpRequest(request: any) {
    const { ExtractionError } = await import('../../src/services/pdf');
    const { MuPDFService } = await import(
        '../../src/services/pdf/MuPDFService'
    );
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const { getPref } = await import('../../src/utils/prefs');

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const query: unknown = request?.query;
    if (typeof query !== 'string' || query.length === 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'query (non-empty string) is required' },
        };
    }
    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;
    const maxHitsPerPage =
        typeof request?.max_hits_per_page === 'number'
            ? request.max_hits_per_page
            : undefined;

    try {
        if (getPref('mupdf.useWorker')) {
            const pages = await getMuPDFWorkerClient().searchPages(
                pdfData,
                query,
                pageIndices,
                maxHitsPerPage,
            );
            return { ok: true, pages };
        }

        const mupdf = new MuPDFService();
        try {
            await mupdf.open(pdfData);
            const pages = mupdf.searchPages(
                query,
                pageIndices,
                maxHitsPerPage ?? 100,
            );
            return { ok: true, pages };
        } finally {
            mupdf.close();
        }
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Helper that wraps a PDFExtractor call and serializes ExtractionError
 * (including the `details` payload) into the structured wire shape used by
 * live parity tests.
 */
async function runPdfExtractorCall<T>(
    request: any,
    fn: (pdfData: Uint8Array) => Promise<T>,
    onSuccess: (result: T) => any,
): Promise<any> {
    const { ExtractionError } = await import('../../src/services/pdf');
    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    try {
        const result = await fn(loaded.pdfData);
        return onSuccess(result);
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                    // ExtractionError stores OCR data on `e.details`
                    // (types.ts:599); the wire field is named `ocrAnalysis`
                    // for self-documenting JSON. Live tests assert the
                    // wire shape; the rehydrated client-side instance
                    // carries the same data on `error.details`.
                    payload: {
                        ocrAnalysis: e.details,
                        pageLabels: e.pageLabels,
                        pageCount: e.pageCount,
                    },
                },
            };
        }
        throw e;
    }
}

/** Dev-only `extract` parity endpoint. Routes through PDFExtractor. */
async function handleTestPdfExtractHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    const settings = request?.settings || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().extract(pdfData, settings),
        (result) => ({ ok: true, result }),
    );
}

/** Dev-only `extractByLines` parity endpoint. */
async function handleTestPdfExtractByLinesHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    const settings = request?.settings || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().extractByLines(pdfData, settings),
        (result) => ({ ok: true, result }),
    );
}

/** Dev-only `hasTextLayer` parity endpoint. */
async function handleTestPdfHasTextLayerHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().hasTextLayer(pdfData),
        (hasTextLayer) => ({ ok: true, hasTextLayer }),
    );
}

/** Dev-only `analyzeOCRNeeds` parity endpoint. */
async function handleTestPdfAnalyzeOcrHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().analyzeOCRNeeds(pdfData, options),
        (result) => ({ ok: true, result }),
    );
}

/** Dev-only scored-search parity endpoint. */
async function handleTestPdfSearchScoredHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    const query = String(request?.query ?? '');
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().search(pdfData, query, options),
        (result) => ({ ok: true, result }),
    );
}

/** Dev-only `extractSentenceBBoxes` parity endpoint. */
async function handleTestPdfSentenceBBoxesHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    const pageIndex = Number(request?.page_index);
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) =>
            new PDFExtractor().extractSentenceBBoxes(pdfData, pageIndex, options),
        (result) => ({ ok: true, result }),
    );
}

/**
 * Dev-only single-page render endpoint — required for the carry-forward
 * `renderPageToImage` PAGE_OUT_OF_RANGE parity case (the plural endpoint
 * silently filters invalid indices and cannot exercise the throw).
 */
async function handleTestPdfRenderPageHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../src/services/pdf');
    const pageIndex = Number(request?.page_index);
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().renderPageToImage(pdfData, pageIndex, options),
        (r) => ({
            ok: true,
            result: {
                pageIndex: r.pageIndex,
                format: r.format,
                width: r.width,
                height: r.height,
                scale: r.scale,
                dpi: r.dpi,
                data_base64: uint8ToBase64ForTest(r.data),
                data_byte_length: r.data.byteLength,
            },
        }),
    );
}

/**
 * Dev-only pref setter. Allowlisted to a single key for safety.
 *
 * Request body:  { key: "mupdf.useWorker", value: boolean }
 */
async function handleTestSetPrefHttpRequest(request: any) {
    const { key, value } = request || {};
    if (key !== 'mupdf.useWorker') {
        return { ok: false, error: 'unsupported pref key' };
    }
    if (typeof value !== 'boolean') {
        return { ok: false, error: 'value must be boolean' };
    }
    Zotero.Prefs.set('extensions.zotero.beaver.mupdf.useWorker', value, true);
    return { ok: true };
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

    Zotero.Server.Endpoints['/beaver/library/collections'] =
        createEndpoint(handleListCollectionsHttpRequest);

    Zotero.Server.Endpoints['/beaver/library/tags'] =
        createEndpoint(handleListTagsHttpRequest);

    // Deferred tool endpoints
    Zotero.Server.Endpoints['/beaver/agent-action/validate'] =
        createEndpoint(handleAgentActionValidateHttpRequest);

    Zotero.Server.Endpoints['/beaver/agent-action/execute'] =
        createEndpoint(handleAgentActionExecuteHttpRequest);

    // Utility endpoints
    Zotero.Server.Endpoints['/beaver/user-info'] =
        createEndpoint(handleUserInfoHttpRequest);

    Zotero.Server.Endpoints['/beaver/delete-items'] =
        createEndpoint(handleDeleteItemsHttpRequest);

    // Note endpoints
    Zotero.Server.Endpoints['/beaver/note/read'] =
        createEndpoint(handleReadNoteHttpRequest);

    // Test-only endpoints (cache inspection/manipulation) — dev builds only
    if (Zotero.Beaver?.data?.env === 'development') {
        Zotero.Server.Endpoints['/beaver/test/ping'] =
            createEndpoint(handleTestPingHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/cache-metadata'] =
            createEndpoint(handleTestCacheMetadataHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/cache-invalidate'] =
            createEndpoint(handleTestCacheInvalidateHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/cache-clear-memory'] =
            createEndpoint(handleTestCacheClearMemoryHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/cache-delete-content'] =
            createEndpoint(handleTestCacheDeleteContentHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/resolve-item'] =
            createEndpoint(handleTestResolveItemHttpRequest);

        // Note-specific test endpoints (seeding/teardown/inspection/undo)
        Zotero.Server.Endpoints['/beaver/test/note-create'] =
            createEndpoint(handleTestNoteCreateHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/note-delete'] =
            createEndpoint(handleTestNoteDeleteHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/note-read'] =
            createEndpoint(handleTestNoteReadHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/note-open-editor'] =
            createEndpoint(handleTestNoteOpenEditorHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/note-close-editor'] =
            createEndpoint(handleTestNoteCloseEditorHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/note-undo'] =
            createEndpoint(handleTestNoteUndoHttpRequest);

        // Sentence bbox feasibility probe (dev-only)
        Zotero.Server.Endpoints['/beaver/test/sentence-bboxes'] =
            createEndpoint(handleTestSentenceBBoxesHttpRequest);

        // MuPDF worker plumbing (dev-only)
        Zotero.Server.Endpoints['/beaver/test/pdf-page-count'] =
            createEndpoint(handleTestPdfPageCountHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-page-labels'] =
            createEndpoint(handleTestPdfPageLabelsHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-render-pages'] =
            createEndpoint(handleTestPdfRenderPagesHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-extract-raw'] =
            createEndpoint(handleTestPdfExtractRawHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-extract-raw-detailed'] =
            createEndpoint(handleTestPdfExtractRawDetailedHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-search'] =
            createEndpoint(handleTestPdfSearchHttpRequest);

        // orchestration parity endpoints
        Zotero.Server.Endpoints['/beaver/test/pdf-extract'] =
            createEndpoint(handleTestPdfExtractHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-extract-by-lines'] =
            createEndpoint(handleTestPdfExtractByLinesHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-has-text-layer'] =
            createEndpoint(handleTestPdfHasTextLayerHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-analyze-ocr'] =
            createEndpoint(handleTestPdfAnalyzeOcrHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-search-scored'] =
            createEndpoint(handleTestPdfSearchScoredHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-sentence-bboxes'] =
            createEndpoint(handleTestPdfSentenceBBoxesHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/pdf-render-page'] =
            createEndpoint(handleTestPdfRenderPageHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/set-pref'] =
            createEndpoint(handleTestSetPrefHttpRequest);
    }

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
