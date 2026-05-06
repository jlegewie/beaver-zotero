/**
 * Extraction Overlay — shared bbox source-of-truth.
 *
 * Computes per-level bounding-box overlays (columns / lines / paragraphs /
 * sentences / raw-lines / margins) for a single PDF page, returning plain
 * rect data in MuPDF top-left point coordinates. No DOM, no Zotero reader,
 * no annotations.
 *
 * Two consumers:
 *   1. `extractionVisualizer.ts` — converts these rects into Zotero
 *      annotations on the live reader.
 *   2. `useHttpEndpoints.ts` (`/beaver/test/pdf-render-overlay`) — passes
 *      them to `canvasOverlay.ts` to draw on a rendered page PNG for
 *      headless agent debugging.
 *
 * Filter alignment: columns / lines / paragraphs / sentences all route
 * through `detectFilteredParagraphs`, so every overlay reflects what the
 * production sentence pipeline sees (cross-page smart margin removal,
 * document-wide style profile). `raw-lines` and `margins` deliberately
 * skip that filter — their purpose is to expose pre-filter state.
 */
import {
    detectFilteredParagraphs,
    extractPageSentenceBBoxes,
    lineBBoxToRect,
    MarginFilter,
    getEffectiveRepeatThreshold,
    pagesForFilterWithBridgedFonts,
    DEFAULT_MARGINS,
    DEFAULT_MARGIN_ZONE,
    Rect,
    RawPageData,
    RawPageDataDetailed,
    SentenceBBox,
} from "../../src/services/pdf";
import type {
    SentenceSplitter,
    MarginPosition,
    MarginRemovalResult,
    PageSentenceBBoxResult,
} from "../../src/services/pdf";

export type OverlayLevel =
    | "columns"
    | "lines"
    | "paragraphs"
    | "sentences"
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
 * Substitute the detailed target page into the analysis window before
 * paragraph detection runs, AND bridge real font metadata onto the
 * detailed page (the wasm font binding leaves detailed-walk lines with
 * empty `font.{name, family, weight, style}`, which silently disables
 * heading detection on the target page). `runSentenceExtractionPipeline`
 * does the same thing.
 *
 * If `detailedTargetPage` is omitted, falls through to the raw target
 * page already in `pages` — overlays remain functional but no longer
 * guaranteed to mirror production exactly. Both call sites
 * (`useHttpEndpoints.ts` and `extractionVisualizer.ts`) supply it.
 */
export function pagesForFilter(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage?: RawPageDataDetailed,
): RawPageData[] {
    return pagesForFilterWithBridgedFonts(pages, pageIndex, detailedTargetPage);
}

/**
 * Column overlay: one rect per detected column, labelled C1..Cn in reading
 * order. Uses the smart cross-page filter via `detectFilteredParagraphs`,
 * so columns are detected on the same filtered page the production
 * sentence pipeline operates on. Pass `detailedTargetPage` for byte-exact
 * parity with production (see `pagesForFilter`).
 */
export function getColumnOverlay(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage?: RawPageDataDetailed,
    totalPageCount?: number,
): OverlayResult {
    const filtered = detectFilteredParagraphs({
        pages: pagesForFilter(pages, pageIndex, detailedTargetPage),
        pageIndex,
        totalPageCount,
    });
    const rects: OverlayRect[] = filtered.columnResult.columns.map((col, i) => ({
        rect: col,
        color: OVERLAY_COLORS.column,
        label: `C${i + 1}`,
        group: i,
    }));
    return {
        level: "columns",
        pageIndex: filtered.filteredPage.pageIndex,
        pageWidth: filtered.filteredPage.width,
        pageHeight: filtered.filteredPage.height,
        groupCount: rects.length,
        rects,
        stats: {
            columns: rects.length,
            broken: filtered.columnResult.isBroken ? 1 : 0,
            analysisPagesScanned: pages.length,
        },
    };
}

/**
 * Line overlay: one rect per detected line, labelled L1..Ln across all
 * columns. Built from `detectFilteredParagraphs.lineResult` so lines
 * reflect the smart cross-page filter (repeating watermarks/page numbers
 * removed) — same pipeline production sentence extraction uses. Pass
 * `detailedTargetPage` for byte-exact parity with production.
 */
export function getLineOverlay(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage?: RawPageDataDetailed,
    totalPageCount?: number,
): OverlayResult {
    const filtered = detectFilteredParagraphs({
        pages: pagesForFilter(pages, pageIndex, detailedTargetPage),
        pageIndex,
        totalPageCount,
    });
    const rects: OverlayRect[] = [];
    let groupCount = 0;
    for (const colResult of filtered.lineResult.columnResults) {
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
    return {
        level: "lines",
        pageIndex: filtered.filteredPage.pageIndex,
        pageWidth: filtered.filteredPage.width,
        pageHeight: filtered.filteredPage.height,
        groupCount,
        rects,
        stats: {
            lines: groupCount,
            columns: filtered.columnResult.columns.length,
            analysisPagesScanned: pages.length,
        },
    };
}

/**
 * Paragraph overlay: one rect per detected paragraph (green) or header
 * (purple). Built from `detectFilteredParagraphs.paragraphResult`, which
 * uses the document-wide style profile — header vs body classification
 * matches what production sentence extraction sees. Pass
 * `detailedTargetPage` for byte-exact parity with production.
 */
export function getParagraphOverlay(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage?: RawPageDataDetailed,
    totalPageCount?: number,
): OverlayResult {
    const filtered = detectFilteredParagraphs({
        pages: pagesForFilter(pages, pageIndex, detailedTargetPage),
        pageIndex,
        totalPageCount,
    });
    const rects: OverlayRect[] = filtered.paragraphResult.items.map((item, i) => {
        const isHeader = item.type === "header";
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
        pageIndex: filtered.filteredPage.pageIndex,
        pageWidth: filtered.filteredPage.width,
        pageHeight: filtered.filteredPage.height,
        groupCount: rects.length,
        rects,
        stats: {
            paragraphs: filtered.paragraphResult.paragraphCount,
            headers: filtered.paragraphResult.headerCount,
            analysisPagesScanned: pages.length,
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
 *
 * **`joinWithNext` rendering**: a sentence with `joinWithNext: true` is a
 * producer hint that it continues into the next sentence in reading order
 * (typically across a column / page break). The overlay does NOT merge —
 * it appends a "↪" suffix to that sentence's label so the continuation
 * boundary is visually obvious during heuristic tuning. Downstream
 * consumers (citations, embeddings) are responsible for any actual merge.
 */
export function getSentenceOverlay(
    detailedPage: RawPageDataDetailed,
    pages: RawPageData[],
    splitter?: SentenceSplitter,
    totalPageCount?: number,
): OverlayResult {
    // Run paragraph detection on the *detailed* page so its line bboxes
    // exactly match what the sentence mapper will look up (same MuPDF
    // walk → identical bboxes).
    const filtered = detectFilteredParagraphs({
        pages: pagesForFilter(pages, detailedPage.pageIndex, detailedPage),
        pageIndex: detailedPage.pageIndex,
        totalPageCount,
    });
    const result = extractPageSentenceBBoxes(detailedPage, {
        splitter,
        precomputed: { paragraphResult: filtered.paragraphResult },
    });
    return buildSentenceOverlayFromResult(result, pages.length);
}

/**
 * Build a sentence overlay from an already-computed `PageSentenceBBoxResult`.
 *
 * Used by the `/beaver/test/pdf-render-overlay` endpoint to feed the result
 * from `runSentenceExtractionPipeline` (production orchestration) into the
 * shared rect-building loop. Same rect/color/label/group semantics as
 * `getSentenceOverlay`.
 */
export function buildSentenceOverlayFromResult(
    result: PageSentenceBBoxResult,
    analysisPagesScanned: number,
): OverlayResult {
    const degradedItemIndices = new Set(result.degradationNotes.map((n) => n.itemIndex));
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

        const annotationText =
            `page ${result.pageIndex + 1}, para ${sentence.paragraphIndex + 1}, s${sentence.sentenceIndex + 1}\n` +
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
            degradedParagraphs: result.degradedParagraphs,
            unmappedParagraphs: result.unmappedParagraphs,
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
    totalPageCount?: number,
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
        getEffectiveRepeatThreshold({
            totalPageCount,
            analysisPageCount: pages.length,
        }),
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
