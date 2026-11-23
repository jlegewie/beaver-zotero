/**
 * Build the ordered list of places Zotero should try when fetching a PDF.
 */

import type { PdfCandidate } from '@beaver/agent-core/types/agentActions/items';

/** Options for PDF fetch background task */
export interface PdfFetchOptions {
    onAttachmentResolved?: (payload: import("../services/attachmentResolved").AttachmentResolvedPayload) => void;
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

// Hosts whose links never give Zotero a file: abstract and index pages
// (PubMed, DOAJ), handle resolvers, hosts that always answer Zotero with a
// bot challenge (SSRN), and the archive's slow snapshots. Zotero's own
// open-access lookup sends fetches here too, so the backend's candidate filter
// alone does not cover them. ScienceDirect is not listed: the CAPTCHA guard
// refuses it per request, which keeps it visible in the attempt trail.
const NO_FILE_HOSTS = ['pubmed.ncbi.nlm.nih.gov', 'doaj.org', 'hdl.handle.net', 'ssrn.com', 'web.archive.org'];
// Landing pages that never yield a file, though their direct PDF links do
// (Europe PMC's `?pdf=render`).
const NO_FILE_LANDING_HOSTS = ['europepmc.org'];

function hostMatches(url: string, hosts: string[]): boolean {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return hosts.some(h => host === h || host.endsWith(`.${h}`));
}

/** True if Zotero cannot get a file from this link, so trying it only costs time. */
export function isDeadEndPdfLink(url: string, landingPage: boolean): boolean {
    return hostMatches(url, NO_FILE_HOSTS) || (landingPage && hostMatches(url, NO_FILE_LANDING_HOSTS));
}

/** A resolver entry without its dead-end links, or null when nothing usable is left. */
function pruneEntry(entry: unknown): unknown {
    if (typeof entry === 'string') return isDeadEndPdfLink(entry, false) ? null : entry;
    if (!entry || typeof entry !== 'object') return entry;
    const resolver = entry as Record<string, unknown>;
    const url = typeof resolver.url === 'string' && !isDeadEndPdfLink(resolver.url, false) ? resolver.url : undefined;
    const pageURL = typeof resolver.pageURL === 'string' && !isDeadEndPdfLink(resolver.pageURL, true)
        ? resolver.pageURL
        : undefined;
    if (!url && !pageURL) return null;
    return { ...resolver, url, pageURL };
}

/**
 * Drop dead-end links from resolvers. A function resolver (Zotero's
 * open-access lookup, custom resolvers) is wrapped so its results are pruned
 * when Zotero calls it, before Zotero's own 6-URL cap.
 */
export function withoutDeadEndLinks(resolvers: unknown[]): unknown[] {
    return resolvers
        .map((entry) => {
            if (typeof entry !== 'function') return pruneEntry(entry);
            return async () => {
                const results = await (entry as () => Promise<unknown>)();
                return Array.isArray(results) ? results.map(pruneEntry).filter(r => r !== null) : results;
            };
        })
        .filter(entry => entry !== null);
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
 * tried first. Links that never yield a file are left out of all of them
 * (`isDeadEndPdfLink`).
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

    return withoutDeadEndLinks([...ours, ...((Zotero.Attachments as any).getFileResolvers(item) ?? [])]) as Record<string, unknown>[];
}

