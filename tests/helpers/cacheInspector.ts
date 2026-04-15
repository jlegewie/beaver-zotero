/**
 * Cache state inspection and cleanup helpers.
 *
 * Talks to the /beaver/test/* endpoints registered in useHttpEndpoints.ts.
 * Shared by live and integration tests.
 */

import { BASE_URL } from './fixtures';

async function post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
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
