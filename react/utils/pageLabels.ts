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
 * before rendering to ensure the memory cache is populated. Preloading reuses the
 * full extraction path (`getAttachmentFileStatus`) on cache miss.
 */

import { getAttachmentFileStatus } from '../../src/services/agentDataProvider/utils';

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
