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

export interface CacheMetadataRecord {
    item_id: number;
    library_id: number;
    zotero_key: string;
    file_path: string;
    file_mtime_ms: number;
    file_size_bytes: number;
    content_type: string;
    page_count: number | null;
    page_labels: string | null;
    has_text_layer: boolean | number;
    needs_ocr: boolean | number;
    is_encrypted: boolean | number;
    is_invalid: boolean | number;
    extraction_version: string;
    cached_at: string;
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

export type SupportedPrefKey = 'mupdf.useWorker';

export async function setPref(
    key: SupportedPrefKey,
    value: boolean,
): Promise<void> {
    const res = await post<{ ok?: boolean; error?: string }>(
        '/beaver/test/set-pref',
        { key, value },
    );
    if (res.error) throw new Error(res.error);
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

export interface PdfPageLabelsResponse {
    ok: boolean;
    count?: number;
    labels?: Record<number, string>;
    error?: { name: string; code?: string; message: string };
}

export interface PdfExtractRawResponse {
    ok: boolean;
    result?: {
        pageCount: number;
        pages: Array<{
            pageIndex: number;
            pageNumber: number;
            width: number;
            height: number;
            label?: string;
            blocks: unknown[];
        }>;
    };
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

export interface PdfSearchResponse {
    ok: boolean;
    pages?: Array<{
        pageIndex: number;
        label?: string;
        matchCount: number;
        hits: Array<{
            quads: number[][];
            bbox: { x: number; y: number; w: number; h: number };
        }>;
        width: number;
        height: number;
    }>;
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

export async function pdfExtractRaw(
    attachment: AttachmentFixture,
    body: { page_indices?: number[] } = {},
): Promise<PdfExtractRawResponse> {
    return post<PdfExtractRawResponse>('/beaver/test/pdf-extract-raw', {
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

export async function pdfSearch(
    attachment: AttachmentFixture,
    body: {
        query: string;
        page_indices?: number[];
        max_hits_per_page?: number;
    },
): Promise<PdfSearchResponse> {
    return post<PdfSearchResponse>('/beaver/test/pdf-search', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
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

export async function pdfExtractByLines(
    attachment: AttachmentFixture,
    body: { settings?: Record<string, unknown> } = {},
): Promise<PdfExtractResponse> {
    return post<PdfExtractResponse>('/beaver/test/pdf-extract-by-lines', {
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
 * Single-page render — exercises the dedicated `renderPageToImage` op.
 * The plural endpoint silently filters invalid indices, so this is the
 * only way to test PAGE_OUT_OF_RANGE parity.
 */
export interface PdfRenderPageResponse {
    ok: boolean;
    result?: PdfRenderPagePayload;
    error?: PdfErrorEnvelope;
}

export async function pdfRenderPage(
    attachment: AttachmentFixture,
    body: { page_index: number; options?: PdfPageImageOptions },
): Promise<PdfRenderPageResponse> {
    return post<PdfRenderPageResponse>('/beaver/test/pdf-render-page', {
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

export async function clearMemoryCache(): Promise<void> {
    const res = await post<{ ok?: boolean; error?: string }>(
        '/beaver/test/cache-clear-memory',
    );
    if (res.error) throw new Error(res.error);
}

export async function deleteContentCache(
    libraryId: number,
    key: string,
): Promise<void> {
    const res = await post<{ ok?: boolean; error?: string }>(
        '/beaver/test/cache-delete-content',
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

// ---------------------------------------------------------------------------
// Sentence bbox feasibility probe
// ---------------------------------------------------------------------------

export interface SentenceBBoxReportSentence {
    index: number;
    text: string;
    numBBoxes: number;
    unionBBox: { x: number; y: number; w: number; h: number };
}

export interface SentenceBBoxReport {
    pageIndex: number;
    totalChars: number;
    totalLines: number;
    totalSentences: number;
    multiFragmentSentences: number;
    pageTextLength: number;
    invariantHolds: boolean;
    allBBoxesInPage: boolean;
    sentences: SentenceBBoxReportSentence[];
}

export interface ParagraphSentenceReportParagraph {
    index: number;
    itemType: 'paragraph' | 'header';
    numLines: number;
    paragraphText: string;
    numSentences: number;
    sentences: Array<{
        text: string;
        numBBoxes: number;
        unionBBox: { x: number; y: number; w: number; h: number };
    }>;
}

export interface ParagraphSentenceBBoxReport {
    pageIndex: number;
    totalParagraphs: number;
    totalHeaders: number;
    mappedParagraphs: number;
    unmappedParagraphs: number;
    totalSentences: number;
    multiFragmentSentences: number;
    invariantHolds: boolean;
    allBBoxesInPage: boolean;
    paragraphs: ParagraphSentenceReportParagraph[];
}

export interface SentenceBBoxResponse {
    ok?: boolean;
    error?: string;
    page_count?: number;
    page_width?: number;
    page_height?: number;
    num_blocks?: number;
    timings_ms?: {
        walk: number;
        page_mapper: number;
        paragraph_mapper: number;
    };
    report?: SentenceBBoxReport;
    paragraph_report?: ParagraphSentenceBBoxReport;
}

export async function getSentenceBBoxReport(
    libraryId: number,
    key: string,
    pageIndex = 0,
    mode: 'page' | 'paragraph' | 'both' = 'both',
): Promise<SentenceBBoxResponse> {
    return post<SentenceBBoxResponse>('/beaver/test/sentence-bboxes', {
        library_id: libraryId,
        zotero_key: key,
        page_index: pageIndex,
        mode,
    });
}
