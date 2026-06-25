/**
 * HTTP client wrapper for Beaver endpoints on Zotero's local server.
 *
 * Shared by live and integration tests.
 */

import { getBaseUrl, type AttachmentFixture } from './fixtures';

interface RequestOptions {
    timeout?: number;
}

export async function post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = opts?.timeout ?? 25000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${getBaseUrl()}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return (await res.json()) as T;
    } finally {
        clearTimeout(timer);
    }
}

// -------------------------------------------------------------------------
// Attachment handlers
// -------------------------------------------------------------------------

export interface PageImagesResponse {
    attachment: { library_id: number; zotero_key: string };
    pages: Array<{
        page_number: number;
        image_data: string;
        format: string;
        width: number;
        height: number;
    }>;
    total_pages: number | null;
    error?: string | null;
    error_code?: string | null;
}

export interface SearchResponse {
    attachment: { library_id: number; zotero_key: string };
    query: string;
    total_matches: number;
    pages_with_matches: number;
    total_pages: number | null;
    pages: Array<{
        page_index: number;
        label?: string;
        match_count: number;
        score: number;
        text_length: number;
        hits: Array<{
            bbox: { x: number; y: number; w: number; h: number };
            role: string;
            weight: number;
            matched_text?: string;
        }>;
    }>;
    error?: string | null;
    error_code?: string | null;
}

export function fetchPageImages(
    attachment: AttachmentFixture,
    extra?: {
        pages?: number[];
        scale?: number;
        dpi?: number;
        format?: 'png' | 'jpeg';
        jpeg_quality?: number;
        skip_local_limits?: boolean;
    },
    opts?: RequestOptions,
): Promise<PageImagesResponse> {
    return post('/beaver/attachment/page-images', {
        attachment: {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
        },
        ...extra,
    }, opts);
}

export function searchAttachment(
    attachment: AttachmentFixture,
    query: string,
    extra?: {
        max_hits_per_page?: number;
        skip_local_limits?: boolean;
    },
    opts?: RequestOptions,
): Promise<SearchResponse> {
    return post('/beaver/attachment/search', {
        attachment: {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
        },
        query,
        ...extra,
    }, opts);
}

// -------------------------------------------------------------------------
// Whole-document extraction handler (/beaver/attachment/document)
// -------------------------------------------------------------------------

/** A single extracted page — markdown mode carries `markdown`, structured `items`. */
export interface DocumentPage {
    index: number;
    label?: string;
    width: number;
    height: number;
    markdown?: string;
    items?: unknown[];
}

/** `BeaverExtractResult` as returned over HTTP (markdown or structured). */
export interface DocumentExtractResult {
    content_kind?: 'pdf' | 'epub' | 'text';
    mode: 'markdown' | 'structured';
    schemaVersion: string;
    document: {
        pageCount: number;
        pageLabels?: Record<string, string>;
        pages: DocumentPage[];
    };
}

export interface DocumentResponse {
    resolved_attachment?: { library_id: number; zotero_key: string } | null;
    external_file_key?: string | null;
    content_type?: string | null;
    content_kind?: 'pdf' | 'epub' | 'snapshot' | 'text' | null;
    result?: DocumentExtractResult | null;
    total_pages?: number | null;
    error?: string | null;
    error_code?: string | null;
}

/**
 * POST `/beaver/attachment/document` — whole-document extraction routed
 * through `DocumentCache`. `mode` defaults to `structured` server-side.
 */
export function fetchDocument(
    attachment: AttachmentFixture,
    extra?: {
        mode?: 'markdown' | 'structured';
        max_pages?: number | null;
        max_file_size_mb?: number | null;
        timeout_seconds?: number;
    },
    opts?: RequestOptions,
): Promise<DocumentResponse> {
    return post('/beaver/attachment/document', {
        attachment: {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
        },
        ...extra,
    }, opts);
}

/**
 * POST `/beaver/attachment/document` for a user-attached external file
 * (`external_file_key` instead of a Zotero attachment reference).
 */
export function fetchExternalFileDocument(
    extKey: string,
    extra?: {
        mode?: 'markdown' | 'structured';
        max_pages?: number | null;
        max_file_size_mb?: number | null;
        timeout_seconds?: number;
    },
    opts?: RequestOptions,
): Promise<DocumentResponse> {
    return post('/beaver/attachment/document', {
        external_file_key: extKey,
        ...extra,
    }, opts);
}

// -------------------------------------------------------------------------
// Serialized whole-document wire path (/beaver/test/document-serialized)
// -------------------------------------------------------------------------

/**
 * Result of `/beaver/test/document-serialized`. PDF successes arrive as a
 * `PreparedJsonMessage` (`prepared: true`) carrying the materialized wire JSON
 * (`wire`) and its byte length (`wire_bytes`); EPUB/text successes and all
 * error paths arrive as a plain object (`prepared: false`) under `response`.
 */
/** Frontend extraction timing breakdown attached to a document response. */
export interface DocumentTiming {
    resolve_ms?: number;
    extraction_wait_ms?: number;
    worker_extract_ms?: number;
    serialize_ms?: number;
    payload_bytes?: number;
    file_size_bytes?: number;
    file_size_mb?: number;
    page_count?: number;
    cache_hit?: number;
    cache_miss?: number;
    post_serialize_event_loop_lag_ms?: number;
    [key: string]: unknown;
}

export interface SerializedDocumentWireResponse {
    prepared: boolean;
    /** Byte length of the materialized wire JSON string (prepared only). */
    wire_bytes?: number;
    /** The small envelope object the raw `result` was spliced into. */
    envelope?: Record<string, any> & { timing?: DocumentTiming };
    /** Parsed wire message after PreparedJsonMessage materialization. */
    wire?: {
        type?: string;
        request_id?: string;
        content_kind?: string | null;
        content_type?: string | null;
        resolved_attachment?: { library_id: number; zotero_key: string } | null;
        external_file_key?: string | null;
        result?: DocumentExtractResult | null;
        timing?: DocumentTiming;
        [key: string]: unknown;
    };
    /** The plain response object for non-prepared (EPUB/text/error) outcomes. */
    response?: DocumentResponse & { type?: string; timing?: DocumentTiming };
}

/**
 * POST `/beaver/test/document-serialized` — drive `handleZoteroDocumentRequest`
 * in `responseMode: 'websocket'` and return the materialized wire output.
 */
export function fetchDocumentSerialized(
    attachment: AttachmentFixture,
    extra?: {
        mode?: 'markdown' | 'structured';
        max_pages?: number | null;
        max_file_size_mb?: number | null;
        max_payload_bytes?: number | null;
        timeout_seconds?: number;
    },
    opts?: RequestOptions,
): Promise<SerializedDocumentWireResponse> {
    return post('/beaver/test/document-serialized', {
        attachment: {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
        },
        ...extra,
    }, opts);
}

/** POST `/beaver/test/document-serialized` for a user-attached external file. */
export function fetchExternalFileDocumentSerialized(
    extKey: string,
    extra?: {
        mode?: 'markdown' | 'structured';
        max_pages?: number | null;
        max_file_size_mb?: number | null;
        max_payload_bytes?: number | null;
        timeout_seconds?: number;
    },
    opts?: RequestOptions,
): Promise<SerializedDocumentWireResponse> {
    return post('/beaver/test/document-serialized', {
        external_file_key: extKey,
        ...extra,
    }, opts);
}

/** POST `/beaver/test/external-file-attach` — dev-only registry seeding. */
export function attachExternalFileForTest(
    path: string,
    capabilities?: { supportsVision?: boolean; canHandleOCRLocally?: boolean },
    opts?: RequestOptions,
): Promise<{ ok: boolean; record?: { extKey: string; storedPath: string; contentKind: string; filename: string }; reason?: string; error?: string }> {
    return post('/beaver/test/external-file-attach', {
        path,
        supports_vision: capabilities?.supportsVision,
        can_handle_ocr_locally: capabilities?.canHandleOCRLocally,
    }, opts);
}

/** POST `/beaver/test/external-file-delete` — dev-only registry teardown. */
export function deleteExternalFileForTest(
    extKey: string,
    deleteCopy = true,
    opts?: RequestOptions,
): Promise<{ ok: boolean; existed?: boolean; error?: string }> {
    return post('/beaver/test/external-file-delete', { ext_key: extKey, delete_copy: deleteCopy }, opts);
}

export interface ViewImagesResponse {
    type?: string;
    request_id?: string;
    external_file_key?: string | null;
    kind?: 'pdf' | 'image' | null;
    images?: Array<{
        image_data: string;
        format: string;
        width: number;
        height: number;
        page_number?: number;
        page_label?: string | null;
    }>;
    total_pages?: number | null;
    error?: string | null;
    error_code?: string | null;
}

/** POST `/beaver/test/external-file-view-images` — dev-only view images for an external file. */
export function viewExternalFileImages(
    extKey: string,
    extra?: {
        start_page?: number;
        end_page?: number;
        dpi?: number;
        max_width?: number;
        max_height?: number;
        format?: 'png' | 'jpeg' | 'auto';
        jpeg_quality?: number;
        timeout_seconds?: number;
    },
    opts?: RequestOptions,
): Promise<ViewImagesResponse> {
    return post('/beaver/test/external-file-view-images', { ext_key: extKey, ...extra }, opts);
}
