/**
 * Page label resolution utilities.
 *
 * Loads PDF page labels from the attachment file cache and exposes explicit
 * render-time maps so React/static rendering does not need to read mutable
 * cache state directly.
 *
 * Two conventions coexist in the codebase:
 * - Citation tag `page` attribute / model-provided page numbers: 1-based page numbers
 * - `getCitationPages()` return values: 1-based page numbers (page_idx + 1)
 *
 * The resolver functions translate physical page numbers to visible page
 * labels for display and Zotero note export.
 *
 * All callers resolve labels up-front (via the `preload*` functions) and pass
 * an explicit `PageLabelsByAttachmentId` map into the `*FromLabels` resolvers,
 * so no rendering path reads mutable cache state synchronously.
 */

import { makeRemoteFilePath } from '../../src/services/documentFileIdentity';
import { getAttachmentFileStatus, isRemoteAccessAvailable } from '../../src/services/agentDataProvider/utils';
import type { PageLabels } from '../../src/services/documentCache';
import type { Citation } from '../types/citations';
import { getBestPDFAttachmentAsync } from '../../src/utils/zoteroItemHelpers';
import { UNRESOLVED_LIBRARY_ID, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import {
    getPageLocator,
    getRequestedRef,
    getResolvedRef,
    normalizeCitationTag,
    parseRawCitationAttributes,
} from './citationGrammar';
import type { PageLabelsByAttachmentId } from '../atoms/citations';

// Regex for citation tags — matches self-closing and non-self-closing forms
const CITATION_REGEX = /<citation(?:\s+([^>]*?))?\s*(\/>|>(?:.*?<\/citation>)?)/g;

export type PreloadFilePath =
    | { item: Zotero.Item; filePath: string; isRemoteOnly: false }
    | { item: Zotero.Item; filePath: string; isRemoteOnly: true };

function hasPageLabels(labels: PageLabels | null | undefined): labels is PageLabels {
    return !!labels && Object.keys(labels).length > 0;
}

function addPageLabels(
    target: PageLabelsByAttachmentId,
    itemId: number,
    labels: PageLabels | null | undefined,
): void {
    if (!hasPageLabels(labels)) return;
    target[itemId] = { ...labels };
}

export async function getCitationPreloadFilePath(item: Zotero.Item): Promise<PreloadFilePath | null> {
    if (!item.isAttachment()) {
        const attachment = item.isRegularItem?.() ? await getBestPDFAttachmentAsync(item) : null;
        if (!attachment) return null;
        item = attachment;
    }

    const filePath = await item.getFilePathAsync();
    if (filePath) return { item, filePath, isRemoteOnly: false };

    if (isRemoteAccessAvailable(item)) {
        return { item, filePath: makeRemoteFilePath(item), isRemoteOnly: true };
    }

    return null;
}

/**
 * Resolve a 1-based page number against an explicit page-label map.
 *
 * @param pageLabels - 0-based page index to display label
 * @param pageNumber - 1-based page number
 * @returns The page label string, or the page number as string
 */
export function resolvePageLabelFromLabels(
    pageLabels: PageLabels | null | undefined,
    pageNumber: number,
): string {
    if (!hasPageLabels(pageLabels)) return String(pageNumber);
    const pageIndex = pageNumber - 1;
    const label = pageLabels[pageIndex];
    if (label == null || label.trim() === '') return String(pageNumber);
    return label;
}

/**
 * Translate a page number string against an explicit page-label map.
 *
 * Only translates strings that are purely numeric page references (digits with
 * optional whitespace/range separators like "-", "–", ","). Non-page locators
 * such as "§3.2", "fn. 5", or "xii" are returned unchanged.
 */
export function translatePageNumberToLabelFromLabels(
    pageLabels: PageLabels | null | undefined,
    pageStr: string,
): string {
    if (!hasPageLabels(pageLabels)) return pageStr;

    if (!/^\s*\d[\d\s,\-–]*$/.test(pageStr)) return pageStr;

    return pageStr.replace(/\d+/g, (numStr) => {
        const pageIndex = parseInt(numStr, 10) - 1;
        if (isNaN(pageIndex) || pageIndex < 0) return numStr;
        const label = pageLabels[pageIndex];
        if (label == null || label.trim() === '') return numStr;
        return label;
    });
}

/**
 * Pre-load attachment page labels into the in-memory cache for all citations
 * in the given content string. Must be called (and awaited) before synchronous
 * rendering with `renderToMarkdown` or `renderToHTML`.
 *
 * For each referenced attachment:
 * 1. Try the metadata cache (DB -> memory) via `getMetadata`.
 * 2. On local cache miss, run full extraction via `getAttachmentFileStatus`.
 *    On remote-only cache miss, skip rather than downloading during render.
 */
export async function preloadPageLabelsForContent(content: string): Promise<PageLabelsByAttachmentId> {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return {};

    const seen = new Set<number>();
    const labelsByAttachmentId: PageLabelsByAttachmentId = {};
    const regex = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
        if (!normalized.ok || normalized.ref.kind !== 'zotero') continue;
        // A portable ref whose library isn't on this device can't be looked up
        // (and would throw); there's nothing to preload for it.
        if (normalized.ref.library_id === UNRESOLVED_LIBRARY_ID) continue;

        try {
            const item = Zotero.Items.getByLibraryAndKey(normalized.ref.library_id, normalized.ref.zotero_key);
            if (!item) continue;

            const preloadPath = await getCitationPreloadFilePath(item);
            if (!preloadPath) continue;
            const preloadItem = preloadPath.item;
            if (seen.has(preloadItem.id)) continue;
            seen.add(preloadItem.id);

            // Cache hit → page_labels already in memory cache
            const record = await cache.getMetadata({
                libraryId: preloadItem.libraryID,
                zoteroKey: preloadItem.key,
            }, preloadPath.filePath);
            if (record) {
                addPageLabels(labelsByAttachmentId, preloadItem.id, record.pageLabels);
                continue;
            }

            // Do not download remote-only PDFs just to preload labels. A later
            // explicit content request will populate the cache if needed.
            if (preloadPath.isRemoteOnly) continue;

            // Local cache miss → run full extraction, then read labels back.
            await getAttachmentFileStatus(preloadItem, false);
            const refreshed = await cache.getMetadata({
                libraryId: preloadItem.libraryID,
                zoteroKey: preloadItem.key,
            }, preloadPath.filePath);
            addPageLabels(labelsByAttachmentId, preloadItem.id, refreshed?.pageLabels);
        } catch {
            // Skip items that can't be resolved
        }
    }

    return labelsByAttachmentId;
}

/**
 * Pre-load attachment page labels into the in-memory cache for the given
 * citation metadata records. Used when citation metadata is available directly
 * (e.g., on run completion or thread load) so the rendering path can resolve
 * page labels synchronously.
 *
 * Returns populated page labels keyed by attachment item ID. Empty label maps
 * are omitted because renderers fall back to raw page numbers.
 */
export async function preloadPageLabelsForCitations(
    citations: ReadonlyArray<Partial<Citation>>
): Promise<PageLabelsByAttachmentId> {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return {};

    const seen = new Set<number>();
    const labelsByAttachmentId: PageLabelsByAttachmentId = {};

    for (const citation of citations) {
        // Skip citations that don't have any page locators — labels aren't needed.
        const hasPages =
            (citation.pages && citation.pages.length > 0) ||
            (citation.locations || []).some((location) => location.page_idx !== undefined);
        const requestedRef = getRequestedRef(citation);
        const resolvedRef = getResolvedRef(citation);
        const hasPageLocator =
            !!(requestedRef && getPageLocator(requestedRef)) ||
            !!(resolvedRef && getPageLocator(resolvedRef));
        if (!hasPages && !hasPageLocator) continue;

        const zoteroRef = resolvedRef?.kind === 'zotero'
            ? resolvedRef
            : requestedRef?.kind === 'zotero'
                ? requestedRef
                : null;
        if (!zoteroRef) continue;
        // Group citations carry a device-local library_id of
        // UNRESOLVED_LIBRARY_ID; resolve the portable library_ref to this
        // device's local library id (null → library not on this device, nothing
        // to preload) so group citations get printed-page labels too. No
        // exclusion gate: page labels only enrich the rendering of citations
        // already persisted in history, which is not gated on library exclusion.
        const resolvedLibraryId = resolveLibraryRef({ library_ref: zoteroRef.library_ref, library_id: zoteroRef.library_id });
        if (!resolvedLibraryId) continue;

        try {
            const item = Zotero.Items.getByLibraryAndKey(resolvedLibraryId, zoteroRef.zotero_key);
            if (!item) continue;

            const preloadPath = await getCitationPreloadFilePath(item);
            if (!preloadPath) continue;
            const preloadItem = preloadPath.item;
            if (seen.has(preloadItem.id)) continue;
            seen.add(preloadItem.id);

            const record = await cache.getMetadata({
                libraryId: preloadItem.libraryID,
                zoteroKey: preloadItem.key,
            }, preloadPath.filePath);
            if (record) {
                addPageLabels(labelsByAttachmentId, preloadItem.id, record.pageLabels);
                continue;
            }

            if (preloadPath.isRemoteOnly) continue;

            await getAttachmentFileStatus(preloadItem, false);
            const refreshed = await cache.getMetadata({
                libraryId: preloadItem.libraryID,
                zoteroKey: preloadItem.key,
            }, preloadPath.filePath);
            addPageLabels(labelsByAttachmentId, preloadItem.id, refreshed?.pageLabels);
        } catch {
            // Skip items that can't be resolved
        }
    }

    return labelsByAttachmentId;
}
