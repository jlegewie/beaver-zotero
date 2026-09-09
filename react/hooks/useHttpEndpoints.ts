import { tryGetWindowRuntime } from '../runtime/windowRuntime';
/**
 * Hook to register HTTP endpoints for local FrontendCapability.
 *
 * This hook registers HTTP endpoints on Zotero's local server (port 23119)
 * that expose the agent data provider handlers. The endpoints are only
 * registered when the user is authenticated and the React store is available.
 *
 * Endpoints are unregistered when the hook unmounts (e.g., user logs out).
 *
 * `/beaver/test/pdf-*` endpoints
 * ------------------------------
 * The pure PDF extraction endpoints (page count, render, extract,
 * analyze-layout, render-overlay, sentence bboxes, etc.) have BeaverExtract
 * CLI equivalents — see `docs-zotero/beaver-extract-cli.md` for the mapping.
 * Prefer the CLI for new debugging work; it skips the Zotero round-trip
 * and runs the same extraction code in Node. Endpoints that exercise
 * Zotero state (cache, notes, editor, item resolution, worker lifecycle)
 * stay HTTP-only.
 */

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { isAuthenticatedAtom } from '../atoms/auth';
import { logger } from '@beaver/agent-core/platform/logger';
import { getZoteroUserIdentifier } from '../../src/utils/zoteroUtils';
import { providerConnection } from '@beaver/agent-core/transport/providerConnection';
import { enqueueMutatingAction } from '@beaver/agent-core/transport/agentActionQueue';
import { getPref, setPref } from '../../src/utils/prefs';
import {
    handleZoteroDataRequest,
    handleExternalReferenceCheckRequest,
    handleZoteroDocumentRequest,
    handleZoteroAttachmentPageImagesRequest,
    handleZoteroAttachmentSearchRequest,
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
    handleItemQuickSearchRequest,
    // Library management tools
    handleZoteroSearchRequest,
    handleListItemsRequest,
    handleResolvePopulationRequest,
    handleGetMetadataRequest,
    handleFindAnnotationsRequest,
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
import { handleTestVoiceHttpRequest } from './httpHandlers/testVoiceHandlers';
import { handleTestVersionPopupHttpRequest } from './httpHandlers/testVersionPopupHandlers';
import {
    handleTestPingHttpRequest,
    handleTestCacheMetadataHttpRequest,
    handleTestCachePayloadHttpRequest,
    handleTestCacheInvalidateHttpRequest,
    handleTestCacheSeedPageLabelsHttpRequest,
    handleTestCacheClearAllHttpRequest,
    handleTestReadAttachmentHttpRequest,
    handleTestMcpReadNoteHttpRequest,
    handleTestMcpCreateNoteHttpRequest,
    handleTestWorkerStatsHttpRequest,
    handleTestWorkerMarkStaleHttpRequest,
    handleTestWorkerCacheClearHttpRequest,
    handleTestWorkerWedgeProbeHttpRequest,
    handleTestWorkerIdleProbeHttpRequest,
    handleTestWorkerRealmProbeHttpRequest,
    handleTestFileStatusHttpRequest,
    handleTestResolveItemHttpRequest,
    handleTestResolveReadableHttpRequest,
    handleTestBestEpubAttachmentHttpRequest,
    handleTestValidateItemHttpRequest,
    handleTestValidateRegularItemHttpRequest,
    handleTestExternalFileAttachHttpRequest,
    handleTestExternalFileDeleteHttpRequest,
    handleTestExternalFileViewImagesHttpRequest,
    handleTestDocumentSerializedHttpRequest,
    handleTestCacheStatsHttpRequest,
} from './httpHandlers/testCacheHandlers';
import {
    handleTestNoteCreateHttpRequest,
    handleTestNoteDeleteHttpRequest,
    handleTestNoteReadHttpRequest,
    handleTestNoteOpenEditorHttpRequest,
    handleTestNoteCloseEditorHttpRequest,
    handleTestNoteUndoHttpRequest,
    handleTestNoteApplyHttpRequest,
    handleTestNotePreviewHttpRequest,
} from './httpHandlers/testNoteHandlers';
import {
    handleTestCollectionCreateHttpRequest,
    handleTestCollectionDeleteHttpRequest,
} from './httpHandlers/testCollectionHandlers';
import {
    handleTestPdfRetrievalHttpRequest,
    handleTestPdfCaptchaEligibilityHttpRequest,
} from './httpHandlers/testPdfRetrievalHandlers';
import {
    handleTestAnnotationCreateHttpRequest,
} from './httpHandlers/testAnnotationHandlers';
import {
    handleTestSyncPauseHttpRequest,
} from './httpHandlers/testSyncHandlers';
import {
    handleTestSidebarWidthHandlerHttpRequest,
    handleTestWindowRuntimeHttpRequest,
} from './httpHandlers/testUiHandlers';
import {
    handleBatchProgressPreview,
    handleBatchProgressClear,
} from './httpHandlers/testBatchProgressHandlers';
import {
    handleTestPdfPageCountHttpRequest,
    handleTestPdfPageLabelsHttpRequest,
    handleTestPdfRenderPagesHttpRequest,
    handleTestPdfRenderPagesWithMetaHttpRequest,
    handleTestPdfExtractRawDetailedHttpRequest,
    handleTestPdfExtractHttpRequest,
    handleTestPdfExtractParagraphHttpRequest,
    handleTestPdfHasTextLayerHttpRequest,
    handleTestPdfAnalyzeOcrHttpRequest,
    handleTestPdfSearchScoredHttpRequest,
    handleTestPdfSentenceBBoxesHttpRequest,
    handleTestPdfRenderOverlayHttpRequest,
    handleTestPdfExtractTraceHttpRequest,
    handleTestPdfAnalyzeLayoutHttpRequest,
} from './httpHandlers/testPdfHandlers';
import {
    handleTestEpubExtractHttpRequest,
} from './httpHandlers/testEpubHandlers';
import {
    handleTestSnapshotExtractHttpRequest,
} from './httpHandlers/testSnapshotHandlers';
import {
    handleTestCreateReportHttpRequest,
} from './httpHandlers/testReportHandlers';
import {
    handleTestEpubAnnotationParityHttpRequest,
} from './httpHandlers/testEpubAnnotationHandlers';
import {
    handleTestSnapshotAnnotationParityHttpRequest,
} from './httpHandlers/testSnapshotAnnotationHandlers';
import {
    handleTestReaderStateHttpRequest,
    handleTestEpubCitationNavigateHttpRequest,
} from './httpHandlers/testReaderHandlers';
import {
    handleTestResolveItemDisplayHttpRequest,
} from './httpHandlers/testCitationHandlers';
import {
    handleTestBackgroundEnqueueHttpRequest,
    handleTestBackgroundStatsHttpRequest,
    handleTestBackgroundPeekHttpRequest,
    handleTestBackgroundProcessOnceHttpRequest,
    handleTestBackgroundClearHttpRequest,
} from './httpHandlers/testBackgroundHandlers';
import {
    handleTestProcessingReconcileNowHttpRequest,
    handleTestProcessingStatusHttpRequest,
    handleTestProcessingLedgerHttpRequest,
    handleTestProcessingResetHttpRequest,
} from './httpHandlers/testProcessingHandlers';
import {
    handleTestExcludedLibrariesHttpRequest,
    handleTestGetAnnotationsHttpRequest,
    handleTestViewImagesHttpRequest,
    handleTestAttachmentImageHttpRequest,
} from './httpHandlers/testExclusionHandlers';
import {
    handleTestLibraryIdentityHttpRequest,
} from './httpHandlers/testLibraryIdentityHandlers';
import {
    handleTestNewThreadHttpRequest,
    handleTestChatSendHttpRequest,
    handleTestCurrentIdsHttpRequest,
    handleTestLoadThreadHttpRequest,
    handleTestListActionsHttpRequest,
    handleTestApproveActionHttpRequest,
    handleTestConfirmCreditsHttpRequest,
    handleTestUndoActionHttpRequest,
} from './httpHandlers/testChatHandlers';
import {
    handleTestApplicationStateHttpRequest,
    handleTestBeaverSidebarHttpRequest,
    handleTestBeaverWindowHttpRequest,
    handleTestSelectTabHttpRequest,
} from './httpHandlers/testApplicationStateHandlers';
import {
    handleTestOpenTableHttpRequest,
    handleTestCloseTableHttpRequest,
    handleTestOpenStoredTableHttpRequest,
    handleTestTableCreateHttpRequest,
    handleTestTableReadHttpRequest,
    handleTestTableListHttpRequest,
    handleTestTableWriteHttpRequest,
    handleTestTableEditHttpRequest,
    handleTestTableVersionsHttpRequest,
    handleTestTableRevertHttpRequest,
    handleTestTableDeleteHttpRequest,
    handleTestTableTrimHttpRequest,
    handleTestTableOpenHttpRequest,
    handleTestTableCorruptHttpRequest,
    handleTestTableShadowHttpRequest,
    handleTestTableRestoreShadowHttpRequest,
    handleTestTableOpenReaderHttpRequest,
    handleTestTableItemPaneHttpRequest,
    handleTestTableViewStateHttpRequest,
} from './httpHandlers/testTableHandlers';
import { handleTestRunStatusPopupHttpRequest } from './httpHandlers/testRunStatusPopupHandlers';
import { handleTestQuickPromptHttpRequest } from './httpHandlers/testQuickPromptHandlers';
import { handleTestListSavedActionsHttpRequest } from './httpHandlers/testSavedActionsHandlers';
import type {
    WSZoteroDataRequest,
    WSExternalReferenceCheckRequest,
    WSZoteroDocumentRequest,
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentSearchRequest,
    WSItemSearchByMetadataRequest,
    WSItemSearchByTopicRequest,
    WSItemQuickSearchRequest,
    // Library management tools
    WSZoteroSearchRequest,
    WSListItemsRequest,
    WSResolvePopulationRequest,
    WSGetMetadataRequest,
    WSFindAnnotationsRequest,
    WSListLibrariesRequest,
    WSListCollectionsRequest,
    WSListTagsRequest,
    // Deferred tools
    WSAgentActionValidateRequest,
    WSAgentActionExecuteRequest,
    // Notes
    WSReadNoteRequest,
} from '@beaver/agent-core/protocol/agentProtocol';


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
        include_notes: request.include_notes,
        file_status_level: request.file_status_level,
    };

    const response = await handleZoteroDataRequest(wsRequest);

    return {
        items: response.items,
        attachments: response.attachments,
        notes: response.notes,
        annotations: response.annotations,
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
        error: response.error ?? null,
        error_code: response.error_code ?? null,
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
        error: response.error ?? null,
        error_code: response.error_code ?? null,
    };
}

async function handleQuickSearchHttpRequest(request: any) {
    const wsRequest: WSItemQuickSearchRequest = {
        event: 'item_quick_search_request',
        request_id: generateRequestId(),
        query: request.query,
        item_type_filter: request.item_type_filter,
        libraries_filter: request.libraries_filter,
        tags_filter: request.tags_filter,
        collections_filter: request.collections_filter,
        detail: request.detail,
        limit: request.limit,
        offset: request.offset,
    };

    const response = await handleItemQuickSearchRequest(wsRequest);

    return {
        items: response.items,
        detail: response.detail,
        total_count: response.total_count,
        // Without this a caller reads a truncated total as the complete match
        // count and pages into a hole. LocalhostFrontendCapability reads it.
        truncated: response.truncated ?? false,
        error: response.error ?? null,
        error_code: response.error_code ?? null,
    };
}

async function handleAttachmentDocumentHttpRequest(request: any) {
    const wsRequest: WSZoteroDocumentRequest = {
        event: 'zotero_document_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        external_file_key: request.external_file_key,
        mode: request.mode ?? 'structured',
        max_pages: request.max_pages,
        timeout_seconds: request.timeout_seconds,
    };

    const response = await handleZoteroDocumentRequest(wsRequest);

    return {
        resolved_attachment: response.resolved_attachment,
        external_file_key: response.external_file_key,
        content_type: response.content_type,
        content_kind: response.content_kind,
        result: response.result,
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
        timeout_seconds: request.timeout_seconds,
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
        timeout_seconds: request.timeout_seconds,
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
        // Validation warnings identify invalid conditions that were not applied.
        warnings: response.warnings,
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

/**
 * Population resolution over HTTP. The backend's localhost frontend posts here,
 * so the accepted body and the returned shape must stay identical to the
 * `resolve_population` wire request/response.
 */
async function handleResolvePopulationHttpRequest(request: any) {
    const wsRequest: WSResolvePopulationRequest = {
        event: 'resolve_population_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        collection_keys: request.collection_keys ?? [],
        recursive: request.recursive ?? true,
        tags: request.tags ?? [],
        unfiled: request.unfiled ?? false,
        untagged: request.untagged ?? false,
        conditions: request.conditions || [],
        conditions_join_mode: request.conditions_join_mode ?? null,
        any_conditions: request.any_conditions || [],
        item_category: request.item_category === 'attachment' ? 'attachment' : 'regular',
        has_attachments: request.has_attachments ?? null,
        max_items: request.max_items ?? 1000,
        exclude_item_ids: request.exclude_item_ids ?? [],
    };

    const response = await handleResolvePopulationRequest(wsRequest);

    return {
        item_ids: response.item_ids,
        total_count: response.total_count,
        // Presence tells the caller this build applied `exclude_item_ids`.
        // Forwarded here too, like `conditions_join_mode`, or a localhost
        // run cannot continue a batch.
        excluded_count: response.excluded_count,
        // How many bibliographic items matched, before an attachment population
        // was derived from them. Without it the caller cannot tell an empty
        // attachment population from filters that matched nothing.
        matched_item_count: response.matched_item_count,
        truncated: response.truncated,
        // The place the population lives, which the approval card states from
        // these alone — the WebSocket transport forwards them, so this one has
        // to as well or a localhost run loses the WHERE half of the card.
        library_name: response.library_name,
        collection_names: response.collection_names,
        // The join mode actually applied to `conditions`. Its absence is how the
        // caller detects a provider that predates the field, so it has to be
        // forwarded here too.
        conditions_join_mode: response.conditions_join_mode,
        // Same again for the `any_conditions` group, and it matters more: a
        // provider that predates the field drops the group and resolves a
        // WIDER population than the caller described.
        any_conditions_applied: response.any_conditions_applied,
        // A dropped condition widens the population; the caller must not act on
        // ids that came back with a warning.
        warnings: response.warnings,
        error: response.error,
        error_code: response.error_code,
        available_libraries: response.available_libraries,
    };
}

async function handleLibraryMetadataHttpRequest(request: any) {
    const wsRequest: WSGetMetadataRequest = {
        event: 'get_metadata_request',
        request_id: generateRequestId(),
        item_ids: request.item_ids || [],
        include_attachments: request.include_attachments ?? false,
        include_notes: request.include_notes ?? false,
        detail: request.detail,
    };

    const response = await handleGetMetadataRequest(wsRequest);

    return {
        items: response.items,
        detail: response.detail,
        not_found: response.not_found,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleFindAnnotationsHttpRequest(request: any) {
    const wsRequest: WSFindAnnotationsRequest = {
        event: 'find_annotations_request',
        request_id: generateRequestId(),
        text_contains: request.text_contains,
        comment_contains: request.comment_contains,
        tag: request.tag,
        color: request.color,
        annotation_type: request.annotation_type,
        author: request.author,
        attachment_id: request.attachment_id,
        collection: request.collection,
        recursive: request.recursive ?? true,
        library_id: request.library_id,
        modified_in_last: request.modified_in_last,
        sort_by: request.sort_by ?? 'date_modified',
        sort_order: request.sort_order ?? 'desc',
        limit: request.limit ?? 25,
        offset: request.offset ?? 0,
    };

    const response = await handleFindAnnotationsRequest(wsRequest);

    return {
        annotations: response.annotations,
        total_count: response.total_count,
        note: response.note,
        error: response.error,
        error_code: response.error_code,
        available_libraries: response.available_libraries,
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
        recursive: request.recursive ?? false,
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
        name_query: request.name_query,
        // Pass through so omitted stays 'all' in the handler.
        tag_type: request.tag_type,
        limit: request.limit ?? 50,
        offset: request.offset ?? 0,
    };

    const response = await handleListTagsRequest(wsRequest);

    return {
        tags: response.tags,
        total_count: response.total_count,
        manual_count: response.manual_count,
        automatic_count: response.automatic_count,
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

    // Hand-maintained projection of WSAgentActionValidateResponse minus the
    // transport envelope.
    return {
        valid: response.valid,
        error: response.error,
        error_code: response.error_code,
        error_candidates: response.error_candidates,
        edit_errors: response.edit_errors,
        current_value: response.current_value,
        normalized_action_data: response.normalized_action_data,
        collection_names: response.collection_names,
        preference: response.preference,
        warnings: response.warnings,
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

    // Mirror the `serialize` flag the WebSocket dispatch map sets on
    // `agent_action_execute`: action handlers hold no per-item lock, so two
    // executes landing together on one item would each write back the content
    // they read and the later save would drop the earlier edit.
    const response = await enqueueMutatingAction(() =>
        handleAgentActionExecuteRequest(wsRequest),
    );

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

// Provider-mode connection control (dev-only). Lets tests/agents open the
// provider WebSocket without a wake broadcast, inspect its state, and close it.
// Set a Beaver pref (dev-only). Lets agents/tests flip pref-gated features
// (e.g. dataProviderEnabled) without the RDP bridge.
async function handleTestSetPrefHttpRequest(request: any) {
    const { key, value } = request ?? {};
    if (typeof key !== 'string' || !key) {
        throw new Error('key is required');
    }
    setPref(key as any, value);
    return { ok: true, key, value: getPref(key as any) };
}

async function handleTestProviderConnectHttpRequest(request: any) {
    await providerConnection.connect({
        wakeId: request?.wake_id,
        wakeInstanceId: request?.wake_instance_id,
    });
    return { ok: true, status: providerConnection.getStatus() };
}

async function handleTestProviderStatusHttpRequest(_request: any) {
    return providerConnection.getStatus();
}

async function handleTestProviderCloseHttpRequest(_request: any) {
    providerConnection.close();
    return { ok: true, status: providerConnection.getStatus() };
}


// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register the local HTTP surface.
 *
 * Callers must gate this on the build: `useHttpEndpoints` registers only in
 * development and staging builds, so NONE of the paths below — not just the
 * `/beaver/test/*` block near the end — reach a released build. The nested
 * `NODE_ENV === 'development'` check further restricts the test-only endpoints
 * to development, keeping them out of staging.
 */
function registerEndpoints(): (() => void) | undefined {
    const runtime = tryGetWindowRuntime();
    if (!runtime || !Zotero?.Server?.Endpoints) return;
    const endpoints: Record<string, any> = {};
    endpoints['/beaver/zotero-data'] =
        createEndpoint(handleZoteroDataHttpRequest);
    
    endpoints['/beaver/external-reference-check'] =
        createEndpoint(handleExternalReferenceCheckHttpRequest);
    
    endpoints['/beaver/search/metadata'] =
        createEndpoint(handleMetadataSearchHttpRequest);
    
    endpoints['/beaver/search/topic'] =
        createEndpoint(handleTopicSearchHttpRequest);

    endpoints['/beaver/search/quick'] =
        createEndpoint(handleQuickSearchHttpRequest);

    endpoints['/beaver/attachment/document'] =
        createEndpoint(handleAttachmentDocumentHttpRequest);
    
    endpoints['/beaver/attachment/page-images'] =
        createEndpoint(handleAttachmentPageImagesHttpRequest);
    
    endpoints['/beaver/attachment/search'] =
        createEndpoint(handleAttachmentSearchHttpRequest);
    
    // Library management endpoints
    endpoints['/beaver/library/search'] =
        createEndpoint(handleLibrarySearchHttpRequest);
    
    endpoints['/beaver/library/list'] =
        createEndpoint(handleLibraryListHttpRequest);
    
    endpoints['/beaver/library/resolve-population'] =
        createEndpoint(handleResolvePopulationHttpRequest);

    endpoints['/beaver/library/metadata'] =
        createEndpoint(handleLibraryMetadataHttpRequest);

    endpoints['/beaver/library/find-annotations'] =
        createEndpoint(handleFindAnnotationsHttpRequest);

    endpoints['/beaver/library/libraries'] =
        createEndpoint(handleListLibrariesHttpRequest);

    endpoints['/beaver/library/collections'] =
        createEndpoint(handleListCollectionsHttpRequest);

    endpoints['/beaver/library/tags'] =
        createEndpoint(handleListTagsHttpRequest);

    // Deferred tool endpoints
    endpoints['/beaver/agent-action/validate'] =
        createEndpoint(handleAgentActionValidateHttpRequest);

    endpoints['/beaver/agent-action/execute'] =
        createEndpoint(handleAgentActionExecuteHttpRequest);

    // Utility endpoints
    endpoints['/beaver/user-info'] =
        createEndpoint(handleUserInfoHttpRequest);

    endpoints['/beaver/delete-items'] =
        createEndpoint(handleDeleteItemsHttpRequest);

    // Note endpoints
    endpoints['/beaver/note/read'] =
        createEndpoint(handleReadNoteHttpRequest);

    // Test-only endpoints (dev builds only)
    if (process.env.NODE_ENV === 'development') {
        endpoints['/beaver/test/voice'] = createEndpoint(handleTestVoiceHttpRequest);
        endpoints['/beaver/test/ping'] =
            createEndpoint(handleTestPingHttpRequest);

        endpoints['/beaver/test/cache-metadata'] =
            createEndpoint(handleTestCacheMetadataHttpRequest);

        endpoints['/beaver/test/cache-payload'] =
            createEndpoint(handleTestCachePayloadHttpRequest);

        endpoints['/beaver/test/cache-invalidate'] =
            createEndpoint(handleTestCacheInvalidateHttpRequest);

        endpoints['/beaver/test/cache-seed-page-labels'] =
            createEndpoint(handleTestCacheSeedPageLabelsHttpRequest);

        endpoints['/beaver/test/cache-clear-all'] =
            createEndpoint(handleTestCacheClearAllHttpRequest);

        endpoints['/beaver/test/cache-stats'] =
            createEndpoint(handleTestCacheStatsHttpRequest);

        endpoints['/beaver/test/read-attachment'] =
            createEndpoint(handleTestReadAttachmentHttpRequest);

        endpoints['/beaver/test/mcp-read-note'] =
            createEndpoint(handleTestMcpReadNoteHttpRequest);

        endpoints['/beaver/test/mcp-create-note'] =
            createEndpoint(handleTestMcpCreateNoteHttpRequest);

        endpoints['/beaver/test/resolve-item'] =
            createEndpoint(handleTestResolveItemHttpRequest);
        endpoints['/beaver/test/resolve-readable'] =
            createEndpoint(handleTestResolveReadableHttpRequest);
        endpoints['/beaver/test/best-epub-attachment'] =
            createEndpoint(handleTestBestEpubAttachmentHttpRequest);
        endpoints['/beaver/test/validate-item'] =
            createEndpoint(handleTestValidateItemHttpRequest);
        endpoints['/beaver/test/validate-regular-item'] =
            createEndpoint(handleTestValidateRegularItemHttpRequest);

        // External-file attach/delete/view-images (dev-only; seeds the registry for live tests)
        endpoints['/beaver/test/external-file-attach'] =
            createEndpoint(handleTestExternalFileAttachHttpRequest);
        endpoints['/beaver/test/external-file-delete'] =
            createEndpoint(handleTestExternalFileDeleteHttpRequest);
        endpoints['/beaver/test/external-file-view-images'] =
            createEndpoint(handleTestExternalFileViewImagesHttpRequest);

        // Serialized PDF document-request wire path (dev-only): exercises the
        // websocket response mode, PreparedJsonMessage splice, and
        // guardSerializedPayloadSize that the object-mode endpoint skips.
        endpoints['/beaver/test/document-serialized'] =
            createEndpoint(handleTestDocumentSerializedHttpRequest);

        // Batch progress bar preview (dev-only): stage a synthetic stamp so the
        // bar can be inspected in every operation and ledger state without
        // paying for a real batch run of each.
        endpoints['/beaver/test/batch-progress-preview'] =
            createEndpoint(handleBatchProgressPreview);

        endpoints['/beaver/test/batch-progress-clear'] =
            createEndpoint(handleBatchProgressClear);

        // MuPDF worker singleton stats / lifecycle (dev-only)
        endpoints['/beaver/test/worker-stats'] =
            createEndpoint(handleTestWorkerStatsHttpRequest);

        endpoints['/beaver/test/worker-mark-stale'] =
            createEndpoint(handleTestWorkerMarkStaleHttpRequest);

        endpoints['/beaver/test/worker-cache-clear'] =
            createEndpoint(handleTestWorkerCacheClearHttpRequest);

        endpoints['/beaver/test/worker-wedge-probe'] =
            createEndpoint(handleTestWorkerWedgeProbeHttpRequest);

        endpoints['/beaver/test/worker-idle-probe'] =
            createEndpoint(handleTestWorkerIdleProbeHttpRequest);

        endpoints['/beaver/test/worker-realm-probe'] =
            createEndpoint(handleTestWorkerRealmProbeHttpRequest);

        // File-status side-effect trigger (dev-only)
        endpoints['/beaver/test/file-status'] =
            createEndpoint(handleTestFileStatusHttpRequest);

        // Note-specific test endpoints (seeding/teardown/inspection/undo)
        endpoints['/beaver/test/note-create'] =
            createEndpoint(handleTestNoteCreateHttpRequest);

        endpoints['/beaver/test/note-delete'] =
            createEndpoint(handleTestNoteDeleteHttpRequest);

        endpoints['/beaver/test/note-read'] =
            createEndpoint(handleTestNoteReadHttpRequest);

        endpoints['/beaver/test/note-open-editor'] =
            createEndpoint(handleTestNoteOpenEditorHttpRequest);

        endpoints['/beaver/test/note-close-editor'] =
            createEndpoint(handleTestNoteCloseEditorHttpRequest);

        endpoints['/beaver/test/note-undo'] =
            createEndpoint(handleTestNoteUndoHttpRequest);

        endpoints['/beaver/test/note-apply'] =
            createEndpoint(handleTestNoteApplyHttpRequest);

        endpoints['/beaver/test/note-preview'] =
            createEndpoint(handleTestNotePreviewHttpRequest);

        // Collection seeding/teardown (dev-only)
        endpoints['/beaver/test/collection-create'] =
            createEndpoint(handleTestCollectionCreateHttpRequest);

        endpoints['/beaver/test/collection-delete'] =
            createEndpoint(handleTestCollectionDeleteHttpRequest);

        // PDF-retrieval measurement (dev-only)
        endpoints['/beaver/test/pdf-retrieval'] =
            createEndpoint(handleTestPdfRetrievalHttpRequest);

        endpoints['/beaver/test/pdf-captcha-eligibility'] =
            createEndpoint(handleTestPdfCaptchaEligibilityHttpRequest);

        // Headless PDF annotation primitives (dev-only)
        endpoints['/beaver/test/annotation-create'] =
            createEndpoint(handleTestAnnotationCreateHttpRequest);

        // MuPDF worker plumbing (dev-only)
        endpoints['/beaver/test/pdf-page-count'] =
            createEndpoint(handleTestPdfPageCountHttpRequest);

        endpoints['/beaver/test/pdf-page-labels'] =
            createEndpoint(handleTestPdfPageLabelsHttpRequest);

        endpoints['/beaver/test/pdf-render-pages'] =
            createEndpoint(handleTestPdfRenderPagesHttpRequest);

        endpoints['/beaver/test/pdf-render-pages-with-meta'] =
            createEndpoint(handleTestPdfRenderPagesWithMetaHttpRequest);

        endpoints['/beaver/test/pdf-extract-raw-detailed'] =
            createEndpoint(handleTestPdfExtractRawDetailedHttpRequest);

        // orchestration parity endpoints
        endpoints['/beaver/test/pdf-extract'] =
            createEndpoint(handleTestPdfExtractHttpRequest);

        endpoints['/beaver/test/pdf-extract-paragraph'] =
            createEndpoint(handleTestPdfExtractParagraphHttpRequest);

        endpoints['/beaver/test/pdf-has-text-layer'] =
            createEndpoint(handleTestPdfHasTextLayerHttpRequest);

        endpoints['/beaver/test/pdf-analyze-ocr'] =
            createEndpoint(handleTestPdfAnalyzeOcrHttpRequest);

        endpoints['/beaver/test/pdf-search-scored'] =
            createEndpoint(handleTestPdfSearchScoredHttpRequest);

        endpoints['/beaver/test/pdf-sentence-bboxes'] =
            createEndpoint(handleTestPdfSentenceBBoxesHttpRequest);

        // Bbox overlay endpoint — paints columns/lines/items/paragraphs/sentences/
        // margins on a rendered page PNG for headless agent debugging.
        endpoints['/beaver/test/pdf-render-overlay'] =
            createEndpoint(handleTestPdfRenderOverlayHttpRequest);

        // Per-page extract trace — emits every stage of the extraction
        // pipeline as JSON with cross-stage IDs, so an agent can trace
        // one piece of text from raw line through items to sentences.
        endpoints['/beaver/test/pdf-extract-trace'] =
            createEndpoint(handleTestPdfExtractTraceHttpRequest);

        // Full analysis context (style profile + margin analysis + margin
        // removal) computed by the same prefix `extract({ mode:
        // "structured" })` runs before per-page processing. Backs the
        // `level: "margins"` overlay and is also exposed standalone for
        // debugging.
        endpoints['/beaver/test/pdf-analyze-layout'] =
            createEndpoint(handleTestPdfAnalyzeLayoutHttpRequest);

        // EPUB extraction over a raw file path / attachment (corpus triage)
        endpoints['/beaver/test/epub-extract'] =
            createEndpoint(handleTestEpubExtractHttpRequest);

        // Snapshot extraction over a raw HTML file path / attachment
        endpoints['/beaver/test/snapshot-extract'] =
            createEndpoint(handleTestSnapshotExtractHttpRequest);

        // Generated HTML report stored as a snapshot attachment
        endpoints['/beaver/test/create-report'] =
            createEndpoint(handleTestCreateReportHttpRequest);

        // EPUB annotation CFI/sortIndex parity: headless resolver vs the reader's
        // own getAnnotationFromRange for the same target.
        endpoints['/beaver/test/epub-annotation-parity'] =
            createEndpoint(handleTestEpubAnnotationParityHttpRequest);

        // Snapshot annotation selector/sortIndex parity.
        endpoints['/beaver/test/snapshot-annotation-parity'] =
            createEndpoint(handleTestSnapshotAnnotationParityHttpRequest);

        // Reader position (`getCurrentPage` / `content_kind`) and the EPUB
        // citation-navigation path against the live reader.
        endpoints['/beaver/test/reader-state'] =
            createEndpoint(handleTestReaderStateHttpRequest);

        endpoints['/beaver/test/epub-citation-navigate'] =
            createEndpoint(handleTestEpubCitationNavigateHttpRequest);

        // Citation host: itemData.resolveItemDisplay (icon item type +
        // readable-attachment availability for cited-source rows).
        endpoints['/beaver/test/resolve-item-display'] =
            createEndpoint(handleTestResolveItemDisplayHttpRequest);

        // Background queue (dev-only)
        endpoints['/beaver/test/background-enqueue'] =
            createEndpoint(handleTestBackgroundEnqueueHttpRequest);

        endpoints['/beaver/test/background-stats'] =
            createEndpoint(handleTestBackgroundStatsHttpRequest);

        endpoints['/beaver/test/background-peek'] =
            createEndpoint(handleTestBackgroundPeekHttpRequest);

        endpoints['/beaver/test/background-process-once'] =
            createEndpoint(handleTestBackgroundProcessOnceHttpRequest);

        endpoints['/beaver/test/background-clear'] =
            createEndpoint(handleTestBackgroundClearHttpRequest);

        // Whole-library processing (dev-only): drives ReconcilerService and
        // exposes the ledger the prefs section aggregates.
        endpoints['/beaver/test/processing-reconcile-now'] =
            createEndpoint(handleTestProcessingReconcileNowHttpRequest);

        endpoints['/beaver/test/processing-status'] =
            createEndpoint(handleTestProcessingStatusHttpRequest);

        endpoints['/beaver/test/processing-ledger'] =
            createEndpoint(handleTestProcessingLedgerHttpRequest);

        endpoints['/beaver/test/processing-reset'] =
            createEndpoint(handleTestProcessingResetHttpRequest);

        // Pref control (dev-only)
        endpoints['/beaver/test/set-pref'] =
            createEndpoint(handleTestSetPrefHttpRequest);

        // Sync-suppression control/inspection (dev-only): drives the real
        // syncPause module + raw Sync.Runner contract for live tests.
        endpoints['/beaver/test/sync-pause'] =
            createEndpoint(handleTestSyncPauseHttpRequest);

        // Reader sidebar-width wrapper lifecycle (dev-only): drives the real
        // dispatcher install/unwrap/restore path against Zotero.Reader.
        endpoints['/beaver/test/window-runtime'] =
            createEndpoint(handleTestWindowRuntimeHttpRequest);

        endpoints['/beaver/test/sidebar-width-handler'] =
            createEndpoint(handleTestSidebarWidthHandlerHttpRequest);

        // Provider-mode connection control (dev-only manual trigger/inspection)
        endpoints['/beaver/test/provider-connect'] =
            createEndpoint(handleTestProviderConnectHttpRequest);

        endpoints['/beaver/test/provider-status'] =
            createEndpoint(handleTestProviderStatusHttpRequest);

        endpoints['/beaver/test/provider-close'] =
            createEndpoint(handleTestProviderCloseHttpRequest);

        // Library-exclusion control/inspection (dev-only): drives the in-memory
        // excluded-libraries set that gates every read/write path.
        endpoints['/beaver/test/excluded-libraries'] =
            createEndpoint(handleTestExcludedLibrariesHttpRequest);

        // Exclusion-gated handlers that have no production HTTP route.
        endpoints['/beaver/test/get-annotations'] =
            createEndpoint(handleTestGetAnnotationsHttpRequest);

        endpoints['/beaver/test/view-images'] =
            createEndpoint(handleTestViewImagesHttpRequest);

        endpoints['/beaver/test/attachment-image'] =
            createEndpoint(handleTestAttachmentImageHttpRequest);

        // Device-portable library-identity resolvers (dev-only): thin wrappers
        // over libraryRefForLibraryID / parseLibraryRef / resolveLibraryRef /
        // resolveItemReference so live tests can assert them against real
        // personal + group libraries.
        endpoints['/beaver/test/library-identity'] =
            createEndpoint(handleTestLibraryIdentityHttpRequest);
        // Headless chat/run lifecycle (dev-only): trigger the real send/approval/
        // undo path over HTTP by writing the same Jotai action atoms the UI writes,
        // so an automated agent can drive full agent runs without poking the
        // Lexical editor (which can't be reliably driven by synthetic events).
        endpoints['/beaver/test/new-thread'] =
            createEndpoint(handleTestNewThreadHttpRequest);
        endpoints['/beaver/test/chat-send'] =
            createEndpoint(handleTestChatSendHttpRequest);
        endpoints['/beaver/test/current-ids'] =
            createEndpoint(handleTestCurrentIdsHttpRequest);
        endpoints['/beaver/test/load-thread'] =
            createEndpoint(handleTestLoadThreadHttpRequest);
        endpoints['/beaver/test/list-actions'] =
            createEndpoint(handleTestListActionsHttpRequest);
        endpoints['/beaver/test/approve-action'] =
            createEndpoint(handleTestApproveActionHttpRequest);
        endpoints['/beaver/test/confirm-credits'] =
            createEndpoint(handleTestConfirmCreditsHttpRequest);
        endpoints['/beaver/test/undo-action'] =
            createEndpoint(handleTestUndoActionHttpRequest);

        endpoints['/beaver/test/application-state'] =
            createEndpoint(handleTestApplicationStateHttpRequest);

        endpoints['/beaver/test/beaver-window'] =
            createEndpoint(handleTestBeaverWindowHttpRequest);

        endpoints['/beaver/test/open-table'] =
            createEndpoint(handleTestOpenTableHttpRequest);

        endpoints['/beaver/test/close-table'] =
            createEndpoint(handleTestCloseTableHttpRequest);

        // `openTable` itself — the product path the item-pane button takes.
        endpoints['/beaver/test/open-stored-table'] =
            createEndpoint(handleTestOpenStoredTableHttpRequest);

        // Stored tables (dev-only): create the real snapshot attachment, read
        // the spec back out of the file, and list what is in the library.
        endpoints['/beaver/test/table-create'] =
            createEndpoint(handleTestTableCreateHttpRequest);

        endpoints['/beaver/test/table-read'] =
            createEndpoint(handleTestTableReadHttpRequest);

        endpoints['/beaver/test/table-list'] =
            createEndpoint(handleTestTableListHttpRequest);

        // The versioned store (dev-only): the write protocol, the version log,
        // revert, trash/restore, and the crash recovery `open` performs.
        // `table-corrupt` damages the storage directory on purpose so that
        // recovery can be exercised without staging a real crash.
        endpoints['/beaver/test/table-write'] =
            createEndpoint(handleTestTableWriteHttpRequest);

        endpoints['/beaver/test/table-edit'] =
            createEndpoint(handleTestTableEditHttpRequest);

        endpoints['/beaver/test/table-versions'] =
            createEndpoint(handleTestTableVersionsHttpRequest);

        endpoints['/beaver/test/table-revert'] =
            createEndpoint(handleTestTableRevertHttpRequest);

        endpoints['/beaver/test/table-trim'] =
            createEndpoint(handleTestTableTrimHttpRequest);

        endpoints['/beaver/test/table-delete'] =
            createEndpoint(handleTestTableDeleteHttpRequest);

        endpoints['/beaver/test/table-open'] =
            createEndpoint(handleTestTableOpenHttpRequest);

        endpoints['/beaver/test/table-corrupt'] =
            createEndpoint(handleTestTableCorruptHttpRequest);

        // The recovery shadow (dev-only): what this device last wrote to a
        // table, whether the table has gone backwards under it, and putting
        // this device's version back.
        endpoints['/beaver/test/table-shadow'] =
            createEndpoint(handleTestTableShadowHttpRequest);

        endpoints['/beaver/test/table-restore-shadow'] =
            createEndpoint(handleTestTableRestoreShadowHttpRequest);

        // The reader host (dev-only): open a stored table in the reader and
        // report which of the enhancer's seams attached, and list every table
        // document currently enhanced in either host.
        endpoints['/beaver/test/table-open-reader'] =
            createEndpoint(handleTestTableOpenReaderHttpRequest);

        endpoints['/beaver/test/table-view-state'] =
            createEndpoint(handleTestTableViewStateHttpRequest);

        // The item-pane section (dev-only): whether it is registered, and the
        // fields it would render for one table.
        endpoints['/beaver/test/table-item-pane'] =
            createEndpoint(handleTestTableItemPaneHttpRequest);

        endpoints['/beaver/test/beaver-sidebar'] =
            createEndpoint(handleTestBeaverSidebarHttpRequest);

        endpoints['/beaver/test/select-tab'] =
            createEndpoint(handleTestSelectTabHttpRequest);

        endpoints['/beaver/test/run-status-popup'] =
            createEndpoint(handleTestRunStatusPopupHttpRequest);

        endpoints['/beaver/test/quick-prompt'] =
            createEndpoint(handleTestQuickPromptHttpRequest);

        endpoints['/beaver/test/version-popup'] =
            createEndpoint(handleTestVersionPopupHttpRequest);

        endpoints['/beaver/test/saved-actions'] =
            createEndpoint(handleTestListSavedActionsHttpRequest);
    }

    const releases = Object.entries(endpoints).map(([path, handler]) =>
        Zotero.Beaver.runtime.registerWindowEndpoint(runtime, path, handler),
    );
    logger(`useHttpEndpoints: Registered ${releases.length} HTTP endpoints`, 3);
    return () => { for (const release of releases) release(); };
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
        return registerEndpoints();
    }, [isAuthenticated]);
}
