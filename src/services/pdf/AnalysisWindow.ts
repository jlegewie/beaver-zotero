/**
 * Analysis Window — single source of truth for resolving the per-page
 * analysis window used by cross-page extraction stages (margin
 * smart-removal, document-wide style profile, page-number sequence
 * detection).
 *
 * Worker-safe: depends only on plain numbers; no PDF or DOM modules.
 */

/** Default cap on analysis-window size (pages). Centered on `pageIndex`. */
export const DEFAULT_ANALYSIS_WINDOW_CAP = 50;

/**
 * Resolve the page indices that should be scanned for cross-page
 * analysis when extracting a single target page.
 *
 * - `analysisPageWindow` undefined or 0 → whole document.
 * - Positive N                            → window `[pageIndex-N, pageIndex+N]`
 *                                            clipped to document bounds.
 * - If the resulting window exceeds `cap`, it's narrowed to `cap` pages
 *   centered on `pageIndex` (clipped to bounds).
 * - The returned array always includes `pageIndex` and is sorted
 *   ascending.
 *
 * **Throws** on invalid input:
 *   - `pageIndex < 0`
 *   - `pageIndex >= pageCount`
 *   - `pageCount <= 0`
 *
 * Rationale for throw-not-empty: every existing call site already
 * translates out-of-range pages into an error response. Throwing lets
 * callers wrap a single try/catch around the helper instead of
 * branching on an empty-array sentinel.
 */
export function resolveAnalysisPageIndices(
    pageIndex: number,
    pageCount: number,
    analysisPageWindow?: number,
    cap: number = DEFAULT_ANALYSIS_WINDOW_CAP,
): number[] {
    if (!Number.isInteger(pageCount) || pageCount <= 0) {
        throw new RangeError(
            `resolveAnalysisPageIndices: pageCount must be a positive integer (got ${pageCount})`,
        );
    }
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
        throw new RangeError(
            `resolveAnalysisPageIndices: page_index ${pageIndex} out of range (pageCount=${pageCount})`,
        );
    }

    let lo: number;
    let hi: number;
    if (Number.isInteger(analysisPageWindow) && (analysisPageWindow as number) > 0) {
        const w = analysisPageWindow as number;
        lo = Math.max(0, pageIndex - w);
        hi = Math.min(pageCount - 1, pageIndex + w);
    } else {
        lo = 0;
        hi = pageCount - 1;
    }

    if (hi - lo + 1 > cap) {
        // Center the cap on pageIndex; clip to bounds.
        const half = Math.floor(cap / 2);
        lo = Math.max(0, pageIndex - half);
        hi = Math.min(pageCount - 1, lo + cap - 1);
        // Re-clip lo if hi hit the upper bound (keeps the cap centered
        // when pageIndex is near the end of the document).
        lo = Math.max(0, hi - cap + 1);
    }

    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
}
