/**
 * Dev-only HTTP handlers for cache inspection, MuPDF worker lifecycle,
 * file-status side-effect, and item resolution.
 *
 * Extracted from `useHttpEndpoints.ts`. Handler exports are wired to paths
 * in `useHttpEndpoints.ts` → `registerEndpoints()`.
 */

import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';

export async function handleTestPingHttpRequest(_request: any) {
    const cache = Zotero.Beaver?.documentCache;
    const db = Zotero.Beaver?.db;
    return {
        ok: true,
        cache_available: !!cache,
        db_available: !!db,
    };
}

export async function handleTestCacheMetadataHttpRequest(request: any) {
    const { library_id, zotero_key, item_id } = request;
    const db = Zotero.Beaver?.db;
    if (!db) return { error: 'db not available' };

    let record;
    if (item_id != null) {
        const allRecords = await db.getAllDocumentCacheMetadata();
        record = allRecords.find((row: any) => row.itemId === item_id) ?? null;
    } else if (library_id != null && zotero_key != null) {
        record = await db.getDocumentCacheMetadataByKey(library_id, zotero_key);
    } else {
        return { error: 'Provide item_id or library_id + zotero_key' };
    }
    return { record: record ?? null };
}

/**
 * Dev-only: return a document-cache payload row by key + payload kind.
 *
 * Lets tests assert on the payload table's persisted discriminator columns
 * without exposing the gzipped payload file. Returns `{ record: null }` when
 * no payload exists.
 */
export async function handleTestCachePayloadHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    const payloadKind = request.payload_kind ?? request.mode;
    const db = Zotero.Beaver?.db;
    if (!db) return { error: 'db not available' };
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const record = await db.getDocumentCachePayload(
        library_id,
        zotero_key,
        payloadKind === 'structured' || payloadKind === 'markdown' ? payloadKind : 'markdown',
    );
    return { record: record ?? null };
}

export async function handleTestCacheInvalidateHttpRequest(request: any) {
    const { library_id, zotero_key, item_id } = request;
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return { error: 'cache not available' };

    if (item_id != null && library_id != null && zotero_key != null) {
        await cache.invalidate(library_id, zotero_key);
    } else if (library_id != null && zotero_key != null) {
        await cache.invalidate(library_id, zotero_key);
    } else {
        return { error: 'Provide library_id + zotero_key (and optionally item_id)' };
    }
    return { ok: true };
}

/**
 * Dev-only: seed document-cache page-label metadata for an attachment.
 *
 * Thin wrapper over the real `DocumentCache.putMetadata` write path so tests
 * can deterministically place page labels in the cache without running a full
 * PDF extraction. The source identity (mtime/size) is derived from the real
 * attachment file, so the seeded record is treated as fresh by `getMetadata`.
 *
 * Request: `{ library_id, zotero_key, page_labels: { "0": "iii", ... }, page_count? }`.
 */
export async function handleTestCacheSeedPageLabelsHttpRequest(request: any) {
    const { library_id, zotero_key, page_labels, page_count } = request as {
        library_id?: number;
        zotero_key?: string;
        page_labels?: Record<string, string>;
        page_count?: number;
    };
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return { error: 'cache not available' };
    if (library_id == null || zotero_key == null || page_labels == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id, zotero_key, and page_labels' };
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item || typeof item === 'boolean') return { error: 'not_found' };
    if (!item.isAttachment()) return { error: 'not_an_attachment' };

    const filePath = await item.getFilePathAsync();
    if (!filePath) return { error: 'no_file' };

    // Normalize incoming JSON keys ("0", "1", ...) to a 0-based index map.
    const pageLabels: Record<number, string> = {};
    for (const [k, v] of Object.entries(page_labels)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && idx >= 0) pageLabels[idx] = String(v);
    }

    await cache.putMetadata({
        item,
        filePath,
        // sourceSizeBytes is recomputed from the real file for local paths.
        sourceSizeBytes: 0,
        contentType: 'application/pdf',
        metadata: {
            contentKind: 'pdf',
            pageCount: typeof page_count === 'number' ? page_count : Object.keys(pageLabels).length,
            pageLabels,
            pages: null,
        },
    });

    const record = await cache.getMetadata(
        { libraryId: item.libraryID, zoteroKey: item.key },
        filePath,
    );
    return {
        ok: true,
        seeded: !!(record?.pageLabels && Object.keys(record.pageLabels).length > 0),
        page_labels: record?.pageLabels ?? null,
    };
}

/**
 * Dev-only: completely clear the document cache (metadata rows, payload
 * rows, and payload files on disk). Mirrors the DevTools "Clear Document
 * Cache" menu item, exposed over HTTP so tests can reset to a cold cache.
 */
export async function handleTestCacheClearAllHttpRequest(_request: any) {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return { error: 'cache not available' };
    const { metadataRows, payloadRows } = await cache.clearAll();
    return { ok: true, metadataRows, payloadRows };
}

/**
 * Dev-only: invoke the MCP `read_attachment` tool handler directly.
 *
 * Exercises the exact tool code path — `start_page` / `end_page` integer
 * validation, the `zotero_document_request` round-trip, and page-window
 * slicing — so tests can assert on it without a live MCP client.
 *
 * Returns the tool's raw result: a plain string on success, or an MCP
 * error object (`{ content, isError: true }`) on failure.
 */
export async function handleTestReadAttachmentHttpRequest(request: any) {
    const { handleReadAttachment } = await import('../useMcpServer');
    const result = await handleReadAttachment(request || {});
    return { result };
}

/**
 * Dev-only: invoke the MCP `read_note` tool handler directly.
 *
 * Returns the tool's raw result: a compact note object on success, or an MCP
 * error object (`{ content, isError: true }`) on failure.
 */
export async function handleTestMcpReadNoteHttpRequest(request: any) {
    const { handleReadNote } = await import('../useMcpServer');
    const result = await handleReadNote(request || {});
    return { result };
}

/**
 * Dev-only: invoke the MCP `create_note` tool handler directly.
 *
 * Exercises the MCP validation → execute path without registering a client.
 */
export async function handleTestMcpCreateNoteHttpRequest(request: any) {
    const { handleCreateNote } = await import('../useMcpServer');
    const result = await handleCreateNote(request || {});
    return { result };
}

/**
 * Dev-only: snapshot of MuPDFWorkerClient dispatch / spawn / proactive
 * recycle counters, observed WASM heap size, and the worker-side document
 * cache.
 *
 * Lets manual-test runners (`docs-zotero/manual-tests-fused-worker-ops.md`)
 * verify "exactly one extract dispatch", "no extra spawns", etc.
 * without log grepping. POST `{ reset: true }` to zero counters first.
 *
 * `cacheStats` is `null` when no worker has spawned yet — the call must
 * never spawn one or pollute `dispatchCounts`, so the doc-cache fields stay
 * absent until a real op has run.
 */
export async function handleTestWorkerStatsHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../../src/beaver-extract/MuPDFWorkerClient'
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
export async function handleTestWorkerMarkStaleHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../../src/beaver-extract/MuPDFWorkerClient'
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
export async function handleTestWorkerCacheClearHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../../src/beaver-extract/MuPDFWorkerClient'
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
export async function handleTestFileStatusHttpRequest(request: any) {
    const { getAttachmentFileStatus } = await import(
        '../../../src/services/agentDataProvider/utils'
    );
    const { library_id, zotero_key, is_primary } = request || {};
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
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

export async function handleTestResolveItemHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { item_id: null, item_type: null };

    // Surface the PDF attachment the production resolver would extract for
    // this item (direct attachment, or the single child PDF of a regular
    // item). Lets tests assert parent → child resolution without exposing
    // extraction internals. Reuses the real resolver code path.
    const { resolveToPdfAttachment } = await import(
        '../../../src/services/documentExtraction/attachmentResolution'
    );
    const resolved = await resolveToPdfAttachment(
        item,
        `${library_id}-${zotero_key}`,
    );

    return {
        item_id: item.id,
        item_type: item.itemType,
        is_attachment: item.isAttachment(),
        parent_id: item.parentID || null,
        attachment_content_type: item.isAttachment() ? item.attachmentContentType : null,
        resolved_pdf_key: resolved.resolved ? resolved.key : null,
    };
}

export async function handleTestResolveReadableHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { item_id: null, item_type: null };
    await item.loadAllData();

    // Exercises the production readable-attachment resolver used by the
    // document-extraction core (`resolveToReadableAttachment`). Unlike the
    // document endpoint, this returns the resolver result verbatim — including
    // the chosen attachment key and content kind for non-PDF kinds that the
    // extractor rejects — so resolution behavior can be asserted without
    // triggering extraction.
    const { resolveToReadableAttachment } = await import(
        '../../../src/services/documentExtraction/attachmentResolution'
    );
    const resolved = await resolveToReadableAttachment(
        item,
        `${library_id}-${zotero_key}`,
    );

    return {
        item_id: item.id,
        item_type: item.itemType,
        is_attachment: item.isAttachment(),
        is_regular_item: item.isRegularItem(),
        resolved: resolved.resolved,
        resolved_key: resolved.resolved ? resolved.key : null,
        content_kind: resolved.resolved ? resolved.contentKind : null,
        content_type: resolved.resolved ? resolved.contentType : null,
        error_code: resolved.resolved ? null : resolved.error_code,
        error: resolved.resolved ? null : resolved.error,
    };
}

/**
 * Dev-only: run the production `getBestEpubAttachmentAsync` helper for an item.
 *
 * Exposes the EPUB-attachment resolver used by the EPUB citation-navigation
 * path so tests can assert which attachment it selects (an EPUB attachment
 * passed directly, the EPUB child of a regular item, or null when none exists)
 * without driving the reader UI.
 */
export async function handleTestBestEpubAttachmentHttpRequest(request: any) {
    const { library_id, zotero_key } = request || {};
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { item_id: null, item_type: null };
    await item.loadAllData();

    const { getBestEpubAttachmentAsync } = await import(
        '../../../src/utils/zoteroItemHelpers'
    );
    const attachment = await getBestEpubAttachmentAsync(item);

    return {
        item_id: item.id,
        item_type: item.itemType,
        is_attachment: item.isAttachment(),
        is_regular_item: item.isRegularItem(),
        resolved: !!attachment,
        resolved_key: attachment ? `${attachment.libraryID}-${attachment.key}` : null,
        content_type: attachment?.isAttachment?.() ? attachment.attachmentContentType : null,
    };
}

/**
 * Build `ItemValidationOptions` from a dev-endpoint request body. The capability
 * flags (`supports_vision`, `can_handle_ocr_locally`) and `searchable_library_ids`
 * are normally supplied by the running app; exposing them lets tests drive the
 * capability-dependent gating (images, OCR, excluded libraries) directly.
 */
function validationOptionsFromRequest(request: any): {
    supportsVision?: boolean;
    canHandleOCRLocally?: boolean;
    searchableLibraryIds?: number[];
} {
    const options: {
        supportsVision?: boolean;
        canHandleOCRLocally?: boolean;
        searchableLibraryIds?: number[];
    } = {};
    if (typeof request?.supports_vision === 'boolean') {
        options.supportsVision = request.supports_vision;
    }
    if (typeof request?.can_handle_ocr_locally === 'boolean') {
        options.canHandleOCRLocally = request.can_handle_ocr_locally;
    }
    if (Array.isArray(request?.searchable_library_ids)) {
        options.searchableLibraryIds = request.searchable_library_ids
            .map((id: any) => Number(id))
            .filter((id: number) => Number.isFinite(id));
    }
    return options;
}

/**
 * Dev-only: run `itemValidationManager.validateItem` for an item.
 *
 * Exposes the production validation pipeline so
 * tests can assert which attachment kinds Beaver admits as sources — including
 * the document-cache-backed EPUB checks — without driving the UI. Optional
 * `supports_vision`, `can_handle_ocr_locally`, and `searchable_library_ids`
 * fields drive the capability-dependent gating.
 */
export async function handleTestValidateItemHttpRequest(request: any) {
    const { library_id, zotero_key } = request || {};
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: false, error: 'not_found' };
    await item.loadAllData();

    const { itemValidationManager } = await import(
        '../../../src/services/itemValidationManager'
    );

    const result = await itemValidationManager.validateItem(item, validationOptionsFromRequest(request));
    return {
        ok: true,
        state: result.state,
        severity: result.severity ?? null,
        reason: result.reason ?? null,
        status_code: result.statusCode ?? null,
        content_kind: result.contentKind ?? null,
        page_count: result.pageCount ?? null,
    };
}

/**
 * Dev-only: run `itemValidationManager.validateRegularItem` for a regular item.
 *
 * Exposes the batch validation pipeline (best-attachment ranking +
 * per-attachment `AttachmentInfo`) so tests can assert which child attachment
 * Beaver promotes as primary and how each child validates, without driving the UI.
 */
export async function handleTestValidateRegularItemHttpRequest(request: any) {
    const { library_id, zotero_key } = request || {};
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: false, error: 'not_found' };
    await item.loadAllData();
    if (!item.isRegularItem()) {
        return { ok: false, error: 'not_a_regular_item' };
    }

    const { itemValidationManager } = await import(
        '../../../src/services/itemValidationManager'
    );

    const result = await itemValidationManager.validateRegularItem(item, validationOptionsFromRequest(request));
    const attachments = Array.from(result.attachmentResults.entries()).map(([attachmentId, r]) => ({
        attachment_id: attachmentId,
        state: r.state,
        severity: r.severity ?? null,
        reason: r.reason ?? null,
        status_code: r.statusCode ?? null,
        content_kind: r.contentKind ?? null,
        page_count: r.pageCount ?? null,
        is_primary: r.attachmentInfo?.is_primary ?? false,
        filename: r.attachmentInfo?.filename ?? null,
    }));
    return {
        ok: true,
        state: result.state,
        severity: result.severity ?? null,
        reason: result.reason ?? null,
        attachments,
    };
}

/**
 * Dev-only: attach an external file from a local path (registry + managed
 * copy), mirroring the drag-and-drop / file-picker attach flow so live tests
 * can exercise the external-file read path end to end.
 */
export async function handleTestExternalFileAttachHttpRequest(request: any) {
    const { path, supports_vision, can_handle_ocr_locally } = request;
    if (!path || typeof path !== 'string') {
        return { ok: false, error: 'Provide a local file path' };
    }
    const { attachExternalFile } = await import('../../../src/services/externalFiles');
    const options: { supportsVision?: boolean; canHandleOCRLocally?: boolean } = {};
    if (typeof supports_vision === 'boolean') options.supportsVision = supports_vision;
    if (typeof can_handle_ocr_locally === 'boolean') options.canHandleOCRLocally = can_handle_ocr_locally;
    const result = await attachExternalFile(path, options);
    if (result.status !== 'attached') {
        return { ok: false, reason: result.reason, error: result.message };
    }
    return { ok: true, record: result.record };
}

/**
 * Dev-only: delete an external file registry row and its managed copy.
 */
export async function handleTestExternalFileDeleteHttpRequest(request: any) {
    const { ext_key, delete_copy } = request;
    const db = Zotero.Beaver?.db;
    if (!db) return { ok: false, error: 'db not available' };
    if (!ext_key) return { ok: false, error: 'Provide ext_key' };
    const record = await db.getExternalFileByKey(ext_key);
    if (record && delete_copy !== false) {
        await IOUtils.remove(record.storedPath).catch(() => undefined);
    }
    await db.deleteExternalFile(ext_key);
    return { ok: true, existed: !!record };
}

/**
 * Dev-only: drive `handleZoteroDocumentRequest` through its production
 * WebSocket response mode (`responseMode: 'websocket'`).
 *
 * The public `/beaver/attachment/document` endpoint uses the default object
 * mode, so it never exercises the serialized PDF path: the worker
 * `extractSerialized` op, the `DocumentCache` byte-level (`getSerializedResult`
 * / `putSerializedResult`) APIs, the `"content_kind":"pdf"` wire splice, the
 * `PreparedJsonMessage` envelope, or the `guardSerializedPayloadSize` check.
 *
 * This handler invokes the real handler in websocket mode and materializes the
 * result through the exact `materializePreparedJsonMessage` path the agent
 * connection uses on send. It returns the parsed wire JSON plus its byte
 * length so tests can assert the spliced output and payload-size accounting
 * without a WebSocket client. PDF successes come back as a `PreparedJsonMessage`
 * (`prepared: true`); EPUB/text successes and every error path come back as a
 * plain object (`prepared: false`).
 *
 * Accepts the same fields as the WebSocket request, including `max_payload_bytes`
 * (which the object-mode HTTP endpoint does not forward).
 */
export async function handleTestDocumentSerializedHttpRequest(request: any) {
    const { handleZoteroDocumentRequest } = await import(
        '../../../src/services/agentDataProvider/handleZoteroDocumentRequest'
    );
    const {
        isPreparedJsonMessage,
        materializePreparedJsonMessage,
        preparedJsonEnvelope,
    } = await import('../../../src/services/preparedJsonMessage');

    const wsRequest = {
        event: 'zotero_document_request' as const,
        request_id: `test-doc-serialized-${request?.attachment?.zotero_key ?? request?.external_file_key ?? 'x'}`,
        attachment: request?.attachment ?? undefined,
        external_file_key: request?.external_file_key ?? undefined,
        mode: request?.mode ?? 'structured',
        max_pages: request?.max_pages ?? undefined,
        max_file_size_mb: request?.max_file_size_mb ?? undefined,
        max_payload_bytes: request?.max_payload_bytes ?? undefined,
        timeout_seconds: request?.timeout_seconds ?? undefined,
    };

    const response = await handleZoteroDocumentRequest(wsRequest, {
        responseMode: 'websocket',
    });

    if (isPreparedJsonMessage(response)) {
        const wireJson = materializePreparedJsonMessage(response);
        return {
            prepared: true,
            wire_bytes: new TextEncoder().encode(wireJson).byteLength,
            envelope: preparedJsonEnvelope(response),
            wire: JSON.parse(wireJson),
        };
    }

    return {
        prepared: false,
        response,
    };
}

/**
 * Dev-only: invoke `handleZoteroViewImagesRequest` for an external file key.
 *
 * Exposes the external-file branch of the unified view-images handler over
 * HTTP so live tests can verify the full registry lookup → file read → render
 * pipeline without a WebSocket client. Accepts the same optional fields as
 * the WebSocket request (`start_page`, `end_page`, `dpi`, `format`, etc.).
 */
export async function handleTestExternalFileViewImagesHttpRequest(request: any) {
    const { ext_key, start_page, end_page, dpi, max_width, max_height, format, jpeg_quality, timeout_seconds } = request || {};
    if (!ext_key) return { ok: false, error: 'Provide ext_key' };

    const { handleZoteroViewImagesRequest } = await import(
        '../../../src/services/agentDataProvider/handleZoteroViewImagesRequest'
    );
    const response = await handleZoteroViewImagesRequest({
        event: 'zotero_view_images_request',
        request_id: `test-view-${ext_key}`,
        external_file_key: ext_key,
        start_page: start_page ?? undefined,
        end_page: end_page ?? undefined,
        dpi: dpi ?? undefined,
        max_width: max_width ?? undefined,
        max_height: max_height ?? undefined,
        format: format ?? undefined,
        jpeg_quality: jpeg_quality ?? undefined,
        timeout_seconds: timeout_seconds ?? undefined,
    });
    return response;
}
