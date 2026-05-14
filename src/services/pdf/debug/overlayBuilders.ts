/**
 * Extraction Overlay — shared bbox source-of-truth.
 *
 * Computes per-level bounding-box overlays (columns / lines / items /
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
 * Filter alignment: columns / lines / items / sentences all route
 * through `detectFilteredParagraphs`, so every overlay reflects what the
 * production sentence pipeline sees (cross-page smart margin removal,
 * document-wide style profile). `margins` deliberately skips that filter
 * — its purpose is to expose the pre-removal classification.
 *
 * Imports use direct module paths (not the `src/services/pdf/index.ts`
 * barrel) so this module can be safely consumed from the CLI without
 * pulling `MuPDFWorkerClient` into Node code.
 */
import { MarginFilter } from "../MarginFilter";
import { bboxFromXYWH, DEFAULT_MARGINS, DEFAULT_MARGIN_ZONE } from "../types";
import type {
    BoundingBox,
    DocItem,
    LayoutAnalysisResult,
    MarginPosition,
    ProcessedPage,
    SentenceItem,
} from "../types";
import type { PageSentenceResult } from "../ParagraphSentenceMapper";

export type OverlayLevel =
    | "columns"
    | "lines"
    | "items"
    | "sentences"
    | "margins";

// Color palette — kept in one place so the visualizer and the canvas
// overlay agree on what each level looks like.
export const OVERLAY_COLORS = {
    column: "#00bbff",
    line: "#ff9500",
    itemText: "#34c759",
    itemSectionHeader: "#af52de",
    itemFootnote: "#5ac8fa",
    itemCaption: "#ff9500",
    itemList: "#30d158",
    itemMargin: "#d1d1d6",
    itemFormula: "#ff9f0a",
    itemTable: "#007aff",
    itemPicture: "#bf5af2",
    // Back-compat aliases for callers/tests that still talk in terms of
    // paragraph/header overlays.
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

const ITEM_KIND_STYLE: Record<DocItem["kind"], { color: string; prefix: string }> = {
    text: { color: OVERLAY_COLORS.itemText, prefix: "P" },
    section_header: { color: OVERLAY_COLORS.itemSectionHeader, prefix: "H" },
    footnote: { color: OVERLAY_COLORS.itemFootnote, prefix: "F" },
    caption: { color: OVERLAY_COLORS.itemCaption, prefix: "C" },
    list_item: { color: OVERLAY_COLORS.itemList, prefix: "L" },
    margin: { color: OVERLAY_COLORS.itemMargin, prefix: "G" },
    formula: { color: OVERLAY_COLORS.itemFormula, prefix: "M" },
    table: { color: OVERLAY_COLORS.itemTable, prefix: "T" },
    picture: { color: OVERLAY_COLORS.itemPicture, prefix: "I" },
};

function itemStyle(item: DocItem): { color: string; prefix: string } {
    return ITEM_KIND_STYLE[item.kind];
}

function itemText(item: DocItem): string {
    return "text" in item ? item.text : item.kind;
}

function itemSentences(item: DocItem): SentenceItem[] {
    return "sentences" in item ? item.sentences ?? [] : [];
}

function itemHasDrawableSentence(item: DocItem): boolean {
    return itemSentences(item).some((sentence) => sentence.bboxes.length > 0);
}

/**
 * One rectangle to draw on top of a rendered page.
 *
 * Coordinates are in MuPDF point space (top-left origin). Consumers are
 * responsible for converting to their own coordinate system (Zotero uses
 * bottom-left origin; canvas uses pixel space scaled from points).
 */
export interface OverlayRect {
    /** Bbox in MuPDF top-left point coordinates. */
    rect: BoundingBox;
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
    /** Number of logical groups (columns, lines, items, or sentences). */
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
 * Build a sentence overlay from a `PageSentenceResult`.
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
    result: PageSentenceResult,
    analysisPagesScanned?: number,
): OverlayResult {
    const degradedItemIds = new Set(
        (result.degradation?.notes ?? []).map((n) => n.itemId),
    );

    const rects: OverlayRect[] = [];
    let groupIdx = 0;
    let bodyIdx = 0;
    let sentenceLabelIdx = 0;
    const sentenceByParent = new Map<string, SentenceItem[]>();
    for (const sentence of result.sentences) {
        const list = sentenceByParent.get(sentence.parentId);
        if (list) list.push(sentence);
        else sentenceByParent.set(sentence.parentId, [sentence]);
    }

    for (const item of result.items) {
        const itemSentences = sentenceByParent.get(item.id) ?? [];
        if (itemSentences.some((sentence) => sentence.bboxes.length > 0)) {
            for (const sentence of itemSentences) {
                if (sentence.bboxes.length === 0) continue;
                const isDegraded = degradedItemIds.has(sentence.parentId);

                let color: string;
                let label: string;
                if (isDegraded) {
                    color = OVERLAY_COLORS.sentenceDegraded;
                    label = `S${sentenceLabelIdx + 1}`;
                } else {
                    color = OVERLAY_COLORS.sentence[bodyIdx % OVERLAY_COLORS.sentence.length];
                    label = `S${sentenceLabelIdx + 1}`;
                    bodyIdx++;
                }
                sentenceLabelIdx++;
                // Surface the continuation hint visually so heuristic mistakes are
                // obvious in the overlay PNG. Omitted means false on SentenceItem.
                if (sentence.joinWithNext) {
                    label = `${label}↪`;
                }

                const joinTail = sentence.joinWithNext ? " ↪" : "";
                const annotationText =
                    `page ${result.pageIndex + 1}, item ${sentence.parentId}, s${sentence.index + 1}${joinTail}\n` +
                    sentence.text;

                sentence.bboxes.forEach((bb, fragIdx) => {
                    rects.push({
                        rect: bb,
                        color,
                        // Only the first fragment carries the label so the overlay
                        // isn't visually noisy on multi-line sentences.
                        label: fragIdx === 0 ? label : undefined,
                        annotationText: fragIdx === 0 ? annotationText : undefined,
                        group: groupIdx,
                        degraded: isDegraded,
                    });
                });
                groupIdx++;
            }
            continue;
        }

        // Lowest-level overlay fallback: items that don't expose sentence
        // geometry (headers today; reserved unsplit kinds in future) still
        // need to be visible in the sentence view.
        const style = itemStyle(item);
        const label = `${style.prefix}${item.index + 1}`;
        rects.push({
            rect: item.bbox,
            color: style.color,
            label,
            annotationText:
                `page ${result.pageIndex + 1}, item ${item.id}, ${item.kind}\n` +
                itemText(item),
            group: groupIdx,
        });
        groupIdx++;
    }

    return {
        level: "sentences",
        pageIndex: result.pageIndex,
        pageWidth: result.width,
        pageHeight: result.height,
        groupCount: groupIdx,
        rects,
        stats: {
            sentences: result.sentences.length,
            headings: result.items.filter((item) => item.kind === "section_header").length,
            fallbackItems: result.items.filter((item) => !itemHasDrawableSentence(item)).length,
            paragraphs: result.items.filter((item) => item.kind === "text").length,
            degradation: result.degradation?.count ?? 0,
            analysisPagesScanned,
        },
    };
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
 * `page.columns` (`BoundingBox[]`, `{l,t,r,b,origin}`) and emits them in
 * the same top-left page frame used by production extraction.
 */
export function buildColumnOverlayFromPage(page: ProcessedPage): OverlayResult {
    const columns = page.columns;
    const rects: OverlayRect[] = columns.map((col, i) => ({
        rect: col,
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
 * Line overlay from a structured-mode `ProcessedPage`. Lines are flattened
 * from `page.items[].lines` in item reading order.
 */
export function buildLineOverlayFromPage(page: ProcessedPage): OverlayResult {
    const lines = page.items.flatMap((item) => ("lines" in item ? item.lines : []));
    const rects: OverlayRect[] = lines.map((line, i) => ({
        rect: line.bbox,
        color: OVERLAY_COLORS.line,
        label: `L${i + 1}`,
        group: i,
    }));
    const distinctColumns = new Set(page.items.map((item) => item.columnIndex)).size;
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
 * Item overlay from a structured-mode `ProcessedPage`.
 */
export function buildItemOverlayFromPage(
    page: ProcessedPage,
    kindFilter?: DocItem["kind"][],
): OverlayResult {
    const allowed = kindFilter ? new Set(kindFilter) : null;
    const items = allowed
        ? page.items.filter((item) => allowed.has(item.kind))
        : page.items;
    let headerCount = 0;
    let textCount = 0;
    const kindCounts: Partial<Record<DocItem["kind"], number>> = {};
    const rects: OverlayRect[] = items.map((item, i) => {
        const style = itemStyle(item);
        kindCounts[item.kind] = (kindCounts[item.kind] ?? 0) + 1;
        if (item.kind === "section_header") headerCount++;
        if (item.kind === "text") textCount++;
        return {
            rect: item.bbox,
            color: style.color,
            label: `${style.prefix}${item.index + 1}`,
            group: i,
        };
    });
    return {
        level: "items",
        pageIndex: page.index,
        pageWidth: page.width,
        pageHeight: page.height,
        groupCount: rects.length,
        rects,
        stats: {
            paragraphs: textCount,
            headers: headerCount,
            textItems: textCount,
            footnotes: kindCounts.footnote ?? 0,
            captions: kindCounts.caption ?? 0,
            listItems: kindCounts.list_item ?? 0,
            marginItems: kindCounts.margin ?? 0,
            formulas: kindCounts.formula ?? 0,
            tables: kindCounts.table ?? 0,
            pictures: kindCounts.picture ?? 0,
        },
    };
}

/**
 * Sentence overlay from a structured-mode `ProcessedPage`. Thin wrapper
 * over `buildSentenceOverlayFromResult`.
 */
export function buildSentenceOverlayFromPage(page: ProcessedPage): OverlayResult {
    const projected: PageSentenceResult = {
        pageIndex: page.index,
        width: page.width,
        height: page.height,
        items: page.items,
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
    ): Array<{ pos: MarginPosition; rect: BoundingBox }> => [
        {
            pos: "top",
            rect: bboxFromXYWH(0, 0, targetPage.width, m.top, "top-left"),
        },
        {
            pos: "bottom",
            rect: bboxFromXYWH(
                0,
                targetPage.height - m.bottom,
                targetPage.width,
                m.bottom,
                "top-left",
            ),
        },
        {
            pos: "left",
            rect: bboxFromXYWH(0, 0, m.left, targetPage.height, "top-left"),
        },
        {
            pos: "right",
            rect: bboxFromXYWH(
                targetPage.width - m.right,
                0,
                m.right,
                targetPage.height,
                "top-left",
            ),
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
    // smart-removal outcome.
    let pageNumberCount = 0;
    let repeatCount = 0;
    let keptInZoneCount = 0;
    const pageRemovals = removal.removalsByPage.get(pageIndex) ?? new Set();

    const reasonByText = new Map<string, "page_number" | "repeat" | "identifier">();
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
            } else if (reason === "repeat" || reason === "identifier" || willBeRemoved) {
                color = OVERLAY_COLORS.marginCandidateRepeat;
                label = `R`;
                repeatCount++;
            } else {
                color = OVERLAY_COLORS.marginKeptInZone;
                label = `?`;
                keptInZoneCount++;
            }

            rects.push({
                rect: line.bbox,
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
