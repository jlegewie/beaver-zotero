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
// Statically import the bbox-overlay helpers
import {
    getColumnOverlay,
    getLineOverlay,
    getParagraphOverlay,
    buildSentenceOverlayFromResult,
    getRawLinesOverlay,
    getMarginsOverlay,
} from '../utils/extractionOverlay';
import { drawBBoxOverlayPNG } from '../utils/canvasOverlay';
import type {
    PageSentenceBBoxResult,
    SentencePipelineTrace,
} from '../../src/services/pdf';
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
    // Test-only endpoints (MuPDF worker singleton stats / lifecycle)
    '/beaver/test/worker-stats',
    '/beaver/test/worker-mark-stale',
    '/beaver/test/worker-cache-clear',
    // Test-only endpoint (file-status side-effect trigger)
    '/beaver/test/file-status',
    // Test-only endpoints (MuPDF worker plumbing)
    '/beaver/test/pdf-page-count',
    '/beaver/test/pdf-page-labels',
    '/beaver/test/pdf-render-pages',
    '/beaver/test/pdf-render-pages-with-meta',
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
    // Bbox-overlay debugging (sentences/lines/paragraphs/columns/raw-lines/margins)
    '/beaver/test/pdf-render-overlay',
    // Per-page pipeline trace (every stage, JSON-only)
    '/beaver/test/pdf-pipeline-trace',
    // Cross-page smart-removal candidate summary (no rendering)
    '/beaver/test/pdf-smart-removal-summary',
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
        prefer_page_labels: request.prefer_page_labels,
        max_pages: request.max_pages,
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
        prefer_page_labels: request.prefer_page_labels,
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

/**
 * Dev-only: snapshot of MuPDFWorkerClient dispatch / spawn counters and
 * the worker-side document cache.
 *
 * Lets manual-test runners (`docs-zotero/manual-tests-fused-worker-ops.md`)
 * verify "exactly one extractWithMeta dispatch", "no extra spawns", etc.
 * without log grepping. POST `{ reset: true }` to zero counters first.
 *
 * `cacheStats` is `null` when no worker has spawned yet — the call must
 * never spawn one or pollute `dispatchCounts`, so the doc-cache fields stay
 * absent until a real op has run.
 */
async function handleTestWorkerStatsHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const client = getMuPDFWorkerClient();
    if (request?.reset === true) {
        client.resetStats();
    }
    const stats = client.getStats();
    const cacheStats = await client.getCacheStats();
    return { ok: true, stats, cacheStats };
}

/**
 * Dev-only: terminate the current MuPDF worker as if it had died mid-flight.
 *
 * Drives the same `markStale` code path as a real worker death, so the next
 * `call()` either retries (if a request is in-flight) or respawns on the
 * next dispatch. Used by manual test 1.3.
 */
async function handleTestWorkerMarkStaleHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const reason = typeof request?.reason === 'string' ? request.reason : 'test';
    const client = getMuPDFWorkerClient();
    const before = client.getStats();
    client.markStaleForTest(reason);
    return { ok: true, before, after: client.getStats() };
}

/**
 * Dev-only: clear the worker-side document cache. By default also resets
 * the cache hit/miss/eviction counters so live tests can assert exact
 * values; pass `{ resetCounters: false }` to keep history.
 *
 * No-op when no worker has spawned yet (returns `cacheStats: null`).
 */
async function handleTestWorkerCacheClearHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const client = getMuPDFWorkerClient();
    const resetCounters = request?.resetCounters !== false;
    const cacheStats = await client.clearWorkerCacheForTest({ resetCounters });
    return { ok: true, cacheStats };
}

/**
 * Dev-only: invoke `getAttachmentFileStatus(item, isPrimary)` directly.
 *
 * Manual tests 2.3 (step 3), 5.4, and 7.2 need to trigger the file-status
 * side-effect that, in production, runs from agent or sidebar flows. This
 * endpoint short-circuits the trigger so a runner can assert on the cache
 * write / log output that follows.
 */
async function handleTestFileStatusHttpRequest(request: any) {
    const { getAttachmentFileStatus } = await import(
        '../../src/services/agentDataProvider/utils'
    );
    const { library_id, zotero_key, is_primary } = request || {};
    if (library_id == null || zotero_key == null) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        library_id,
        zotero_key,
    );
    if (!item) return { ok: false, error: 'not_found' };
    if (!item.isAttachment()) return { ok: false, error: 'not_an_attachment' };
    const status = await getAttachmentFileStatus(item, is_primary !== false);
    return { ok: true, status };
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
    const { getSentenceSplitterWithFallback, normalizeLanguageCode } =
        await import('../../src/services/pdf/SentencexSplitter');
    const { getItemLanguage } = await import('../../src/utils/zoteroUtils');

    const { library_id, zotero_key, page_index, mode, splitter: splitterChoice, language: langOverride } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const pageIndex = typeof page_index === 'number' ? page_index : 0;
    const runMode: 'page' | 'paragraph' | 'both' =
        mode === 'page' || mode === 'paragraph' ? mode : 'both';
    // Splitter selection: "sentencex" (default) | "simple"
    const useSimple = splitterChoice === 'simple';

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

        // Resolve splitter:
        //   - "simple" → undefined → mappers default to simpleRegexSentenceSplit
        //   - "sentencex" (default) → load WASM-backed splitter, falls back
        //     internally to the regex if init fails.
        let splitter: ((text: string) => Array<{ start: number; end: number }>) | undefined;
        let splitterUsed = 'simple';
        let splitterInitMs = 0;
        if (!useSimple) {
            let language = typeof langOverride === 'string' ? langOverride : undefined;
            if (!language) {
                try {
                    const raw = await getItemLanguage(library_id, zotero_key);
                    if (raw) language = raw;
                } catch {
                    // Best effort.
                }
            }
            const t = Date.now();
            splitter = await getSentenceSplitterWithFallback(
                normalizeLanguageCode(language),
            );
            splitterInitMs = Date.now() - t;
            splitterUsed = 'sentencex';
        }

        let pageReport: unknown = null;
        let pageMs = 0;
        if (runMode === 'page' || runMode === 'both') {
            const t = Date.now();
            pageReport = buildFeasibilityReport(detailed, splitter);
            pageMs = Date.now() - t;
        }

        let paragraphReport: unknown = null;
        let paragraphMs = 0;
        if (runMode === 'paragraph' || runMode === 'both') {
            const t = Date.now();
            paragraphReport = buildParagraphFeasibilityReport(detailed, { splitter });
            paragraphMs = Date.now() - t;
        }

        return {
            ok: true,
            page_count: pageCount,
            page_width: detailed.width,
            page_height: detailed.height,
            num_blocks: detailed.blocks.length,
            splitter: splitterUsed,
            timings_ms: {
                walk: walkMs,
                splitter_init: splitterInitMs,
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
 * Dev-only PDF page labels endpoint. Routes through `PDFExtractor`, which
 * delegates to the MuPDF worker.
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
 * Dev-only fused render-pages endpoint exercising
 * `PDFExtractor.renderPagesToImagesWithMeta`. Returns metadata alongside
 * rendered pages so live tests can verify the fused-op shape end-to-end.
 */
async function handleTestPdfRenderPagesWithMetaHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;
    const pageRange = request?.page_range && typeof request.page_range === 'object'
        ? request.page_range
        : undefined;
    const options = request?.options || {};

    try {
        const result = await new PDFExtractor().renderPagesToImagesWithMeta(pdfData, {
            pageIndices,
            pageRange,
            options,
        });
        const pages = result.pages.map((r) => ({
            pageIndex: r.pageIndex,
            format: r.format,
            width: r.width,
            height: r.height,
            scale: r.scale,
            dpi: r.dpi,
            data_base64: uint8ToBase64ForTest(r.data),
            data_byte_length: r.data.byteLength,
        }));
        return {
            ok: true,
            pageCount: result.pageCount,
            pageLabels: result.pageLabels,
            pages,
        };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                    pageCount: e.pageCount,
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
 * Calls `getMuPDFWorkerClient().extractRawPageDetailed` directly (the worker
 * validates `pageIndex` and emits PAGE_OUT_OF_RANGE). Bypasses
 * `PDFExtractor.extractSentenceBBoxes` so the test exercises the raw
 * detailed page, not the sentence mapper.
 */
async function handleTestPdfExtractRawDetailedHttpRequest(request: any) {
    const { ExtractionError } = await import('../../src/services/pdf');
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );

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
        const result = await getMuPDFWorkerClient().extractRawPageDetailed(
            pdfData,
            pageIndex,
            { includeImages },
        );
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
 * Dev-only PDF search endpoint — primitive level (no SearchScorer).
 *
 * Calls `getMuPDFWorkerClient().searchPages` directly. Bypasses
 * `PDFExtractor.search` so the test exercises the raw `searchPages`
 * primitive, not the scored search pipeline.
 */
async function handleTestPdfSearchHttpRequest(request: any) {
    const { ExtractionError } = await import('../../src/services/pdf');
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );

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
        const pages = await getMuPDFWorkerClient().searchPages(
            pdfData,
            query,
            pageIndices,
            maxHitsPerPage,
        );
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
 * Dev-only render-with-overlay endpoint.
 *
 * Renders one page via MuPDF and paints column/line/paragraph/sentence
 * bboxes on top, returning a base64 PNG. Lets headless agents iterate on
 * extraction code: edit → wait for plugin reload → POST → inspect image.
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_index: number,
 *     level: "columns" | "lines" | "paragraphs" | "sentences"
 *          | "raw-lines" | "margins",
 *     dpi?: number,                       // default 144
 *     language?: string,                  // sentences only; falls back to item lang
 *     analysis_page_window?: number }     // applies to all levels except
 *                                         // raw-lines: ±N pages around
 *                                         // page_index for cross-page repeat /
 *                                         // page-number detection and
 *                                         // document-wide style profiling.
 *                                         // 0 (default) = whole document,
 *                                         // capped at 50.
 *
 * Level dispatch notes:
 *   - `sentences` runs through `runSentenceExtractionPipeline`
 *     so the rects drawn on the PNG are byte-for-byte the bboxes the
 *     production sentence pipeline produced.
 *   - `columns`, `lines`, `paragraphs`, `margins` route through
 *     `detectFilteredParagraphs` (inside the per-level overlay collectors)
 *     so they reflect the same smart cross-page filter the production
 *     sentence pipeline uses.
 *   - `raw-lines` deliberately stays on a single-page unfiltered extract —
 *     its purpose is to expose the pre-filter MuPDF lines so an agent can
 *     see what the margin filter did or didn't catch.
 *
 * Response: `{ ok: true, image_base64, width, height, page_width,
 *   page_height, group_count, stats, rects }`. `rects` carries the
 *   underlying bbox data so callers can also debug numerically.
 */
async function handleTestPdfRenderOverlayHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const {
        getSentenceSplitterWithFallback,
        normalizeLanguageCode,
        resolveAnalysisPageIndices,
        runSentenceExtractionPipeline,
        ExtractionError,
    } = await import('../../src/services/pdf');

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex = Number(request?.page_index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (non-negative integer) is required' },
        };
    }
    const level = String(request?.level ?? '');
    if (
        level !== 'columns' &&
        level !== 'lines' &&
        level !== 'paragraphs' &&
        level !== 'sentences' &&
        level !== 'raw-lines' &&
        level !== 'margins'
    ) {
        return {
            ok: false,
            error: {
                name: 'Error',
                message:
                    'level must be one of: columns | lines | paragraphs | sentences | raw-lines | margins',
            },
        };
    }
    const dpi = typeof request?.dpi === 'number' && request.dpi > 0 ? request.dpi : 144;

    const client = getMuPDFWorkerClient();

    // Helper: resolve language for sentence splitter. Best-effort —
    // explicit `request.language` wins, then item language lookup,
    // finally English fallback inside `normalizeLanguageCode`.
    const resolveLanguage = async (): Promise<string | undefined> => {
        let language: string | undefined =
            typeof request?.language === 'string' ? request.language : undefined;
        if (!language && request?.library_id != null && request?.zotero_key != null) {
            try {
                const { getItemLanguage } = await import('../../src/utils/zoteroUtils');
                const raw = await getItemLanguage(request.library_id, request.zotero_key);
                if (raw) language = raw;
            } catch {
                // Best effort.
            }
        }
        return language;
    };

    let overlay;
    if (level === 'sentences') {
        // Route through the production orchestration so the rects we draw
        // on the PNG are exactly the bboxes the production sentence
        // pipeline produced. `trace: true` adds zero worker round-trips
        // (just keeps intermediates in memory) and lets us read the
        // analysis-window size for `stats.analysisPagesScanned`.
        const language = await resolveLanguage();
        const splitter = await getSentenceSplitterWithFallback(
            normalizeLanguageCode(language),
        );
        const analysisPageWindow =
            request?.analysis_page_window != null
                ? Number(request.analysis_page_window)
                : undefined;
        try {
            const out = await runSentenceExtractionPipeline({
                pdfData,
                pageIndex,
                splitter,
                analysisPageWindow,
                trace: true,
            });
            overlay = buildSentenceOverlayFromResult(
                out.result,
                out.trace.analysisPageIndices.length,
            );
        } catch (e) {
            if (e instanceof RangeError) {
                return {
                    ok: false,
                    error: { name: 'Error', message: e.message },
                };
            }
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
    } else if (level === 'raw-lines') {
        // Pre-filter view — single page, no smart removal.
        const rawDoc = await client.extractRawPages(pdfData, [pageIndex]);
        const rawPage = rawDoc.pages[0];
        if (!rawPage) {
            return {
                ok: false,
                error: { name: 'Error', message: `page_index ${pageIndex} out of range` },
            };
        }
        overlay = getRawLinesOverlay(rawPage);
    } else {
        // columns / lines / paragraphs / margins: all need the analysis
        // window so smart cross-page filtering and document-wide style
        // profiling reflect what production sentence extraction sees.
        const totalPages = await client.getPageCount(pdfData);
        let analysisIndices: number[];
        try {
            analysisIndices = resolveAnalysisPageIndices(
                pageIndex,
                totalPages,
                Number(request?.analysis_page_window),
            );
        } catch (e) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: e instanceof Error ? e.message : String(e),
                },
            };
        }
        const rawDoc = await client.extractRawPages(pdfData, analysisIndices);
        if (!rawDoc.pages.find((p) => p.pageIndex === pageIndex)) {
            return {
                ok: false,
                error: { name: 'Error', message: `page_index ${pageIndex} out of range` },
            };
        }
        // For columns / lines / paragraphs, also fetch the detailed
        // target page and substitute it into the analysis window before
        // paragraph detection.
        if (level === 'margins') {
            overlay = getMarginsOverlay(rawDoc.pages, pageIndex);
        } else {
            const detailedTarget = await client.extractRawPageDetailed(
                pdfData,
                pageIndex,
            );
            if (level === 'columns') {
                overlay = getColumnOverlay(rawDoc.pages, pageIndex, detailedTarget);
            } else if (level === 'lines') {
                overlay = getLineOverlay(rawDoc.pages, pageIndex, detailedTarget);
            } else {
                overlay = getParagraphOverlay(rawDoc.pages, pageIndex, detailedTarget);
            }
        }
    }

    const rendered = await client.renderPageToImage(pdfData, pageIndex, {
        dpi,
        format: 'png',
    });

    const overlayed = await drawBBoxOverlayPNG(
        rendered.data,
        rendered.width,
        rendered.height,
        overlay.pageWidth,
        overlay.pageHeight,
        overlay.rects,
    );

    return {
        ok: true,
        level: overlay.level,
        page_index: overlay.pageIndex,
        page_width: overlay.pageWidth,
        page_height: overlay.pageHeight,
        image_width: rendered.width,
        image_height: rendered.height,
        dpi: rendered.dpi,
        group_count: overlay.groupCount,
        stats: overlay.stats,
        // Echo the bbox data so a caller debugging numerically doesn't
        // need a second request.
        rects: overlay.rects,
        image_base64: uint8ToBase64ForTest(overlayed),
        image_byte_length: overlayed.byteLength,
    };
}

/**
 * Dev-only pipeline-trace endpoint
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_index: number,
 *     language?: string,                 // for sentence splitter
 *     analysis_page_window?: number,     // ±N pages for smart removal;
 *                                        // 0 (default) = whole doc, capped 50
 *     include_chars?: boolean,           // include per-char quads on raw_lines
 *     summary?: boolean }                 // omit text bodies / chars / topStyles,
 *                                         // keep only triage facts (counts,
 *                                         // candidates, finalKept=false lines,
 *                                         // lines_dropped_by_columns,
 *                                         // degradationNotes). Typical 10–50×
 *                                         // smaller payload.
 *
 * Response shape (selected fields):
 *   { ok: true, page_index, page_width, page_height,
 *     raw_lines: [{ id, text, bbox, font, marginPosition, marginFilter,
 *                   role, finalParagraphId, chars? }],
 *     smart_removal: { analysisRange, candidates },
 *     style_profile: { primaryBodyStyle, bodyStyles, topStyles },
 *     columns: [{ idx, rect, lineIds }],
 *     lines_dropped_by_columns: [...],
 *     paragraphs: [{ id, type, columnIdx, lineIds, text, bbox, role }],
 *     sentences: [{ idx, text, paragraphId, bboxes, degraded }],
 *     sentence_stats }
 */
async function handleTestPdfPipelineTraceHttpRequest(request: any) {
    const {
        MarginFilter,
        StyleAnalyzer,
        DEFAULT_MARGINS,
        DEFAULT_MARGIN_ZONE,
        runSentenceExtractionPipeline,
        ExtractionError,
    } = await import('../../src/services/pdf');
    const { getSentenceSplitterWithFallback, normalizeLanguageCode } = await import(
        '../../src/services/pdf/SentencexSplitter'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex = Number(request?.page_index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (non-negative integer) is required' },
        };
    }
    const includeChars = request?.include_chars === true;
    const summary = request?.summary === true;

    // ------------------------------------------------------------------
    // Resolve the splitter the same way production does, then run the
    // shared sentence-extraction pipeline with `trace: true` for access to
    // intermediate object.
    // ------------------------------------------------------------------
    let language: string | undefined =
        typeof request?.language === 'string' ? request.language : undefined;
    if (!language && request?.library_id != null && request?.zotero_key != null) {
        try {
            const { getItemLanguage } = await import('../../src/utils/zoteroUtils');
            const raw = await getItemLanguage(request.library_id, request.zotero_key);
            if (raw) language = raw;
        } catch {
            // Best effort.
        }
    }
    const splitter = await getSentenceSplitterWithFallback(
        normalizeLanguageCode(language),
    );

    const analysisPageWindow =
        request?.analysis_page_window != null
            ? Number(request.analysis_page_window)
            : undefined;

    let result: PageSentenceBBoxResult;
    let trace: SentencePipelineTrace;
    try {
        const out = await runSentenceExtractionPipeline({
            pdfData,
            pageIndex,
            splitter,
            analysisPageWindow,
            trace: true,
        });
        result = out.result;
        trace = out.trace;
    } catch (e) {
        if (e instanceof RangeError) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: e.message,
                },
            };
        }
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

    // Read the target page from `pagesForFilter` (the substituted detailed
    // page) — bbox object identity in `trace.filteredResult.lineResult` /
    // `paragraphResult` is matched against this page, not against
    // `rawDoc.pages`. Reading from the wrong source breaks every
    // cross-stage link below.
    const targetPage = trace.pagesForFilter.find(
        (p) => p.pageIndex === pageIndex,
    );
    if (!targetPage) {
        return {
            ok: false,
            error: { name: 'Error', message: `page_index ${pageIndex} out of range` },
        };
    }

    // ------------------------------------------------------------------
    // Stage 1: smart-removal analysis (cross-page) — read from trace.
    // ------------------------------------------------------------------
    const smartRemoval = trace.marginRemoval;
    const reasonByText = new Map<string, 'page_number' | 'repeat'>();
    for (const c of smartRemoval.candidates) {
        reasonByText.set(c.text, c.reason);
    }
    const targetPageRemovals =
        smartRemoval.removalsByPage.get(pageIndex) ?? new Set<string>();

    // ------------------------------------------------------------------
    // Stage 2: enumerate raw lines on the target page with stable IDs and
    // margin-filter classification. This is the spine that everything
    // else hangs off — paragraphs reference these IDs.
    // ------------------------------------------------------------------
    type RawLineEntry = {
        id: string;
        text: string;
        bbox: { x: number; y: number; w: number; h: number };
        font: { name: string; family: string; size: number; weight: string; style: string };
        marginPosition: 'top' | 'bottom' | 'left' | 'right' | null;
        marginFilter: {
            keptBySimple: boolean;
            inSmartZone: boolean;
            smartRemoval: 'page_number' | 'repeat' | null;
            finalKept: boolean;
        };
        role: 'heading' | 'body' | 'caption' | 'footnote';
        finalParagraphId: string | null;
        chars?: Array<{ c: string; bbox: { x: number; y: number; w: number; h: number } }>;
    };

    const rawLineEntries: RawLineEntry[] = [];
    // Map raw RawBBox object → entry index, for cross-stage linking via
    // bbox object identity. The line detector preserves the same RawBBox
    // reference (see ColumnDetector.extractFilteredBlocks → DetectedSpan
    // construction), so this is safe within a single pipeline run.
    const bboxToEntryIdx = new Map<object, number>();

    let rawIdx = 0;
    for (const block of targetPage.blocks) {
        if (block.type !== 'text' || !block.lines) continue;
        for (const line of block.lines) {
            const id = `RL${rawIdx++}`;
            const trimmed = (line.text || '').trim();
            const normalized = trimmed.toLowerCase();
            const marginPosition = MarginFilter.getMarginPosition(
                line.bbox,
                targetPage.width,
                targetPage.height,
                DEFAULT_MARGINS,
            );
            const inSmartZone =
                MarginFilter.getMarginPosition(
                    line.bbox,
                    targetPage.width,
                    targetPage.height,
                    DEFAULT_MARGIN_ZONE,
                ) !== null;
            const keptBySimple = MarginFilter.isInsideContentArea(
                line,
                targetPage.width,
                targetPage.height,
                DEFAULT_MARGINS,
            );
            const smartReason = inSmartZone
                ? targetPageRemovals.has(normalized)
                    ? reasonByText.get(normalized) ?? 'repeat'
                    : null
                : null;
            const finalKept = keptBySimple && smartReason === null;

            const entry: RawLineEntry = {
                id,
                text: line.text,
                bbox: { x: line.bbox.x, y: line.bbox.y, w: line.bbox.w, h: line.bbox.h },
                font: {
                    name: line.font.name,
                    family: line.font.family,
                    size: line.font.size,
                    weight: line.font.weight,
                    style: line.font.style,
                },
                marginPosition,
                marginFilter: {
                    keptBySimple,
                    inSmartZone,
                    smartRemoval: smartReason,
                    finalKept,
                },
                role: 'body', // filled in once style profile exists
                finalParagraphId: null,
            };
            bboxToEntryIdx.set(line.bbox, rawLineEntries.length);
            rawLineEntries.push(entry);
        }
    }

    // ------------------------------------------------------------------
    // Stages 3-6: style profile + filter + columns + lines + paragraphs
    // — read from `trace.filteredResult`, which the helper computed by
    // running the production filtered-paragraph pipeline on
    // `pagesForFilter` (detailed target page substituted in).
    // ------------------------------------------------------------------
    const styleProfile = trace.filteredResult.styleProfile;
    const columnResult = trace.filteredResult.columnResult;
    const lineResult = trace.filteredResult.lineResult;
    const paragraphResult = trace.filteredResult.paragraphResult;

    // Per-line role classification using the (window-wide) style profile.
    {
        let i = 0;
        for (const block of targetPage.blocks) {
            if (block.type !== 'text' || !block.lines) continue;
            for (const line of block.lines) {
                rawLineEntries[i].role = StyleAnalyzer.classifyRole(line, styleProfile);
                i++;
            }
        }
    }

    // Map columnIndex → array of raw line IDs that contributed.
    const columnLineIds: string[][] = columnResult.columns.map(() => []);
    const linesUsed = new Set<number>();
    for (const colResult of lineResult.columnResults) {
        const colIdx = colResult.columnIndex;
        for (const pageLine of colResult.lines) {
            for (const span of pageLine.spans) {
                const idx = bboxToEntryIdx.get(span.bbox);
                if (idx !== undefined) {
                    if (!columnLineIds[colIdx].includes(rawLineEntries[idx].id)) {
                        columnLineIds[colIdx].push(rawLineEntries[idx].id);
                    }
                    linesUsed.add(idx);
                }
            }
        }
    }
    // Lines that survived margin filtering (simple + smart) but weren't
    // claimed by any column — useful when an agent wonders "why didn't
    // this body line make it into a paragraph?"
    const linesDroppedByColumns: string[] = [];
    rawLineEntries.forEach((e, i) => {
        if (e.marginFilter.finalKept && !linesUsed.has(i)) {
            linesDroppedByColumns.push(e.id);
        }
    });

    const paragraphsOut = paragraphResult.items.map((item, i) => {
        const lineIds: string[] = [];
        const constituentLines = paragraphResult.itemLines?.[i] ?? [];
        for (const pageLine of constituentLines) {
            for (const span of pageLine.spans) {
                const idx = bboxToEntryIdx.get(span.bbox);
                if (idx !== undefined) {
                    if (!lineIds.includes(rawLineEntries[idx].id)) {
                        lineIds.push(rawLineEntries[idx].id);
                    }
                    rawLineEntries[idx].finalParagraphId = item.id;
                }
            }
        }
        return {
            id: item.id,
            type: item.type,
            columnIdx: item.columnIndex,
            lineIds,
            text: item.text,
            bbox: {
                l: item.bbox.l,
                t: item.bbox.t,
                r: item.bbox.r,
                b: item.bbox.b,
                width: item.bbox.width,
                height: item.bbox.height,
            },
        };
    });

    // ------------------------------------------------------------------
    // Stage 7: sentences (paragraph-scoped). Already produced by the
    // helper — `trace.sentenceResult` is the same reference as `result`.
    // ------------------------------------------------------------------
    const sentenceResult = result;
    const detailed = trace.detailed;

    // Mark which paragraphs degraded so we can flag fallback sentences.
    const degradedItemIndices = new Set(
        sentenceResult.degradationNotes.map((n) => n.itemIndex),
    );
    const sentencesOut: Array<{
        idx: number;
        text: string;
        paragraphId: string | null;
        bboxes: Array<{ x: number; y: number; w: number; h: number }>;
        degraded: boolean;
    }> = [];
    let flatSentenceIdx = 0;
    sentenceResult.paragraphs.forEach((pws, paragraphArrayIdx) => {
        const isDegradedItem = degradedItemIndices.has(paragraphArrayIdx);
        for (const sentence of pws.sentences) {
            const isFallback =
                isDegradedItem &&
                pws.sentences.length === 1 &&
                pws.sentences[0].text === pws.item.text;
            sentencesOut.push({
                idx: flatSentenceIdx++,
                text: sentence.text,
                paragraphId: pws.item.id ?? null,
                bboxes: sentence.bboxes.map((b) => ({
                    x: b.x,
                    y: b.y,
                    w: b.w,
                    h: b.h,
                })),
                degraded: isFallback,
            });
        }
    });

    // ------------------------------------------------------------------
    // Optionally include per-character quads on raw_lines.
    // Bridge by 3-decimal-rounded bbox key
    // ------------------------------------------------------------------
    if (includeChars) {
        const detailedByBboxKey = new Map<string, typeof detailed.blocks[0]['lines'] extends (infer L)[] | undefined ? L : never>();
        const keyOf = (b: { x: number; y: number; w: number; h: number }) =>
            `${b.x.toFixed(3)}|${b.y.toFixed(3)}|${b.w.toFixed(3)}|${b.h.toFixed(3)}`;
        for (const block of detailed.blocks) {
            if (block.type !== 'text' || !block.lines) continue;
            for (const line of block.lines) {
                detailedByBboxKey.set(keyOf(line.bbox), line);
            }
        }
        for (const entry of rawLineEntries) {
            const detailedLine = detailedByBboxKey.get(keyOf(entry.bbox));
            if (detailedLine && detailedLine.chars) {
                entry.chars = detailedLine.chars.map((ch) => ({
                    c: ch.c,
                    bbox: { x: ch.bbox.x, y: ch.bbox.y, w: ch.bbox.w, h: ch.bbox.h },
                }));
            }
        }
    }

    // ------------------------------------------------------------------
    // Build the response.
    // ------------------------------------------------------------------
    const candidatesOut = smartRemoval.candidates.map((c) => ({
        text: c.text,
        originalText: c.originalText,
        reason: c.reason,
        position: c.position,
        pageIndices: c.pageIndices,
    }));

    if (summary) {
        // Triage view
        const finalDropped = rawLineEntries
            .filter((e) => !e.marginFilter.finalKept)
            .map((e) => ({
                id: e.id,
                bbox: e.bbox,
                marginPosition: e.marginPosition,
                marginFilter: e.marginFilter,
                role: e.role,
                textPreview: e.text.slice(0, 80),
            }));
        return {
            ok: true,
            mode: 'summary',
            page_index: pageIndex,
            page_width: targetPage.width,
            page_height: targetPage.height,
            page_label: targetPage.label,
            counts: {
                rawLines: rawLineEntries.length,
                rawLinesFinalKept: rawLineEntries.filter((e) => e.marginFilter.finalKept)
                    .length,
                rawLinesDroppedBySimple: rawLineEntries.filter(
                    (e) => !e.marginFilter.keptBySimple,
                ).length,
                rawLinesDroppedBySmart: rawLineEntries.filter(
                    (e) => e.marginFilter.smartRemoval !== null,
                ).length,
                columns: columnResult.columns.length,
                paragraphs: paragraphsOut.length,
                headers: paragraphsOut.filter((p) => p.type === 'header').length,
                sentences: sentencesOut.length,
            },
            smart_removal: {
                analysisRange: [
                    trace.analysisPageIndices[0],
                    trace.analysisPageIndices[trace.analysisPageIndices.length - 1],
                ],
                analysisPagesScanned: trace.analysisPageIndices.length,
                candidates: candidatesOut,
            },
            primaryBodyStyle: styleProfile.primaryBodyStyle,
            column_detection: {
                isBroken: columnResult.isBroken,
                columnCount: columnResult.columnCount,
            },
            raw_lines_final_dropped: finalDropped,
            lines_dropped_by_columns: linesDroppedByColumns,
            sentence_stats: {
                sentences: sentenceResult.sentences.length,
                paragraphs: sentenceResult.paragraphs.length,
                degradedParagraphs: sentenceResult.degradedParagraphs,
                unmappedParagraphs: sentenceResult.unmappedParagraphs,
                degradationNotes: sentenceResult.degradationNotes,
            },
        };
    }

    // Top styles for the snapshot — Maps don't survive JSON, so flatten.
    const topStyles = Array.from(styleProfile.styleCounts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((entry) => ({
            count: entry.count,
            style: entry.style,
            isBody: styleProfile.bodyStyles.some(
                (s) =>
                    s.size === entry.style.size &&
                    s.font === entry.style.font &&
                    s.bold === entry.style.bold &&
                    s.italic === entry.style.italic,
            ),
        }));

    return {
        ok: true,
        page_index: pageIndex,
        page_width: targetPage.width,
        page_height: targetPage.height,
        page_label: targetPage.label,
        raw_lines: rawLineEntries,
        smart_removal: {
            analysisRange: [
                trace.analysisPageIndices[0],
                trace.analysisPageIndices[trace.analysisPageIndices.length - 1],
            ],
            analysisPagesScanned: trace.analysisPageIndices.length,
            candidates: candidatesOut,
        },
        style_profile: {
            primaryBodyStyle: styleProfile.primaryBodyStyle,
            bodyStyles: styleProfile.bodyStyles,
            topStyles,
        },
        columns: columnResult.columns.map((rect, i) => ({
            idx: i,
            rect,
            lineIds: columnLineIds[i],
        })),
        column_detection: {
            isBroken: columnResult.isBroken,
            columnCount: columnResult.columnCount,
        },
        lines_dropped_by_columns: linesDroppedByColumns,
        paragraphs: paragraphsOut,
        sentences: sentencesOut,
        sentence_stats: {
            sentences: sentenceResult.sentences.length,
            paragraphs: sentenceResult.paragraphs.length,
            degradedParagraphs: sentenceResult.degradedParagraphs,
            unmappedParagraphs: sentenceResult.unmappedParagraphs,
            degradationNotes: sentenceResult.degradationNotes,
        },
    };
}

/**
 * Dev-only smart-removal summary endpoint. Cross-page repeating-text /
 * page-number analysis only — no column / line / paragraph detection,
 * no rendering. Useful for "is this watermark present on N pages?"
 * triage in a single call without paying for full extraction.
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_indices?: number[],            // explicit list to scan; if
 *                                         //   omitted, all pages (capped 50)
 *     page_range?: { start, end },        // alternative to page_indices
 *     repeat_threshold?: number,          // min pages for "repeat"
 *                                         //   classification (default 3)
 *     detect_page_sequences?: boolean }   // run page-number sequence
 *                                         //   detection (default true)
 *
 * Response:
 *   { ok: true,
 *     analysis_pages: number[],
 *     candidates: [{ text, originalText, reason, position, pageIndices }],
 *     removalsByPage: { [pageIndex]: string[] } }
 */
async function handleTestPdfSmartRemovalSummaryHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../src/services/pdf/MuPDFWorkerClient'
    );
    const { MarginFilter, DEFAULT_MARGIN_ZONE } = await import(
        '../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const repeatThreshold =
        Number.isInteger(request?.repeat_threshold) && request.repeat_threshold > 0
            ? request.repeat_threshold
            : 3;
    const detectPageSequences = request?.detect_page_sequences !== false;

    const client = getMuPDFWorkerClient();
    const totalPages = await client.getPageCount(pdfData);

    // Resolve which pages to scan.
    let analysisIndices: number[];
    if (Array.isArray(request?.page_indices)) {
        analysisIndices = (request.page_indices as unknown[])
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < totalPages);
    } else if (request?.page_range && typeof request.page_range === 'object') {
        const start = Math.max(0, Number(request.page_range.start) || 0);
        const end = Math.min(
            totalPages - 1,
            Number(
                request.page_range.end ?? request.page_range.endIndex ?? totalPages - 1,
            ),
        );
        analysisIndices = [];
        for (let i = start; i <= end; i++) analysisIndices.push(i);
    } else {
        analysisIndices = [];
        for (let i = 0; i < totalPages; i++) analysisIndices.push(i);
    }
    // Cap at 50 to bound latency. Center on the requested range start so
    // an explicit narrow request isn't reduced.
    if (analysisIndices.length > 50) {
        analysisIndices = analysisIndices.slice(0, 50);
    }
    if (analysisIndices.length === 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'No valid pages to analyze' },
        };
    }

    const rawDoc = await client.extractRawPages(pdfData, analysisIndices);
    const marginAnalysis = MarginFilter.collectMarginElements(
        rawDoc.pages,
        DEFAULT_MARGIN_ZONE,
    );
    const removal = MarginFilter.identifyElementsToRemove(
        marginAnalysis,
        repeatThreshold,
        detectPageSequences,
    );

    const removalsByPage: Record<string, string[]> = {};
    for (const [pageIdx, texts] of removal.removalsByPage) {
        removalsByPage[String(pageIdx)] = Array.from(texts);
    }

    return {
        ok: true,
        total_pages: totalPages,
        analysis_pages: analysisIndices,
        candidates: removal.candidates.map((c) => ({
            text: c.text,
            originalText: c.originalText,
            reason: c.reason,
            position: c.position,
            pageIndices: c.pageIndices,
        })),
        removalsByPage,
    };
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

    // Test-only endpoints (dev builds only)
    if (process.env.NODE_ENV === 'development') {
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

        // MuPDF worker singleton stats / lifecycle (dev-only)
        Zotero.Server.Endpoints['/beaver/test/worker-stats'] =
            createEndpoint(handleTestWorkerStatsHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/worker-mark-stale'] =
            createEndpoint(handleTestWorkerMarkStaleHttpRequest);

        Zotero.Server.Endpoints['/beaver/test/worker-cache-clear'] =
            createEndpoint(handleTestWorkerCacheClearHttpRequest);

        // File-status side-effect trigger (dev-only)
        Zotero.Server.Endpoints['/beaver/test/file-status'] =
            createEndpoint(handleTestFileStatusHttpRequest);

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

        Zotero.Server.Endpoints['/beaver/test/pdf-render-pages-with-meta'] =
            createEndpoint(handleTestPdfRenderPagesWithMetaHttpRequest);

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

        // Bbox overlay endpoint — paints columns/lines/paragraphs/sentences/
        // raw-lines/margins on a rendered page PNG for headless agent
        // debugging.
        Zotero.Server.Endpoints['/beaver/test/pdf-render-overlay'] =
            createEndpoint(handleTestPdfRenderOverlayHttpRequest);

        // Per-page pipeline trace — emits every stage of the extraction
        // pipeline as JSON with cross-stage IDs, so an agent can trace
        // one piece of text from raw line through paragraphs to sentences.
        Zotero.Server.Endpoints['/beaver/test/pdf-pipeline-trace'] =
            createEndpoint(handleTestPdfPipelineTraceHttpRequest);

        // Cross-page smart-removal summary — no extraction, no rendering;
        // just the candidates + per-page removal map.
        Zotero.Server.Endpoints['/beaver/test/pdf-smart-removal-summary'] =
            createEndpoint(handleTestPdfSmartRemovalSummaryHttpRequest);
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
