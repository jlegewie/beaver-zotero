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
    content_type?: string | null;
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
