/**
 * Build the ordered list of places Zotero should try when fetching a PDF.
 */

import type { PdfCandidate } from '@beaver/agent-core/types/agentActions/items';

/** Options for PDF fetch background task */
export interface PdfFetchOptions {
    /**
     * Ranked places to try, best first, from the backend. Handed to Zotero
     * ahead of its own resolvers. Empty for clients that did not declare the
     * pdf_candidates feature.
     */
    pdfCandidates?: PdfCandidate[];
    openAccessUrl?: string;
    fallbackUrl?: string;
    fileAvailable?: boolean;
    /**
     * Optional correlation IDs. When provided, the background task emits an
     * attachment_resolved ws event on completion (success or failure) so the
     * backend can update the matching agent action and surface the result to
     * the model mid-turn. Dropped silently if the ws is not connected; the
     * backend's safety-net lookup at the next user message handles that case.
     */
    actionId?: string;
    runId?: string;
    threadId?: string;
}

/**
 * Turn a backend candidate into the resolver shape Zotero expects.
 *
 * `downloadFirstAvailableFile` reads `url` (a direct file) and `pageURL` (a page
 * to walk with a translator). `accessMethod` comes back through
 * `onAccessMethodStart`, which is how the caller learns which source won;
 * `articleVersion` only titles the attachment.
 */
export function toUrlResolver(candidate: PdfCandidate): Record<string, unknown> | null {
    const url = candidate.url || undefined;
    const pageURL = candidate.page_url || undefined;
    if (!url && !pageURL) return null;
    return {
        url,
        pageURL,
        accessMethod: candidate.access_method || 'openalex',
        articleVersion: candidate.version || undefined,
    };
}

/**
 * The ordered resolver list for one item.
 *
 * Ours first — the backend ranks them, direct files ahead of landing pages —
 * then Zotero's own `doi` / `url` / `oa` / `custom` resolvers, which is how a
 * user's `extensions.zotero.findPDFs.resolvers` still applies. Zotero's 6-URL
 * cap applies only to arrays returned by *function* resolvers, so a directly
 * supplied array is never truncated; the backend caps its own contribution.
 *
 * `openAccessUrl` / `fallbackUrl` stand in when the backend sent no candidates,
 * so a client talking to a backend without the feature still gets its two URLs
 * tried first.
 */
export function buildPdfResolvers(item: Zotero.Item, options: PdfFetchOptions): Record<string, unknown>[] {
    const ours = (options.pdfCandidates ?? [])
        .map(toUrlResolver)
        .filter((r): r is Record<string, unknown> => r !== null);

    if (ours.length === 0) {
        if (options.openAccessUrl) {
            ours.push({ url: options.openAccessUrl, accessMethod: 'openalex' });
        }
        // Only when the item is flagged open access: this is the article page,
        // not a known file, so it is worth a translator walk only when the item
        // claims to have one.
        if (options.fallbackUrl && options.fileAvailable && options.fallbackUrl !== options.openAccessUrl) {
            ours.push({ pageURL: options.fallbackUrl, accessMethod: 'url' });
        }
    }

    return [...ours, ...((Zotero.Attachments as any).getFileResolvers(item) ?? [])];
}

