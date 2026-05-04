/**
 * Extraction Overlay — shared bbox source-of-truth.
 *
 * Computes per-level bounding-box overlays (columns / lines / paragraphs /
 * sentences) for a single PDF page, returning plain rect data in MuPDF
 * top-left point coordinates. No DOM, no Zotero reader, no annotations.
 *
 * Two consumers:
 *   1. `extractionVisualizer.ts` — converts these rects into Zotero
 *      annotations on the live reader.
 *   2. `useHttpEndpoints.ts` (`/beaver/test/pdf-render-overlay`) — passes
 *      them to `canvasOverlay.ts` to draw on a rendered page PNG for
 *      headless agent debugging.
 *
 * Keeping both consumers on a single helper guarantees the visualizer and
 * the agent see the exact same boxes.
 */
import {
    detectColumns,
    detectLinesOnPage,
    detectParagraphs,
    extractPageSentenceBBoxes,
    lineBBoxToRect,
    MarginFilter,
    DEFAULT_MARGINS,
    DEFAULT_MARGIN_ZONE,
    StyleAnalyzer,
    Rect,
    RawPageData,
    RawPageDataDetailed,
    SentenceBBox,
} from "../../src/services/pdf";
import type {
    SentenceSplitter,
    MarginPosition,
    MarginRemovalResult,
} from "../../src/services/pdf";

export type OverlayLevel =
    | "columns"
    | "lines"
    | "paragraphs"
    | "sentences"
    | "sentences-filtered"
    | "raw-lines"
    | "margins";

// Color palette — kept in one place so the visualizer and the canvas
// overlay agree on what each level looks like.
export const OVERLAY_COLORS = {
    column: "#00bbff",
    line: "#ff9500",
    paragraph: "#34c759",
    header: "#af52de",
    // Adjacent sentences alternate between these so they're easy to tell
    // apart at a glance.
    sentence: ["#ff2d55", "#ffcc00"] as const,
    // Fallback sentences (unmapped / invariant violation / empty split)
    // render in a muted color so they stand out against precise ones.
    sentenceDegraded: "#8e8e93",
    // Raw-lines view: one shade per margin zone so an agent can see at a
    // glance which lines the simple margin filter would treat as marginalia
    // vs. content. Inside-content lines reuse the line color.
    rawLineInside: "#ff9500",
    rawLineMarginTop: "#5ac8fa",
    rawLineMarginBottom: "#5ac8fa",
    rawLineMarginLeft: "#ff3b30",
    rawLineMarginRight: "#ff3b30",
    // Margins view: zones drawn very faintly; lines colored by removal
    // outcome. Page-numbers gray (matches degraded), repeats purple,
    // marginalia kept-but-not-removed in yellow as a "watch this" cue.
    marginZone: "#cccccc",
    marginCandidatePageNumber: "#8e8e93",
    marginCandidateRepeat: "#af52de",
    marginKeptInZone: "#ffcc00",
} as const;

/**
 * One rectangle to draw on top of a rendered page.
 *
 * Coordinates are in MuPDF point space (top-left origin). Consumers are
 * responsible for converting to their own coordinate system (Zotero uses
 * bottom-left origin; canvas uses pixel space scaled from points).
 */
export interface OverlayRect {
    /** Bbox in MuPDF top-left point coordinates. */
    rect: Rect;
    /** Hex fill color. */
    color: string;
    /** Optional short label drawn near the rect (group label only). */
    label?: string;
    /**
     * Group index — multiple rects with the same group form one logical
     * highlight (e.g. a sentence that wraps across two lines). Sequential
     * within a level, starting at 0.
     */
    group: number;
    /** True for fallback / degraded fallbacks (sentences only today). */
    degraded?: boolean;
    /**
     * Margin-zone classification (raw-lines / margins overlays only).
     * `null` means the bbox overlaps the content area; otherwise the
     * bbox is fully inside that margin zone under the chosen thresholds.
     */
    marginPosition?: MarginPosition | null;
}

export interface OverlayResult {
    level: OverlayLevel;
    pageIndex: number;
    /** Page width in MuPDF points (used by canvas overlay to compute scale). */
    pageWidth: number;
    /** Page height in MuPDF points. */
    pageHeight: number;
    /** Number of logical groups (columns, lines, paragraphs, or sentences). */
    groupCount: number;
    /** Flat list of rects, ordered by group then by reading order. */
    rects: OverlayRect[];
    /** Level-specific summary stats for logging / endpoint response. */
    stats: Record<string, number | string | undefined>;
}

// ---------------------------------------------------------------------------
// Per-level collectors
// ---------------------------------------------------------------------------

/**
 * Column overlay: one rect per detected column, labelled C1..Cn in reading
 * order. Uses the unfiltered raw page (matches the visualizer).
 */
export function getColumnOverlay(rawPage: RawPageData): OverlayResult {
    const columnResult = detectColumns(rawPage);
    const rects: OverlayRect[] = columnResult.columns.map((col, i) => ({
        rect: col,
        color: OVERLAY_COLORS.column,
        label: `C${i + 1}`,
        group: i,
    }));
    return {
        level: "columns",
        pageIndex: rawPage.pageIndex,
        pageWidth: rawPage.width,
        pageHeight: rawPage.height,
        groupCount: rects.length,
        rects,
        stats: {
            columns: rects.length,
            broken: columnResult.isBroken ? 1 : 0,
        },
    };
}

/**
 * Line overlay: one rect per detected line, labelled L1..Ln across all
 * columns. Mirrors the visualizer's pipeline (margin filter → column
 * detection → line detection).
 */
export function getLineOverlay(rawPage: RawPageData): OverlayResult {
    const filtered = MarginFilter.filterPageByMargins(rawPage, DEFAULT_MARGINS);
    const columnResult = detectColumns(filtered);
    const rects: OverlayRect[] = [];
    let groupCount = 0;

    if (columnResult.columns.length > 0) {
        const lineResult = detectLinesOnPage(filtered, columnResult.columns);
        for (const colResult of lineResult.columnResults) {
            for (const line of colResult.lines) {
                groupCount++;
                rects.push({
                    rect: lineBBoxToRect(line.bbox),
                    color: OVERLAY_COLORS.line,
                    label: `L${groupCount}`,
                    group: groupCount - 1,
                });
            }
        }
    }

    return {
        level: "lines",
        pageIndex: rawPage.pageIndex,
        pageWidth: rawPage.width,
        pageHeight: rawPage.height,
        groupCount,
        rects,
        stats: {
            lines: groupCount,
            columns: columnResult.columns.length,
        },
    };
}

/**
 * Paragraph overlay: one rect per detected paragraph (green) or header
 * (purple). Style analysis is run on this single page only — multi-page
 * style profiling isn't available in a per-page overlay.
 */
export function getParagraphOverlay(rawPage: RawPageData): OverlayResult {
    const filtered = MarginFilter.filterPageByMargins(rawPage, DEFAULT_MARGINS);
    const columnResult = detectColumns(filtered);
    const rects: OverlayRect[] = [];
    let paragraphCount = 0;
    let headerCount = 0;

    if (columnResult.columns.length > 0) {
        const lineResult = detectLinesOnPage(filtered, columnResult.columns);
        if (lineResult.allLines.length > 0) {
            const styleProfile = new StyleAnalyzer().analyze([filtered], 4, 0.15, 0);
            const bodyStyles = styleProfile?.bodyStyles || null;
            const paragraphResult = detectParagraphs(lineResult, bodyStyles);
            paragraphCount = paragraphResult.paragraphCount;
            headerCount = paragraphResult.headerCount;

            paragraphResult.items.forEach((item, i) => {
                const isHeader = item.type === "header";
                rects.push({
                    rect: {
                        x: item.bbox.l,
                        y: item.bbox.t,
                        w: item.bbox.width,
                        h: item.bbox.height,
                    },
                    color: isHeader ? OVERLAY_COLORS.header : OVERLAY_COLORS.paragraph,
                    label: `${isHeader ? "H" : "P"}${item.idx + 1}`,
                    group: i,
                });
            });
        }
    }

    return {
        level: "paragraphs",
        pageIndex: rawPage.pageIndex,
        pageWidth: rawPage.width,
        pageHeight: rawPage.height,
        groupCount: rects.length,
        rects,
        stats: {
            paragraphs: paragraphCount,
            headers: headerCount,
        },
    };
}

/**
 * Sentence overlay: one logical group per sentence, with multiple rects
 * for sentences that wrap across line-fragments. Adjacent sentences get
 * alternating pink/yellow colors. Degraded fallback sentences (one note
 * per paragraph in `degradationNotes`) are colored gray.
 *
 * `splitter` is required by the caller — production callers pass a
 * sentencex-backed splitter; tests can pass `simpleRegexSentenceSplit`
 * via the mapper's default.
 */
export function getSentenceOverlay(
    detailedPage: RawPageDataDetailed,
    splitter?: SentenceSplitter,
): OverlayResult {
    const result = extractPageSentenceBBoxes(detailedPage, { splitter });
    const degradedItemIndices = new Set(result.degradationNotes.map((n) => n.itemIndex));
    const degradedSentenceIndices = computeDegradedSentenceIndices(
        result.paragraphs,
        degradedItemIndices,
    );

    const rects: OverlayRect[] = [];
    result.sentences.forEach((sentence, sentenceIdx) => {
        if (sentence.bboxes.length === 0) return;
        const isDegraded = degradedSentenceIndices.has(sentenceIdx);
        const color = isDegraded
            ? OVERLAY_COLORS.sentenceDegraded
            : OVERLAY_COLORS.sentence[sentenceIdx % OVERLAY_COLORS.sentence.length];

        sentence.bboxes.forEach((bb, fragIdx) => {
            rects.push({
                rect: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
                color,
                // Only the first fragment carries the sentence label so the
                // overlay isn't visually noisy on multi-line sentences.
                label: fragIdx === 0 ? `S${sentenceIdx + 1}` : undefined,
                group: sentenceIdx,
                degraded: isDegraded,
            });
        });
    });

    return {
        level: "sentences",
        pageIndex: detailedPage.pageIndex,
        pageWidth: detailedPage.width,
        pageHeight: detailedPage.height,
        groupCount: result.sentences.length,
        rects,
        stats: {
            sentences: result.sentences.length,
            paragraphs: result.paragraphs.length,
            degradedParagraphs: result.degradedParagraphs,
            unmappedParagraphs: result.unmappedParagraphs,
        },
    };
}

/**
 * Sentence overlay (filtered): same shape as `getSentenceOverlay`, but
 * runs the production filtered pipeline first — simple + smart margin
 * removal, real-font column/line/paragraph detection on the JSON-pass
 * page — and passes the resulting `paragraphResult` to the sentence
 * mapper as `precomputed`. Marginalia (page numbers, watermarks,
 * repeating headers/footers) that the line-extraction pipeline drops
 * will NOT appear in the returned sentences.
 *
 * Intended as a side-by-side counterpart to `getSentenceOverlay` for
 * agent debugging: render both `sentences` and `sentences-filtered` to
 * see at a glance which marginalia the unfiltered sentence pipeline
 * still emits.
 *
 * `pages` must contain the target page; for cross-page smart removal
 * to fire, it should also include the rest of the document (or a
 * window around the target — caller controls the analysis range).
 */
export function getSentenceOverlayFiltered(
    pages: RawPageData[],
    detailedPage: RawPageDataDetailed,
    splitter?: SentenceSplitter,
): OverlayResult {
    const targetPage = pages.find((p) => p.pageIndex === detailedPage.pageIndex);
    if (!targetPage) {
        throw new Error(
            `getSentenceOverlayFiltered: page ${detailedPage.pageIndex} not present in supplied pages`,
        );
    }

    // Cross-page smart removal across the supplied window.
    const marginAnalysis = MarginFilter.collectMarginElements(
        pages,
        DEFAULT_MARGIN_ZONE,
    );
    const removal = MarginFilter.identifyElementsToRemove(
        marginAnalysis,
        3,
        true,
    );

    // Filter + columns + lines + paragraphs on the JSON-pass page (real
    // fonts, so header detection works). The mapper bridges these
    // PageLines to detailed-walk lines via 3-decimal-rounded bbox keys.
    const filtered = MarginFilter.filterPageWithSmartRemoval(
        targetPage,
        DEFAULT_MARGINS,
        DEFAULT_MARGIN_ZONE,
        removal,
    );
    const columnResult = detectColumns(filtered);
    const styleProfile = new StyleAnalyzer().analyze([filtered], 4, 0.15, 0);

    let result;
    if (columnResult.columns.length === 0) {
        result = extractPageSentenceBBoxes(detailedPage, { splitter });
    } else {
        const lineResult = detectLinesOnPage(filtered, columnResult.columns);
        const paragraphResult = detectParagraphs(
            lineResult,
            styleProfile.bodyStyles,
            {},
            { paragraph: 0, header: 0 },
            { trackItemLines: true },
        );
        result = extractPageSentenceBBoxes(detailedPage, {
            splitter,
            precomputed: { paragraphResult },
        });
    }

    const degradedItemIndices = new Set(result.degradationNotes.map((n) => n.itemIndex));
    const degradedSentenceIndices = computeDegradedSentenceIndices(
        result.paragraphs,
        degradedItemIndices,
    );

    const rects: OverlayRect[] = [];
    result.sentences.forEach((sentence, sentenceIdx) => {
        if (sentence.bboxes.length === 0) return;
        const isDegraded = degradedSentenceIndices.has(sentenceIdx);
        const color = isDegraded
            ? OVERLAY_COLORS.sentenceDegraded
            : OVERLAY_COLORS.sentence[sentenceIdx % OVERLAY_COLORS.sentence.length];

        sentence.bboxes.forEach((bb, fragIdx) => {
            rects.push({
                rect: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
                color,
                label: fragIdx === 0 ? `S${sentenceIdx + 1}` : undefined,
                group: sentenceIdx,
                degraded: isDegraded,
            });
        });
    });

    return {
        level: "sentences-filtered",
        pageIndex: detailedPage.pageIndex,
        pageWidth: detailedPage.width,
        pageHeight: detailedPage.height,
        groupCount: result.sentences.length,
        rects,
        stats: {
            sentences: result.sentences.length,
            paragraphs: result.paragraphs.length,
            degradedParagraphs: result.degradedParagraphs,
            unmappedParagraphs: result.unmappedParagraphs,
            analysisPagesScanned: pages.length,
        },
    };
}

/**
 * Find which sentences in the flat list are degradation fallbacks.
 *
 * The fallback path emits exactly one sentence per degraded paragraph,
 * whose text equals the paragraph's whole text. We walk paragraphs in
 * lockstep with their sentences and tag the first sentence of any
 * paragraph that matches that pattern. This mirrors the heuristic in
 * `extractionVisualizer.ts` — a more direct mapping would require the
 * mapper to expose a per-sentence "isFallback" flag.
 */
function computeDegradedSentenceIndices(
    paragraphs: Array<{ item: { text: string }; sentences: SentenceBBox[] }>,
    degradedItemIndices: Set<number>,
): Set<number> {
    const out = new Set<number>();
    if (degradedItemIndices.size === 0) return out;
    let flatIdx = 0;
    for (const pws of paragraphs) {
        if (
            pws.sentences.length === 1 &&
            pws.sentences[0].text === pws.item.text
        ) {
            out.add(flatIdx);
        }
        flatIdx += pws.sentences.length;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Debug-oriented collectors
// ---------------------------------------------------------------------------

/**
 * Raw-lines overlay: every line MuPDF emitted, *before* margin filtering,
 * color-coded by margin-zone classification (top/bottom/left/right/inside).
 */
export function getRawLinesOverlay(rawPage: RawPageData): OverlayResult {
    const rects: OverlayRect[] = [];
    const counts = {
        lines: 0,
        inContent: 0,
        inMarginTop: 0,
        inMarginBottom: 0,
        inMarginLeft: 0,
        inMarginRight: 0,
    };

    for (const block of rawPage.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const position = MarginFilter.getMarginPosition(
                line.bbox,
                rawPage.width,
                rawPage.height,
                DEFAULT_MARGINS,
            );
            counts.lines++;
            let color: string;
            switch (position) {
                case "top":
                    color = OVERLAY_COLORS.rawLineMarginTop;
                    counts.inMarginTop++;
                    break;
                case "bottom":
                    color = OVERLAY_COLORS.rawLineMarginBottom;
                    counts.inMarginBottom++;
                    break;
                case "left":
                    color = OVERLAY_COLORS.rawLineMarginLeft;
                    counts.inMarginLeft++;
                    break;
                case "right":
                    color = OVERLAY_COLORS.rawLineMarginRight;
                    counts.inMarginRight++;
                    break;
                default:
                    color = OVERLAY_COLORS.rawLineInside;
                    counts.inContent++;
            }
            rects.push({
                rect: {
                    x: line.bbox.x,
                    y: line.bbox.y,
                    w: line.bbox.w,
                    h: line.bbox.h,
                },
                color,
                label: `L${counts.lines}`,
                group: counts.lines - 1,
                marginPosition: position,
            });
        }
    }

    return {
        level: "raw-lines",
        pageIndex: rawPage.pageIndex,
        pageWidth: rawPage.width,
        pageHeight: rawPage.height,
        groupCount: rects.length,
        rects,
        stats: counts,
    };
}

/**
 * Margins overlay: the four simple-margin zones drawn as faint outlines,
 * plus lines colored by smart-removal outcome (cross-page analysis):
 *  - page-number candidates → gray
 *  - repeating-text candidates → purple
 *  - lines in margin zone but not flagged for removal → yellow ("watch this")
 */
export function getMarginsOverlay(
    pages: RawPageData[],
    pageIndex: number,
): OverlayResult {
    const targetPage = pages.find((p) => p.pageIndex === pageIndex);
    if (!targetPage) {
        throw new Error(
            `getMarginsOverlay: page ${pageIndex} not present in supplied pages`,
        );
    }

    const analysis = MarginFilter.collectMarginElements(
        pages,
        DEFAULT_MARGIN_ZONE,
    );
    const removal: MarginRemovalResult = MarginFilter.identifyElementsToRemove(
        analysis,
        3,
        true,
    );

    const rects: OverlayRect[] = [];
    let groupIdx = 0;

    // 1. Margin zones — drawn first so lines render on top
    const buildZoneRects = (
        margins: typeof DEFAULT_MARGIN_ZONE,
    ): Array<{ pos: MarginPosition; rect: Rect }> => [
        {
            pos: "top",
            rect: { x: 0, y: 0, w: targetPage.width, h: margins.top },
        },
        {
            pos: "bottom",
            rect: {
                x: 0,
                y: targetPage.height - margins.bottom,
                w: targetPage.width,
                h: margins.bottom,
            },
        },
        {
            pos: "left",
            rect: { x: 0, y: 0, w: margins.left, h: targetPage.height },
        },
        {
            pos: "right",
            rect: {
                x: targetPage.width - margins.right,
                y: 0,
                w: margins.right,
                h: targetPage.height,
            },
        },
    ];
    for (const z of buildZoneRects(DEFAULT_MARGIN_ZONE)) {
        rects.push({
            rect: z.rect,
            color: OVERLAY_COLORS.marginZone,
            label: `M-${z.pos}-zone`,
            group: groupIdx++,
        });
    }
    for (const z of buildZoneRects(DEFAULT_MARGINS)) {
        rects.push({
            rect: z.rect,
            color: OVERLAY_COLORS.marginZone,
            label: `M-${z.pos}-simple`,
            group: groupIdx++,
        });
    }

    // 2. Lines on this page that landed in a smart-margin zone (wider than
    //    the simple filter) — color by smart-removal outcome.
    let pageNumberCount = 0;
    let repeatCount = 0;
    let keptInZoneCount = 0;
    const pageRemovals = removal.removalsByPage.get(pageIndex) ?? new Set();

    // Build a lookup of which candidates apply to this page → reason, so
    // we can color page-number vs repeat differently. Candidates carry
    // pageIndices (so we can check membership per-line via normalized text).
    const reasonByText = new Map<string, "page_number" | "repeat">();
    for (const c of removal.candidates) {
        if (c.pageIndices.includes(pageIndex)) {
            reasonByText.set(c.text, c.reason);
        }
    }

    for (const block of targetPage.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const trimmed = (line.text || "").trim();
            if (!trimmed) continue;
            const zonePosition = MarginFilter.getMarginPosition(
                line.bbox,
                targetPage.width,
                targetPage.height,
                DEFAULT_MARGIN_ZONE,
            );
            if (!zonePosition) continue;

            const normalized = trimmed.toLowerCase();
            const reason = reasonByText.get(normalized);
            const willBeRemoved = pageRemovals.has(normalized);

            let color: string;
            let label: string;
            if (reason === "page_number") {
                color = OVERLAY_COLORS.marginCandidatePageNumber;
                label = `PN`;
                pageNumberCount++;
            } else if (reason === "repeat" || willBeRemoved) {
                color = OVERLAY_COLORS.marginCandidateRepeat;
                label = `R`;
                repeatCount++;
            } else {
                color = OVERLAY_COLORS.marginKeptInZone;
                label = `?`;
                keptInZoneCount++;
            }

            rects.push({
                rect: {
                    x: line.bbox.x,
                    y: line.bbox.y,
                    w: line.bbox.w,
                    h: line.bbox.h,
                },
                color,
                label,
                group: groupIdx++,
                marginPosition: zonePosition,
            });
        }
    }

    return {
        level: "margins",
        pageIndex: targetPage.pageIndex,
        pageWidth: targetPage.width,
        pageHeight: targetPage.height,
        groupCount: rects.length,
        rects,
        stats: {
            marginCandidates: removal.candidates.length,
            pageNumbers: pageNumberCount,
            repeats: repeatCount,
            keptInMargin: keptInZoneCount,
            analysisPagesScanned: pages.length,
        },
    };
}
