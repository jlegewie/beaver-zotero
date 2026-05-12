/**
 * Extraction Overlay — shared bbox source-of-truth.
 *
 * Computes per-level bounding-box overlays (columns / lines / paragraphs /
 * sentences / margins) for a single PDF page, returning plain rect data
 * in MuPDF top-left point coordinates. No DOM, no Zotero reader, no
 * annotations.
 *
 * Three consumers:
 *   1. `react/utils/extractionVisualizer.ts` — converts these rects into
 *      Zotero annotations on the live reader.
 *   2. `react/hooks/useHttpEndpoints.ts` (`/beaver/test/pdf-render-overlay`)
 *      — passes them to `canvasOverlay.ts` to draw on a rendered page PNG
 *      for headless agent debugging.
 *   3. `src/services/pdf/cli/commands/overlay.ts` — passes them to
 *      `node/overlayPng.ts` (sharp + SVG composite) for the CLI overlay
 *      command.
 *
 * Filter alignment: columns / lines / paragraphs / sentences all route
 * through `detectFilteredParagraphs`, so every overlay reflects what the
 * production sentence pipeline sees (cross-page smart margin removal,
 * document-wide style profile). `margins` deliberately skips that filter
 * — its purpose is to expose the pre-removal classification.
 *
 * Imports use direct module paths (not the `src/services/pdf/index.ts`
 * barrel) so this module can be safely consumed from the CLI without
 * pulling `MuPDFWorkerClient` into Node code.
 */
import { lineBBoxToRect } from "../LineDetector";
import { MarginFilter } from "../MarginFilter";
import { DEFAULT_MARGINS, DEFAULT_MARGIN_ZONE } from "../types";
import type { Rect } from "../ColumnDetector";
import type { SentenceBBox } from "../types";
import type {
    LayoutAnalysisResult,
    MarginPosition,
    ProcessedPage,
} from "../types";
import type { PageSentenceBBoxResult } from "../ParagraphSentenceMapper";

export type OverlayLevel =
    | "columns"
    | "lines"
    | "paragraphs"
    | "sentences"
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
     * Optional long-form text used as the annotation comment in the live
     * Zotero reader visualizer. Distinct from `label` (which is rendered on
     * the overlay PNG and kept short) so we can stash sentence text + address
     * info on the annotation without cluttering the headless overlay image.
     */
    annotationText?: string;
    /**
     * Group index — multiple rects with the same group form one logical
     * highlight (e.g. a sentence that wraps across two lines). Sequential
     * within a level, starting at 0.
     */
    group: number;
    /** True for fallback / degraded fallbacks (sentences only today). */
    degraded?: boolean;
    /**
     * Margin-zone classification (margins overlay only).
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
// Sentence builder — sister to the `build*FromTrace` builders below.
// Takes the production sentence result directly (without trace), which is
// what `/beaver/test/pdf-sentence-bboxes` and the trace overlay path both
// already have.
// ---------------------------------------------------------------------------

/**
 * Build a sentence overlay from a `PageSentenceBBoxResult`.
 *
 * Shared rect-construction loop used by the `ProcessedPage`-based
 * visualizer wrapper above and by fixture capture (which still needs
 * the trace-flavored result for splitter recording).
 *
 * `analysisPagesScanned` is the optional analysis-window-size diagnostic
 * stat surfaced on `stats.analysisPagesScanned`. Callers that have it
 * (fixture capture from the trace) pass it through; callers that don't
 * (the production-mode visualizer wrapper) omit it.
 */
export function buildSentenceOverlayFromResult(
    result: PageSentenceBBoxResult,
    analysisPagesScanned?: number,
): OverlayResult {
    const degradedItemIndices = new Set(
        (result.degradation?.notes ?? []).map((n) => n.itemIndex),
    );
    const degradedSentenceIndices = computeDegradedSentenceIndices(
        result.paragraphs,
        degradedItemIndices,
    );

    const rects: OverlayRect[] = [];
    let headingCount = 0;
    let bodyIdx = 0;
    result.sentences.forEach((sentence, sentenceIdx) => {
        if (sentence.bboxes.length === 0) return;
        const isDegraded = degradedSentenceIndices.has(sentenceIdx);
        const isHeading = sentence.kind === "heading";

        // Priority: degraded (gray) > heading (purple) > body (alternating).
        // Body sentences alternate using their own counter so a heading
        // sandwiched between two body sentences does not break the
        // pink/yellow alternation.
        let color: string;
        let label: string;
        if (isDegraded) {
            color = OVERLAY_COLORS.sentenceDegraded;
            label = `S${sentenceIdx + 1}`;
        } else if (isHeading) {
            headingCount++;
            color = OVERLAY_COLORS.header;
            label = `H${headingCount}`;
        } else {
            color = OVERLAY_COLORS.sentence[bodyIdx % OVERLAY_COLORS.sentence.length];
            label = `S${sentenceIdx + 1}`;
            bodyIdx++;
        }
        // Surface the continuation hint visually so heuristic mistakes are
        // obvious in the overlay PNG. Omitted ≡ false on SentenceBBox.
        if (sentence.joinWithNext) {
            label = `${label}↪`;
        }

        const joinTail = sentence.joinWithNext ? " ↪" : "";
        const annotationText =
            `page ${result.pageIndex + 1}, para ${sentence.paragraphIndex + 1}, s${sentence.sentenceIndex + 1}${joinTail}\n` +
            sentence.text;

        sentence.bboxes.forEach((bb, fragIdx) => {
            rects.push({
                rect: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
                color,
                // Only the first fragment carries the label so the overlay
                // isn't visually noisy on multi-line sentences/headings.
                label: fragIdx === 0 ? label : undefined,
                annotationText: fragIdx === 0 ? annotationText : undefined,
                group: sentenceIdx,
                degraded: isDegraded,
            });
        });
    });

    return {
        level: "sentences",
        pageIndex: result.pageIndex,
        pageWidth: result.width,
        pageHeight: result.height,
        groupCount: result.sentences.length,
        rects,
        stats: {
            sentences: result.sentences.length,
            headings: headingCount,
            paragraphs: result.paragraphs.length,
            degradation: result.degradation?.count ?? 0,
            analysisPagesScanned,
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
    for (const [paragraphIdx, pws] of paragraphs.entries()) {
        if (
            degradedItemIndices.has(paragraphIdx) &&
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
// Pure builders — consume `ProcessedPage` from a structured-mode extract
// (`extract({ mode: "structured", pageIndices: [n] })`). What the visualizer
// paints is byte-identical to what production produces for that page.
//
// `margins` is built by `buildMarginsOverlayFromAnalysis` (further below),
// which consumes a `LayoutAnalysisResult` from `analyzeLayout`. Same
// shared analysis prefix structured extract uses, so the margin
// candidates / removal decisions are byte-identical to what production
// extract sees pre-filter.
// ---------------------------------------------------------------------------

/**
 * Column overlay from a structured-mode `ProcessedPage`. Reads
 * `page.columns` (`ColumnBBox[]`, `{l,t,r,b}`) and converts to the
 * `Rect` shape (`{x,y,w,h}`) the overlay uses.
 */
export function buildColumnOverlayFromPage(page: ProcessedPage): OverlayResult {
    const columns = page.columns ?? [];
    const rects: OverlayRect[] = columns.map((col, i) => ({
        rect: { x: col.l, y: col.t, w: col.r - col.l, h: col.b - col.t },
        color: OVERLAY_COLORS.column,
        label: `C${i + 1}`,
        group: i,
    }));
    return {
        level: "columns",
        pageIndex: page.index,
        pageWidth: page.width,
        pageHeight: page.height,
        groupCount: rects.length,
        rects,
        stats: {
            columns: rects.length,
        },
    };
}

/**
 * Line overlay from a structured-mode `ProcessedPage`. Reads `page.lines`
 * (flat `ExtractedLine[]` already in reading order; column grouping
 * survives via `columnIndex`).
 */
export function buildLineOverlayFromPage(page: ProcessedPage): OverlayResult {
    const lines = page.lines ?? [];
    const rects: OverlayRect[] = lines.map((line, i) => ({
        rect: lineBBoxToRect(line.bbox),
        color: OVERLAY_COLORS.line,
        label: `L${i + 1}`,
        group: i,
    }));
    const distinctColumns = new Set(lines.map((l) => l.columnIndex)).size;
    return {
        level: "lines",
        pageIndex: page.index,
        pageWidth: page.width,
        pageHeight: page.height,
        groupCount: rects.length,
        rects,
        stats: {
            lines: rects.length,
            columns: distinctColumns,
        },
    };
}

/**
 * Paragraph overlay from a structured-mode `ProcessedPage`. Reads
 * `page.paragraphs[i].item` (the `ContentItem` carrying `type` /
 * `bbox` / `idx`).
 */
export function buildParagraphOverlayFromPage(
    page: ProcessedPage,
): OverlayResult {
    const paragraphs = page.paragraphs ?? [];
    let headerCount = 0;
    let bodyCount = 0;
    const rects: OverlayRect[] = paragraphs.map((pws, i) => {
        const item = pws.item;
        const isHeader = item.type === "header";
        if (isHeader) headerCount++;
        else bodyCount++;
        return {
            rect: {
                x: item.bbox.l,
                y: item.bbox.t,
                w: item.bbox.width,
                h: item.bbox.height,
            },
            color: isHeader ? OVERLAY_COLORS.header : OVERLAY_COLORS.paragraph,
            label: `${isHeader ? "H" : "P"}${item.idx + 1}`,
            group: i,
        };
    });
    return {
        level: "paragraphs",
        pageIndex: page.index,
        pageWidth: page.width,
        pageHeight: page.height,
        groupCount: rects.length,
        rects,
        stats: {
            paragraphs: bodyCount,
            headers: headerCount,
        },
    };
}

/**
 * Sentence overlay from a structured-mode `ProcessedPage`. Thin wrapper
 * over `buildSentenceOverlayFromResult`.
 */
export function buildSentenceOverlayFromPage(page: ProcessedPage): OverlayResult {
    const projected: PageSentenceBBoxResult = {
        pageIndex: page.index,
        width: page.width,
        height: page.height,
        paragraphs: page.paragraphs ?? [],
        sentences: page.sentences ?? [],
        degradation: page.degradation,
    };
    return buildSentenceOverlayFromResult(projected);
}

/**
 * Margins overlay from a `LayoutAnalysisResult`. Reads
 * `result.analysis.marginRemoval` for the per-page removal map +
 * cross-page candidate list, and looks the target page up in
 * `result.pages` for blocks/lines + dimensions. The
 * simple-margin / smart-zone box outlines and per-line classification
 * read `margins` / `marginZone` from `result.metadata.settings` so
 * custom settings flow through to the rendered overlay (defaults apply
 * only when the field is unset).
 *
 * `pageIndex` selects which target page (analyzeLayout returns
 * multi-page; the overlay is single-page).
 *
 * Output is byte-identical to the prior trace-based builder when
 * `analyzeLayout` runs with default settings — the structured-extract
 * analysis context build is the source of truth for both. With custom
 * settings, this builder draws/classifies against the actual settings
 * the analysis used (the prior builder hard-coded defaults and would
 * have silently mismatched).
 */
export function buildMarginsOverlayFromAnalysis(
    result: LayoutAnalysisResult,
    pageIndex: number,
): OverlayResult {
    const targetPage = result.pages.find((p) => p.pageIndex === pageIndex);
    if (!targetPage) {
        throw new Error(
            `buildMarginsOverlayFromAnalysis: page ${pageIndex} not present in result.pages`,
        );
    }
    const removal = result.analysis.marginRemoval;
    const margins = result.metadata.settings.margins ?? DEFAULT_MARGINS;
    const marginZone = result.metadata.settings.marginZone ?? DEFAULT_MARGIN_ZONE;

    const rects: OverlayRect[] = [];
    let groupIdx = 0;

    // Margin zones — drawn first so lines render on top.
    const buildZoneRects = (
        m: typeof DEFAULT_MARGIN_ZONE,
    ): Array<{ pos: MarginPosition; rect: Rect }> => [
        {
            pos: "top",
            rect: { x: 0, y: 0, w: targetPage.width, h: m.top },
        },
        {
            pos: "bottom",
            rect: {
                x: 0,
                y: targetPage.height - m.bottom,
                w: targetPage.width,
                h: m.bottom,
            },
        },
        {
            pos: "left",
            rect: { x: 0, y: 0, w: m.left, h: targetPage.height },
        },
        {
            pos: "right",
            rect: {
                x: targetPage.width - m.right,
                y: 0,
                w: m.right,
                h: targetPage.height,
            },
        },
    ];
    for (const z of buildZoneRects(marginZone)) {
        rects.push({
            rect: z.rect,
            color: OVERLAY_COLORS.marginZone,
            label: `M-${z.pos}-zone`,
            group: groupIdx++,
        });
    }
    for (const z of buildZoneRects(margins)) {
        rects.push({
            rect: z.rect,
            color: OVERLAY_COLORS.marginZone,
            label: `M-${z.pos}-simple`,
            group: groupIdx++,
        });
    }

    // Lines on this page that landed in a smart-margin zone — color by
    // smart-removal outcome. Also paint off-margin page-number drops so
    // the overlay reflects what production drops (those lines fall
    // outside every margin zone but are dropped via cross-page sequence
    // detection — without this branch they'd render as plain body).
    let pageNumberCount = 0;
    let repeatCount = 0;
    let keptInZoneCount = 0;
    const pageRemovals = removal.removalsByPage.get(pageIndex) ?? new Set();
    const offMarginPageNumbers =
        removal.offMarginPageNumberRemovals.get(pageIndex) ?? [];
    // Same floating-point tolerance the production filter uses.
    const BBOX_EQ_TOL_PT = 1.5;
    const bboxApproxEq = (a: { x: number; y: number; w: number; h: number },
                          b: { x: number; y: number; w: number; h: number }): boolean =>
        Math.abs(a.x - b.x) <= BBOX_EQ_TOL_PT
        && Math.abs(a.y - b.y) <= BBOX_EQ_TOL_PT
        && Math.abs(a.w - b.w) <= BBOX_EQ_TOL_PT
        && Math.abs(a.h - b.h) <= BBOX_EQ_TOL_PT;

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
                marginZone,
            );
            const normalized = trimmed.toLowerCase();
            const isOffMarginPageNumber = !zonePosition
                && offMarginPageNumbers.some(
                    (entry) => entry.text === normalized
                        && bboxApproxEq(entry.bbox, line.bbox),
                );
            if (!zonePosition && !isOffMarginPageNumber) continue;

            const reason = reasonByText.get(normalized);
            const willBeRemoved = pageRemovals.has(normalized);

            let color: string;
            let label: string;
            if (reason === "page_number" || isOffMarginPageNumber) {
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
            analysisPagesScanned: result.analysisPageIndices.length,
        },
    };
}
