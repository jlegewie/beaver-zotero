/**
 * Document context for region detection: on how many pages each image is drawn,
 * keyed by the graphics summary's image data hash. Logos, publisher badges and
 * banners recur across pages; figures almost never do.
 */
import { GRAPHICS_SUMMARY_STRIDE, GS_FIELD, GS_KIND, type GraphicsSummary } from "../worker/graphicsSummary";
import type { RegionDocContext } from "./features";

export function buildRegionDocContext(summaries: Iterable<GraphicsSummary>): RegionDocContext {
    const pages = new Map<number, number>();
    for (const g of summaries) {
        for (const hash of pageImageHashes(g)) pages.set(hash, (pages.get(hash) ?? 0) + 1);
    }
    return { imagePageCount: (hash) => pages.get(hash) ?? 0 };
}

/** Image data hashes drawn on a page. */
export function pageImageHashes(g: GraphicsSummary): Set<number> {
    const seen = new Set<number>();
    for (let o = 0; o < g.count * GRAPHICS_SUMMARY_STRIDE; o += GRAPHICS_SUMMARY_STRIDE) {
        const kind = g.records[o + GS_FIELD.kind];
        if (kind === GS_KIND.image || kind === GS_KIND.imageMask) seen.add(g.records[o + GS_FIELD.imageHash]);
    }
    return seen;
}

/**
 * Document context for one page as `opDetectRegions` builds it for a single
 * target page: the page itself plus the first `contextPages` other pages. The
 * classifier was trained on that context, and fixing it per page keeps a page's
 * regions independent of which other pages an extraction covers.
 */
export function pageRegionDocContext(
    pageIndex: number,
    hashesByPage: ReadonlyMap<number, ReadonlySet<number>>,
    pageCount: number,
    contextPages: number,
): RegionDocContext {
    const pages: ReadonlySet<number>[] = [];
    const own = hashesByPage.get(pageIndex);
    if (own) pages.push(own);
    for (let i = 0, added = 0; i < pageCount && added < contextPages; i++) {
        if (i === pageIndex) continue;
        const hashes = hashesByPage.get(i);
        if (hashes) pages.push(hashes);
        added++;
    }
    return {
        imagePageCount: (hash) => pages.reduce((n, hashes) => n + (hashes.has(hash) ? 1 : 0), 0),
    };
}
