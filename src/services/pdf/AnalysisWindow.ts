/**
 * Analysis Window — single source of truth for resolving the cross-page
 * analysis page set used by margin smart-removal and the document-wide
 * style profile.
 *
 * One knob: `analysisWindow`. `0` analyzes only the targets;
 * `N > 0` expands ±N around each target and unions; `Infinity` covers
 * the whole document. The 50-page cap that previously narrowed
 * "whole document" requests stays as a constant for the dev-only
 * `opAnalyzeMarginRemoval` endpoint and is NOT consulted by
 * `resolveAnalysisPages` — callers control cost by choosing N.
 *
 * Worker-safe: depends only on plain numbers; no PDF or DOM modules.
 */

/**
 * Default cap on analysis-window size (pages). Used **only** by the
 * dev-only `opAnalyzeMarginRemoval` endpoint as a guardrail against
 * walking entire large PDFs through the diagnostic surface.
 * `resolveAnalysisPages` does not consult this constant.
 */
export const DEFAULT_ANALYSIS_WINDOW_CAP = 50;

/**
 * Resolve the page indices that should be scanned for cross-page
 * analysis (margin smart-removal, document-wide style profile).
 *
 * Algorithm: union of `[t-N, t+N]` clipped to `[0, pageCount-1]` for
 * every `t in targetPageIndices`. `N=0` returns the targets unchanged;
 * `N=Infinity` returns the whole document.
 *
 * Validation:
 *   - `pageCount` must be a positive integer.
 *   - `analysisWindow` must satisfy
 *     `(Number.isInteger(N) || N === Infinity) && N >= 0`. Fractional
 *     `N` would emit fractional page indices through `t±N` and break
 *     downstream `extractRawPageFromDoc` calls.
 *   - Every target must be a non-negative integer in `[0, pageCount-1]`.
 *     Worker ops apply user-facing validation upstream
 *     (`resolveExplicitPageIndicesOrThrow` /
 *     `resolvePageRangeOrThrow`); this helper assumes its targets are
 *     already valid in the caller's contract sense and throws
 *     `RangeError` on contract violations.
 *
 * Window expansion clips at document bounds (no throw on near-boundary
 * targets).
 */
export function resolveAnalysisPages(args: {
    targetPageIndices: number[];
    totalPageCount: number;
    analysisWindow?: number;
}): number[] {
    const { targetPageIndices, totalPageCount, analysisWindow = 0 } = args;

    if (!Number.isInteger(totalPageCount) || totalPageCount <= 0) {
        throw new RangeError(
            `resolveAnalysisPages: totalPageCount must be a positive integer (got ${totalPageCount})`,
        );
    }

    if (
        !(
            (Number.isInteger(analysisWindow) || analysisWindow === Infinity) &&
            analysisWindow >= 0
        )
    ) {
        throw new RangeError(
            `resolveAnalysisPages: analysisWindow must be a non-negative integer or Infinity (got ${analysisWindow})`,
        );
    }

    if (!Array.isArray(targetPageIndices) || targetPageIndices.length === 0) {
        throw new RangeError(
            "resolveAnalysisPages: targetPageIndices must be a non-empty array",
        );
    }

    for (const t of targetPageIndices) {
        if (!Number.isInteger(t) || t < 0 || t >= totalPageCount) {
            throw new RangeError(
                `resolveAnalysisPages: target page ${t} out of range (totalPageCount=${totalPageCount})`,
            );
        }
    }

    const set = new Set<number>();
    for (const t of targetPageIndices) {
        const lo = Math.max(0, t - analysisWindow);
        const hi = Math.min(totalPageCount - 1, t + analysisWindow);
        for (let i = lo; i <= hi; i++) set.add(i);
    }

    return [...set].sort((a, b) => a - b);
}

