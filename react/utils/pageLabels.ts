/**
 * Page label resolution utilities.
 *
 * Uses the AttachmentFileCache's in-memory cache to resolve page indices
 * to their display labels (e.g., Roman numerals for front matter).
 *
 * Two conventions coexist in the codebase:
 * - Citation tag `page` attribute / model-provided page numbers: 1-based page numbers
 * - `getCitationPages()` return values: 1-based page numbers (page_idx + 1)
 *
 * The two resolver functions handle each convention:
 * - `translatePageNumberToLabel`: for page numbers (1-based). If the value already
 *   matches an existing label it is returned as-is; otherwise interprets as
 *   1-based page number and looks up pageLabels[number - 1].
 * - `resolvePageLabel`: for getCitationPages() values (1-based, subtracts 1)
 *
 * All lookups are synchronous (memory cache only). Call `preloadPageLabelsForContent`
 * before rendering to ensure the memory cache is populated. Preloading reuses the
 * full extraction path (`getAttachmentFileStatus`) on cache miss.
 */

import { getAttachmentFileStatus } from '../../src/services/agentDataProvider/utils';
import type { CitationMetadata } from '../types/citations';

// Regex for citation tags — matches self-closing and non-self-closing forms
const CITATION_REGEX = /<citation\s+([^>]+?)\s*(\/>|>(?:.*?<\/citation>)?)/g;
const ATT_ID_REGEX = /(?:att_id|attachment_id)\s*=\s*"([^"]*)"/;

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
 * Translate a page number string (1-based, as humans see it) to its display label.
 *
 * Only translates strings that are purely numeric page references (digits with
 * optional whitespace/range separators like "-", "–", ","). Non-page locators
 * such as "§3.2", "fn. 5", or "xii" are returned unchanged.
 *
 * @param itemId - Zotero item ID (typically an attachment)
 * @param pageStr - Page string (e.g., "15", "7-8")
 * @returns Resolved page label string
 */
export function translatePageNumberToLabel(itemId: number, pageStr: string): string {
    try {
        const cache = Zotero.Beaver?.attachmentFileCache;
        if (!cache) return pageStr;

        const pageLabels = cache.getPageLabelsSync(itemId);
        if (!pageLabels) return pageStr;

        // Only translate strings that look like pure numeric page references
        // (digits, whitespace, range/list separators). Anything else (letters,
        // "§", ".", etc.) means a structured locator — return unchanged.
        if (!/^\s*\d[\d\s,\-–]*$/.test(pageStr)) return pageStr;

        return pageStr.replace(/\d+/g, (numStr) => {
            // Interpret as 1-based page number → 0-based index
            const pageIndex = parseInt(numStr, 10) - 1;
            if (isNaN(pageIndex) || pageIndex < 0) return numStr;
            return pageLabels[pageIndex] ?? numStr;
        });
    } catch {
        return pageStr;
    }
}

/**
 * Pre-load attachment page labels into the in-memory cache for all citations
 * in the given content string. Must be called (and awaited) before synchronous
 * rendering with `renderToMarkdown` or `renderToHTML`.
 *
 * For each referenced attachment:
 * 1. Try the metadata cache (DB -> memory) via `getMetadata`.
 * 2. On cache miss, run full extraction via `getAttachmentFileStatus`.
 */
export async function preloadPageLabelsForContent(content: string): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    const seen = new Set<number>();
    const regex = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const attMatch = ATT_ID_REGEX.exec(match[1]);
        if (!attMatch) continue;

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

            const filePath = await item.getFilePathAsync();
            if (!filePath) continue;

            // Cache hit → page_labels already in memory cache
            const record = await cache.getMetadata(item.id, filePath);
            if (record) continue;

            // Cache miss → run full extraction (same as search path)
            await getAttachmentFileStatus(item, false);
        } catch {
            // Skip items that can't be resolved
        }
    }
}

/**
 * Pre-load attachment page labels into the in-memory cache for the given
 * citation metadata records. Used when citation metadata is available directly
 * (e.g., on run completion or thread load) so the rendering path can resolve
 * page labels synchronously.
 */
export async function preloadPageLabelsForCitations(
    citations: ReadonlyArray<Pick<CitationMetadata, 'library_id' | 'zotero_key' | 'pages' | 'parts'>>
): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    const seen = new Set<number>();

    for (const citation of citations) {
        if (!citation.library_id || !citation.zotero_key) continue;

        // Skip citations that don't have any page locators — labels aren't needed.
        const hasPages =
            (citation.pages && citation.pages.length > 0) ||
            (citation.parts || []).some((p) => (p.locations || []).length > 0);
        if (!hasPages) continue;

        try {
            const item = Zotero.Items.getByLibraryAndKey(citation.library_id, citation.zotero_key);
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);

            const filePath = await item.getFilePathAsync();
            if (!filePath) continue;

            const record = await cache.getMetadata(item.id, filePath);
            if (record) continue;

            await getAttachmentFileStatus(item, false);
        } catch {
            // Skip items that can't be resolved
        }
    }
}
