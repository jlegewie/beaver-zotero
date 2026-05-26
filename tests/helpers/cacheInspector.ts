/**
 * Cache state inspection and cleanup helpers.
 *
 * Talks to the /beaver/test/* endpoints registered in useHttpEndpoints.ts.
 * Shared by live and integration tests.
 */

import { getBaseUrl, type AttachmentFixture } from './fixtures';

async function post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${getBaseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Cache inspector: HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
}

export interface PingResponse {
    ok: boolean;
    cache_available: boolean;
    db_available: boolean;
}

export interface CachedPageGeometry {
    viewBox: [number, number, number, number];
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
}

export interface CacheMetadataRecord {
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    filePath: string;
    sourceSizeBytes: number;
    contentType: string;
    pageCount: number | null;
    pageLabels: Record<string, string> | null;
    pages: (CachedPageGeometry | null)[] | null;
    errorCode: 'encrypted' | 'invalid_pdf' | 'no_text_layer' | null;
}

export interface ResolveItemResponse {
    item_id: number | null;
    item_type: string | null;
    is_attachment?: boolean;
    parent_id?: number | null;
    attachment_content_type?: string | null;
    error?: string;
}

export async function ping(): Promise<PingResponse> {
    return post('/beaver/test/ping');
}

// ---------------------------------------------------------------------------
// MuPDF worker plumbing helpers (PR #1)
// ---------------------------------------------------------------------------

export interface PdfPageCountResponse {
    ok: boolean;
    count?: number;
    error?: {
        name: string;
        code?: string;
        message: string;
    };
}

export async function pdfPageCount(
    attachment: AttachmentFixture,
): Promise<PdfPageCountResponse> {
    return post<PdfPageCountResponse>('/beaver/test/pdf-page-count', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
    });
}

export async function pdfPageCountFromBytes(
    bytes: Uint8Array,
): Promise<PdfPageCountResponse> {
    const base64 = bufferToBase64(bytes);
    return post<PdfPageCountResponse>('/beaver/test/pdf-page-count', {
        raw_bytes_base64: base64,
    });
}

function bufferToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
        binary += String.fromCharCode(...slice);
    }
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binary = (globalThis as any).atob(base64) as string;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ---------------------------------------------------------------------------
// MuPDF worker plumbing helpers (PR #2)
// ---------------------------------------------------------------------------

export interface PdfPageImageOptions {
    scale?: number;
    dpi?: number;
    alpha?: boolean;
    showExtras?: boolean;
    format?: 'png' | 'jpeg';
    jpegQuality?: number;
}

export interface PdfRenderPagePayload {
    pageIndex: number;
    format: 'png' | 'jpeg';
    width: number;
    height: number;
    scale: number;
    dpi: number;
    data_base64: string;
    data_byte_length: number;
}

export interface PdfRenderPagesResponse {
    ok: boolean;
    pages?: PdfRenderPagePayload[];
    error?: { name: string; code?: string; message: string };
}

export interface PdfRenderPagesWithMetaResponse {
    ok: boolean;
    pageCount?: number;
    pageLabels?: Record<number, string>;
    pages?: PdfRenderPagePayload[];
    error?: { name: string; code?: string; message: string; pageCount?: number };
}

export interface PdfPageLabelsResponse {
    ok: boolean;
    pageCount?: number;
    pageLabels?: Record<number, string>;
    format?: string;
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
    error?: { name: string; code?: string; message: string };
}

export interface PdfExtractRawDetailedResponse {
    ok: boolean;
    result?: {
        pageIndex: number;
        pageNumber: number;
        width: number;
        height: number;
        label?: string;
        blocks: unknown[];
    };
    error?: { name: string; code?: string; message: string };
}

export async function pdfPageLabels(
    attachment: AttachmentFixture,
): Promise<PdfPageLabelsResponse> {
    return post<PdfPageLabelsResponse>('/beaver/test/pdf-page-labels', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
    });
}

export async function pdfRenderPages(
    attachment: AttachmentFixture,
    body: { page_indices?: number[]; options?: PdfPageImageOptions } = {},
): Promise<PdfRenderPagesResponse> {
    return post<PdfRenderPagesResponse>('/beaver/test/pdf-render-pages', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

export async function pdfRenderPagesFromBytes(
    bytes: Uint8Array,
    body: { page_indices?: number[]; options?: PdfPageImageOptions } = {},
): Promise<PdfRenderPagesResponse> {
    return post<PdfRenderPagesResponse>('/beaver/test/pdf-render-pages', {
        raw_bytes_base64: bufferToBase64(bytes),
        ...body,
    });
}

export async function pdfRenderPagesWithMeta(
    attachment: AttachmentFixture,
    body: {
        page_indices?: number[];
        page_range?: { startIndex: number; endIndex?: number; maxPages?: number };
        options?: PdfPageImageOptions;
    } = {},
): Promise<PdfRenderPagesWithMetaResponse> {
    return post<PdfRenderPagesWithMetaResponse>('/beaver/test/pdf-render-pages-with-meta', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

export async function pdfExtractRawDetailed(
    attachment: AttachmentFixture,
    body: { page_index: number; include_images?: boolean },
): Promise<PdfExtractRawDetailedResponse> {
    return post<PdfExtractRawDetailedResponse>(
        '/beaver/test/pdf-extract-raw-detailed',
        {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
            ...body,
        },
    );
}

export interface PdfErrorEnvelope {
    name: string;
    code?: string;
    message: string;
    payload?: {
        ocrAnalysis?: unknown;
        pageLabels?: Record<number, string>;
        pageCount?: number;
    };
}

export interface PdfExtractResponse {
    ok: boolean;
    result?: any;
    error?: PdfErrorEnvelope;
}

export async function pdfExtract(
    attachment: AttachmentFixture,
    body: { settings?: Record<string, unknown> } = {},
): Promise<PdfExtractResponse> {
    return post<PdfExtractResponse>('/beaver/test/pdf-extract', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

export async function pdfExtractParagraph(
    attachment: AttachmentFixture,
    body: { settings?: Record<string, unknown> } = {},
): Promise<PdfExtractResponse> {
    return post<PdfExtractResponse>('/beaver/test/pdf-extract-paragraph', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

export async function pdfHasTextLayer(
    attachment: AttachmentFixture,
): Promise<{ ok: boolean; hasTextLayer?: boolean; error?: PdfErrorEnvelope }> {
    return post('/beaver/test/pdf-has-text-layer', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
    });
}

export async function pdfAnalyzeOcr(
    attachment: AttachmentFixture,
    body: { options?: Record<string, unknown> } = {},
): Promise<PdfExtractResponse> {
    return post<PdfExtractResponse>('/beaver/test/pdf-analyze-ocr', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

export async function pdfSearchScored(
    attachment: AttachmentFixture,
    body: { query: string; options?: Record<string, unknown> },
): Promise<PdfExtractResponse> {
    return post<PdfExtractResponse>('/beaver/test/pdf-search-scored', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

export async function pdfSentenceBBoxes(
    attachment: AttachmentFixture,
    body: { page_index: number; options?: Record<string, unknown> },
): Promise<PdfExtractResponse> {
    return post<PdfExtractResponse>('/beaver/test/pdf-sentence-bboxes', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

/**
 * `/beaver/test/pdf-render-overlay` — renders a page and paints bbox
 * overlays for the requested level. Sentence-level rects are produced by
 * the same orchestration as `/beaver/test/pdf-sentence-bboxes`; the
 * `pdfRenderOverlayParity.live.test.ts` test asserts the bboxes match
 * exactly.
 */
export interface PdfRenderOverlayRect {
    rect: { l: number; t: number; r: number; b: number; origin: string };
    color: string;
    label?: string;
    group: number;
    degraded?: boolean;
    marginPosition?: 'top' | 'bottom' | 'left' | 'right' | null;
}

export interface PdfRenderOverlayResponse {
    ok: boolean;
    level?: string;
    page_index?: number;
    page_width?: number;
    page_height?: number;
    image_width?: number;
    image_height?: number;
    dpi?: number;
    group_count?: number;
    stats?: Record<string, number | string | undefined>;
    rects?: PdfRenderOverlayRect[];
    image_base64?: string;
    image_byte_length?: number;
    error?: PdfErrorEnvelope;
}

export async function pdfRenderOverlay(
    attachment: AttachmentFixture,
    body: {
        page_index: number;
        level:
            | 'columns'
            | 'lines'
            | 'items'
            | 'sentences'
            | 'margins';
        dpi?: number;
        language?: string;
        analysis_page_window?: number;
    },
): Promise<PdfRenderOverlayResponse> {
    return post<PdfRenderOverlayResponse>('/beaver/test/pdf-render-overlay', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}


/** Decode a base64 image payload from `pdfRenderPages` for byte-level checks. */
export function decodeRenderPayload(payload: PdfRenderPagePayload): Uint8Array {
    return base64ToUint8Array(payload.data_base64);
}

export async function getCacheMetadata(
    libraryId: number,
    key: string,
): Promise<CacheMetadataRecord | null> {
    const res = await post<{ record: CacheMetadataRecord | null; error?: string }>(
        '/beaver/test/cache-metadata',
        { library_id: libraryId, zotero_key: key },
    );
    if (res.error) throw new Error(res.error);
    return res.record;
}

export async function invalidateCache(
    libraryId: number,
    key: string,
): Promise<void> {
    const res = await post<{ ok?: boolean; error?: string }>(
        '/beaver/test/cache-invalidate',
        { library_id: libraryId, zotero_key: key },
    );
    if (res.error) throw new Error(res.error);
}

export async function resolveItem(
    libraryId: number,
    key: string,
): Promise<ResolveItemResponse> {
    return post('/beaver/test/resolve-item', {
        library_id: libraryId,
        zotero_key: key,
    });
}

/** Completely wipe the document cache (metadata rows, payload rows, files). */
export async function clearAllCache(): Promise<{
    metadataRows: number;
    payloadRows: number;
}> {
    const res = await post<{
        ok?: boolean;
        metadataRows?: number;
        payloadRows?: number;
        error?: string;
    }>('/beaver/test/cache-clear-all', {});
    if (res.error) throw new Error(res.error);
    return { metadataRows: res.metadataRows ?? 0, payloadRows: res.payloadRows ?? 0 };
}

export interface FileStatus {
    is_primary: boolean;
    mime_type: string;
    page_count: number | null;
    status: 'available' | 'unavailable';
    status_code?: string;
}

/** Trigger `getAttachmentFileStatus` for an attachment (writes the doc cache). */
export async function triggerFileStatus(
    libraryId: number,
    key: string,
    isPrimary = true,
): Promise<FileStatus> {
    const res = await post<{ ok: boolean; status?: FileStatus; error?: string }>(
        '/beaver/test/file-status',
        { library_id: libraryId, zotero_key: key, is_primary: isPrimary },
    );
    if (!res.ok || !res.status) throw new Error(res.error ?? 'file-status failed');
    return res.status;
}

/**
 * MCP error object shape — `read_attachment` returns this on failure.
 */
export interface McpToolError {
    content: Array<{ type: string; text: string }>;
    isError: true;
}

export type ReadAttachmentResult = string | McpToolError;

/** Returns true when a `read_attachment` result is an MCP error object. */
export function isMcpToolError(result: ReadAttachmentResult): result is McpToolError {
    return typeof result === 'object' && result !== null && (result as McpToolError).isError === true;
}

/**
 * Invoke the MCP `read_attachment` tool handler via the dev endpoint.
 * `attachmentId` is the `<libraryId>-<zoteroKey>` form the tool expects.
 */
export async function readAttachment(body: {
    attachment_id: string;
    start_page?: number;
    end_page?: number;
}): Promise<ReadAttachmentResult> {
    const res = await post<{ result: ReadAttachmentResult; error?: string }>(
        '/beaver/test/read-attachment',
        body,
    );
    if (res.error) throw new Error(res.error);
    return res.result;
}

// ---------------------------------------------------------------------------
// MuPDF worker singleton stats / cache lifecycle (dev-only)
// ---------------------------------------------------------------------------

export interface WorkerCacheStats {
    entries: number;
    totalBytes: number;
    hits: number;
    misses: number;
    evictions: number;
    discards: number;
    ttlMs: number;
    maxEntries: number;
    maxBytes: number;
    cryptoUsable: boolean | null;
}

export interface WorkerStatsSnapshot {
    hasWorker: boolean;
    disposed: boolean;
    spawnCount: number;
    retryCount: number;
    pendingCount: number;
    nextId: number;
    dispatchCounts: Record<string, number>;
    lastSpawnTime: number | null;
    idleTimerArmed: boolean;
}

export interface WorkerStatsResponse {
    ok: boolean;
    stats: WorkerStatsSnapshot;
    cacheStats: WorkerCacheStats | null;
}

export async function workerStats(
    body: { reset?: boolean } = {},
): Promise<WorkerStatsResponse> {
    return post<WorkerStatsResponse>('/beaver/test/worker-stats', body);
}

export async function workerCacheClear(
    body: { resetCounters?: boolean } = {},
): Promise<{ ok: boolean; cacheStats: WorkerCacheStats | null }> {
    return post('/beaver/test/worker-cache-clear', body);
}

export async function workerMarkStale(
    body: { reason?: string } = {},
): Promise<{ ok: boolean; before: WorkerStatsSnapshot; after: WorkerStatsSnapshot }> {
    return post('/beaver/test/worker-mark-stale', body);
}

// ---------------------------------------------------------------------------
// Background extraction queue (dev-only)
//
// Talks to the `/beaver/test/background-*` endpoints registered in
// `useHttpEndpoints.ts` from `react/hooks/httpHandlers/testBackgroundHandlers.ts`.
// ---------------------------------------------------------------------------

export type BackgroundJobType = 'hot_timeout_retry';

export interface BackgroundJobPayload {
    maxPages: number | null;
    maxFileSizeMB: number;
    timeoutSeconds: number;
}

export interface BackgroundJobRecord {
    id: number;
    jobType: BackgroundJobType;
    libraryId: number;
    itemId: number | null;
    zoteroKey: string;
    mode: 'structured' | 'markdown';
    priority: number;
    payload: BackgroundJobPayload | null;
    enqueuedAt: number;
    availableAt: number;
    attemptCount: number;
    lastError: string | null;
}

export interface BackgroundQueueStats {
    pending: number;
    available: number;
    deferred: number;
    dead: number;
    byJobType: Record<string, number>;
}

export interface BackgroundEnqueueRequest {
    library_id: number;
    zotero_key: string;
    mode: 'structured' | 'markdown';
    job_type: BackgroundJobType;
    priority?: number;
    payload?: BackgroundJobPayload | null;
    item_id?: number | null;
    /**
     * Wake the background loop after inserting. Defaults to `false` so
     * tests can inspect deterministic queue state via peek/stats without
     * the auto-tick claiming the row. Tests that exercise the auto-drain
     * path pass `true` and pair it with `waitForQueueDrain()`.
     */
    notify?: boolean;
}

export interface BackgroundEnqueueResponse {
    ok: boolean;
    enqueued?: boolean;
    id?: number;
    error?: string;
}

export interface BackgroundStatsResponse {
    ok: boolean;
    queue?: BackgroundQueueStats;
    workers?: {
        hot: WorkerStatsSnapshot | null;
        background: WorkerStatsSnapshot | null;
    };
    error?: string;
}

export interface BackgroundPeekResponse {
    ok: boolean;
    jobs?: BackgroundJobRecord[];
    error?: string;
}

export type BackgroundProcessOnceReason =
    | 'stopped'
    | 'shutting_down'
    | 'no_window'
    | 'hot_busy'
    | 'empty'
    | 'job_done';

export interface BackgroundProcessOnceResponse {
    ok: boolean;
    processed?: boolean;
    reason?: BackgroundProcessOnceReason;
    error?: string;
}

export async function backgroundEnqueue(
    body: BackgroundEnqueueRequest,
): Promise<BackgroundEnqueueResponse> {
    return post<BackgroundEnqueueResponse>(
        '/beaver/test/background-enqueue',
        body,
    );
}

export async function backgroundStats(): Promise<BackgroundStatsResponse> {
    return post<BackgroundStatsResponse>('/beaver/test/background-stats', {});
}

export async function backgroundPeek(
    body: { limit?: number } = {},
): Promise<BackgroundPeekResponse> {
    return post<BackgroundPeekResponse>('/beaver/test/background-peek', body);
}

export async function backgroundProcessOnce(): Promise<BackgroundProcessOnceResponse> {
    return post<BackgroundProcessOnceResponse>(
        '/beaver/test/background-process-once',
        {},
    );
}

export async function backgroundClear(): Promise<{ ok: boolean; error?: string }> {
    return post('/beaver/test/background-clear', {});
}

/**
 * Poll `/beaver/test/background-stats` until `queue.pending` is zero (or
 * the timeout expires). The producer-side `notify()` in
 * `handleTestBackgroundEnqueueHttpRequest` schedules a tick at 0ms that
 * races the explicit `processOnce` HTTP call. For fast-completing jobs
 * (missing item, non-PDF) the row may be drained by the background loop
 * before `processOnce` claims it, so tests cannot rely on a deterministic
 * winner. This helper waits for the queue to actually drain and returns
 * the final stats snapshot.
 */
export async function waitForQueueDrain(
    opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BackgroundQueueStats> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 100;
    const start = Date.now();
    let lastStats: BackgroundQueueStats | null = null;
    while (Date.now() - start < timeoutMs) {
        const stats = await backgroundStats();
        if (stats.queue) {
            lastStats = stats.queue;
            if (stats.queue.pending === 0) return stats.queue;
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
        `background queue did not drain within ${timeoutMs}ms; last stats: ${JSON.stringify(
            lastStats,
        )}`,
    );
}
