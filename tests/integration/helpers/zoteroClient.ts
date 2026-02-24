/**
 * HTTP client wrapper for Beaver endpoints on Zotero's local server.
 */

import { BASE_URL, type AttachmentFixture } from './fixtures';

interface RequestOptions {
    timeout?: number;
}

async function post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = opts?.timeout ?? 25000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${BASE_URL}${path}`, {
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

export interface PagesResponse {
    attachment: { library_id: number; zotero_key: string };
    pages: Array<{ page_number: number; content: string }>;
    total_pages: number | null;
    error?: string | null;
    error_code?: string | null;
}

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

export function fetchPages(
    attachment: AttachmentFixture,
    extra?: {
        start_page?: number;
        end_page?: number;
        skip_local_limits?: boolean;
    },
    opts?: RequestOptions,
): Promise<PagesResponse> {
    return post('/beaver/attachment/pages', {
        attachment: {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
        },
        ...extra,
    }, opts);
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
