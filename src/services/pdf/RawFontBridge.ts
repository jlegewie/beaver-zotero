/**
 * Raw Font Bridge — copy font metadata from a JSON-walk page onto the
 * matching lines of a detailed-walk (per-character) page.
 *
 * Why this exists: the wasm `_wasm_stext_char_get_font` pointer doesn't
 * expose `getName()`, so every line produced by the detailed walker
 * arrives with `font.name === ""` and `weight/style === "normal"` (see
 * `worker/docHelpers.ts` → `extractRawPageDetailedFromDoc`). The
 * sentence pipeline substitutes the detailed page into the analysis
 * window for paragraph detection so the mapper has bbox identity, which
 * means heading detection on the target page can't see real fonts and
 * every line looks like body. Bridging fonts from the JSON walk (which
 * MuPDF populates from font dictionary names) restores style-based
 * heading detection on the target page.
 *
 * The bridge is a pure data transformation — no MuPDF / worker
 * dependencies — so both the main-thread `SentenceExtractionPipeline`
 * and the worker-side `opExtractSentenceBBoxes` can use it.
 */

import type { RawLine, RawPageData, RawPageDataDetailed } from "./types";

/**
 * Vertical-distance tolerance for matching lines between the two walks.
 * The JSON walker emits int-truncated bboxes, the detailed walker emits
 * floats — observed offsets are ~0.5–1.0 pt. 1.5 pt is enough to absorb
 * that noise while still distinguishing adjacent text lines (typical
 * leading is ≥ 8 pt).
 */
const Y_TOLERANCE_PT = 1.5;

/**
 * Minimum horizontal overlap (in points) between the JSON line and the
 * detailed line to accept the match. Prevents a same-row label from
 * stealing a different column's font (e.g., footer "page 5" vs running
 * head on the opposite side of the page).
 */
const MIN_X_OVERLAP_PT = 1.0;

/**
 * Copy font information from `jsonPage`'s lines onto `detailed`'s lines
 * by matching bboxes. Mutates `detailed` in place.
 *
 * Mutation is intentional: paragraph detection downstream uses bbox
 * object identity to bridge between stages, and we want those identical
 * line objects to carry real font info. We replace the `font` object
 * (rather than mutating its fields) so the original empty-font object —
 * which the JSON-walk page doesn't share with us — stays untouched.
 *
 * Lines without a JSON match are left as-is (their font fields remain
 * empty, and downstream `matchesBodyStyle` falls back to the "unknown
 * font" permissive branch).
 */
export function bridgeDetailedPageFonts(
    detailed: RawPageDataDetailed,
    jsonPage: RawPageData,
): void {
    type JsonLineEntry = {
        y: number;
        x: number;
        r: number;
        line: RawLine;
    };

    const jsonLines: JsonLineEntry[] = [];
    for (const block of jsonPage.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            jsonLines.push({
                y: line.bbox.y,
                x: line.bbox.x,
                r: line.bbox.x + line.bbox.w,
                line,
            });
        }
    }

    if (jsonLines.length === 0) return;

    for (const block of detailed.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const dy = line.bbox.y;
            const dx = line.bbox.x;
            const dr = line.bbox.x + line.bbox.w;

            let best: JsonLineEntry | null = null;
            let bestOverlap = -1;
            for (const j of jsonLines) {
                if (Math.abs(j.y - dy) > Y_TOLERANCE_PT) continue;
                const overlap = Math.min(j.r, dr) - Math.max(j.x, dx);
                if (overlap < MIN_X_OVERLAP_PT) continue;
                // Prefer the JSON line with the largest horizontal
                // overlap. Same-y rows with different x ranges (e.g.,
                // running header vs page number) won't fight for the
                // same detailed line.
                if (overlap > bestOverlap) {
                    bestOverlap = overlap;
                    best = j;
                }
            }

            if (best) {
                const src = best.line.font;
                line.font = {
                    name: src.name,
                    family: src.family,
                    weight: src.weight,
                    style: src.style,
                    // Preserve the detailed walker's size — already
                    // truncated to int there to mirror the JSON walker
                    // (see `extractRawPageDetailedFromDoc`).
                    size: line.font.size,
                };
            }
        }
    }
}

/**
 * Substitute the detailed target page into the analysis window AND
 * bridge fonts from the JSON-walk version of that page onto it. This is
 * the helper every sentence-pipeline call site should use when handing
 * pages to `detectFilteredParagraphs` — without the bridge, every line
 * on the target page reads as `font.name === ""` and heading detection
 * is silently disabled on that page.
 *
 * If `detailedTargetPage` is omitted, returns `pages` unchanged
 * (callers that don't substitute, e.g. summary overlays, get a no-op).
 *
 * The bridge mutates `detailedTargetPage` in place so paragraph
 * detection and the downstream sentence mapper see the same line/font
 * objects.
 */
export function pagesForFilterWithBridgedFonts(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage?: RawPageDataDetailed,
): RawPageData[] {
    if (!detailedTargetPage) return pages;

    const jsonTarget = pages.find((p) => p.pageIndex === pageIndex);
    if (jsonTarget && jsonTarget !== (detailedTargetPage as unknown as RawPageData)) {
        bridgeDetailedPageFonts(detailedTargetPage, jsonTarget);
    }

    // `RawPageDataDetailed` is structurally assignable to `RawPageData`
    // (readonly arrays make blocks/lines covariant), so no cast is
    // needed at runtime — the type assertion below is purely for
    // TypeScript's narrowing.
    return pages.map((p) =>
        p.pageIndex === pageIndex ? detailedTargetPage : p,
    );
}
