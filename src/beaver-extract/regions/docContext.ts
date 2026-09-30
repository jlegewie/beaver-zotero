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
        const seen = new Set<number>();
        for (let o = 0; o < g.count * GRAPHICS_SUMMARY_STRIDE; o += GRAPHICS_SUMMARY_STRIDE) {
            const kind = g.records[o + GS_FIELD.kind];
            if (kind === GS_KIND.image || kind === GS_KIND.imageMask) seen.add(g.records[o + GS_FIELD.imageHash]);
        }
        for (const hash of seen) pages.set(hash, (pages.get(hash) ?? 0) + 1);
    }
    return { imagePageCount: (hash) => pages.get(hash) ?? 0 };
}
