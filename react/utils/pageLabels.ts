/**
 * Page label resolution utilities.
 *
 * Uses the AttachmentFileCache's in-memory cache to resolve page indices
 * to their display labels (e.g., Roman numerals for front matter).
 *
 * Two conventions coexist in the codebase:
 * - Citation tag `page` attribute: 0-based page index (matches page_labels keys)
 * - `getCitationPages()` return values: 1-based page numbers (page_idx + 1)
 *
 * The two resolver functions handle each convention:
 * - `resolvePageStr`: for raw citation tag attributes (0-based, no offset)
 * - `resolvePageLabel`: for getCitationPages() values (1-based, subtracts 1)
 *
 * All lookups are synchronous (memory cache only). Call `preloadPageLabelsForContent`
 * before rendering to ensure the memory cache is populated.
 */

import { MuPDFService } from '../../src/services/pdf/MuPDFService';
import { EXTRACTION_VERSION } from '../../src/services/attachmentFileCache';
import { logger } from '../../src/utils/logger';

// Regex for citation tags — matches self-closing and non-self-closing forms
const CITATION_REGEX = /<citation\s+([^>]+?)\s*(\/>|>(?:.*?<\/citation>)?)/g;
const ATT_ID_REGEX = /(?:att_id|attachment_id)\s*=\s*"([^"]*)"/;

/** Per-attachment timeout for reading page labels from PDF (ms). */
const PDF_LABEL_FETCH_TIMEOUT_MS = 5_000;

/**
 * Items we've already attempted to fetch page labels from PDF for.
 * Prevents re-reading the same PDF on every render when it has no custom labels.
 */
const attempted = new Set<number>();

/**
 * Resolve a 1-based page number (from getCitationPages) to its display label.
 *
 * @param itemId - Zotero item ID (typically an attachment)
 * @param pageNumber - 1-based page number
 * @returns The page label string, or the page number as string
 */
export function resolvePageLabel(itemId: number, pageNumber: number): string {
    try {
        const cache = Zotero.Beaver?.attachmentFileCache;
        if (!cache) return String(pageNumber);

        const pageLabels = cache.getPageLabelsSync(itemId);
        if (!pageLabels) return String(pageNumber);

        // Convert 1-based page number to 0-based index for page_labels lookup
        const pageIndex = pageNumber - 1;
        return pageLabels[pageIndex] ?? String(pageNumber);
    } catch {
        return String(pageNumber);
    }
}

/**
 * Resolve a page string from a citation tag attribute (0-based page index).
 * Replaces each numeric token with its corresponding page label.
 *
 * The `page` attribute in citation tags uses 0-based page indices that map
 * directly to page_labels keys (no offset needed).
 *
 * @param itemId - Zotero item ID (typically an attachment)
 * @param pageStr - Page string from citation tag attributes (e.g., "7", "7-8")
 * @returns Resolved page label string
 */
export function resolvePageStr(itemId: number, pageStr: string): string {
    try {
        const cache = Zotero.Beaver?.attachmentFileCache;
        if (!cache) return pageStr;

        const pageLabels = cache.getPageLabelsSync(itemId);
        if (!pageLabels) return pageStr;

        // page attribute values are 0-based indices — use directly as keys
        return pageStr.replace(/\d+/g, (numStr) => {
            const pageIndex = parseInt(numStr, 10);
            if (isNaN(pageIndex)) return numStr;
            return pageLabels[pageIndex] ?? numStr;
        });
    } catch {
        return pageStr;
    }
}

// ---------------------------------------------------------------------------
// PDF-based page label fetching (fallback)
// ---------------------------------------------------------------------------

/** Sentinel returned by {@link withTimeout} when the deadline is exceeded. */
const TIMED_OUT = Symbol('TIMED_OUT');

/** Sentinel: fetch returned null for a transient reason (file not yet available). */
const TRANSIENT_NULL = Symbol('TRANSIENT_NULL');

/**
 * Race a promise against a timeout.
 * Returns the {@link TIMED_OUT} symbol if the deadline fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), ms);
        }),
    ]).finally(() => clearTimeout(timer!));
}

/** Successful result from {@link fetchPageLabelsFromPDF}. */
interface PageLabelFetchResult {
    labels: Record<number, string> | null;
    item: Zotero.Item;
    filePath: string;
    pageCount: number;
}

/**
 * Read page labels directly from a PDF attachment using MuPDF.
 *
 * Returns:
 * - `PageLabelFetchResult` — PDF was read successfully (labels may be null if none)
 * - `TRANSIENT_NULL` — could not access the file (not synced / missing);
 *   the caller should leave the item eligible for retry.
 */
async function fetchPageLabelsFromPDF(
    itemId: number,
): Promise<PageLabelFetchResult | typeof TRANSIENT_NULL> {
    const item = await Zotero.Items.getAsync(itemId);
    if (!item?.isAttachment?.() || item.attachmentContentType !== 'application/pdf') {
        // Not a PDF attachment — return a definitive "no labels" result.
        // We don't have the metadata to build a cache record, so return a
        // minimal result that the caller can handle.
        return { labels: null, item: item!, filePath: '', pageCount: 0 };
    }

    const filePath = await item.getFilePathAsync();
    if (!filePath) return TRANSIENT_NULL;

    const exists = await IOUtils.exists(filePath);
    if (!exists) return TRANSIENT_NULL;

    const pdfData = await IOUtils.read(filePath);
    const mupdf = new MuPDFService();
    try {
        await mupdf.open(pdfData);
        const pageCount = mupdf.getPageCount();
        const labels = mupdf.getAllPageLabels();
        return {
            labels: Object.keys(labels).length > 0 ? labels : null,
            item,
            filePath,
            pageCount,
        };
    } finally {
        mupdf.close();
    }
}

// ---------------------------------------------------------------------------
// Preloading
// ---------------------------------------------------------------------------

/**
 * Pre-load attachment page labels into the in-memory cache for all citations
 * in the given content string. Must be called (and awaited) before synchronous
 * rendering with `renderToMarkdown` or `renderToHTML`.
 *
 * For each referenced attachment:
 * 1. Try the metadata cache (DB -> memory).
 * 2. If page labels are still missing and we haven't tried this attachment
 *    before, read the PDF directly via MuPDF (with a per-attachment timeout).
 * 3. Cache any labels found so future renders are instant.
 */
export async function preloadPageLabelsForContent(content: string): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    const seen = new Set<number>();
    const needsFetch: number[] = [];
    const regex = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const attMatch = ATT_ID_REGEX.exec(match[1]);
        if (!attMatch) continue;

        // Parse "libraryID-itemKey"
        const ref = attMatch[1].replace('user-content-', '');
        const dashIdx = ref.indexOf('-');
        if (dashIdx <= 0) continue;

        const libraryID = parseInt(ref.substring(0, dashIdx), 10);
        const itemKey = ref.substring(dashIdx + 1);
        if (!libraryID || !itemKey) continue;

        try {
            const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);

            await cache.ensureInMemoryCache(item.id);

            // Only fetch from PDF if:
            // - no page labels in any cache, AND
            // - page labels haven't been definitively resolved yet
            //   (a record with page_labels: null means a lightweight handler
            //   created it without checking labels; page_labels: {} means
            //   labels were checked and none were found), AND
            // - we haven't already tried reading this PDF this session.
            if (
                !cache.getPageLabelsSync(item.id) &&
                !cache.hasResolvedPageLabels(item.id) &&
                !attempted.has(item.id)
            ) {
                needsFetch.push(item.id);
            }
        } catch {
            // Skip items that can't be resolved
        }
    }

    // Fetch page labels from PDFs sequentially to limit resource usage.
    for (const itemId of needsFetch) {
        try {
            const result = await withTimeout(
                fetchPageLabelsFromPDF(itemId),
                PDF_LABEL_FETCH_TIMEOUT_MS,
            );

            if (result === TIMED_OUT || result === TRANSIENT_NULL) {
                if (result === TIMED_OUT) {
                    logger(`preloadPageLabelsForContent: timed out fetching labels for item ${itemId}`);
                }
                continue;
            }

            // Persist a full metadata record so labels survive across renders
            // and sessions.  We store {} (empty object) when the PDF has no
            // custom labels to distinguish from null ("not checked yet").
            //
            // Uses insert-if-not-exists to avoid overwriting richer data a
            // concurrent handler may have written.  If a row already exists,
            // we always update page_labels so the "resolved" state persists.
            if (result.filePath) {
                const stat = await IOUtils.stat(result.filePath);
                const labelsToStore = result.labels ?? {};
                const inserted = await cache.setMetadataIfNotExists({
                    item_id: itemId,
                    library_id: result.item.libraryID,
                    zotero_key: result.item.key,
                    file_path: result.filePath,
                    file_mtime_ms: stat.lastModified ?? 0,
                    file_size_bytes: stat.size ?? 0,
                    content_type: result.item.attachmentContentType || 'application/pdf',
                    page_count: result.pageCount,
                    page_labels: labelsToStore,
                    has_text_layer: null,
                    needs_ocr: null,
                    is_encrypted: false,
                    is_invalid: false,
                    extraction_version: EXTRACTION_VERSION,
                    has_content_cache: false,
                });

                // Row already existed (concurrent handler) — update labels
                // to mark them as resolved (either with actual labels or {}).
                if (!inserted) {
                    await cache.updatePageLabels(itemId, labelsToStore);
                }
            }

            // Mark attempted only after successful persistence so transient
            // failures (stat/DB errors) leave the item eligible for retry.
            attempted.add(itemId);
        } catch (error) {
            // Transient error — leave the item eligible for retry.
            logger(`preloadPageLabelsForContent: failed to fetch labels for item ${itemId}: ${error}`);
        }
    }
}
