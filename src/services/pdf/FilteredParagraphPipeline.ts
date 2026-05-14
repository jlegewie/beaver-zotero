/**
 * Filtered Paragraph Pipeline — shared "filter + detect" helper for the
 * sentence/paragraph extraction stack.
 *
 * Worker-safe: imports only sibling PDF modules — never the
 * `src/services/pdf/index.ts` barrel (`worker/ops.ts:15` forbids the
 * barrel inside the worker).
 */

import { MarginFilter } from "./MarginFilter";
import { detectColumns, type ColumnDetectionResult } from "./ColumnDetector";
import { detectLinesOnPage, type PageLineResult } from "./LineDetector";
import {
    detectParagraphs,
    type PageParagraphResult,
    type ParagraphDetectionSettings,
} from "./ParagraphDetector";
import {
    DEFAULT_MARGINS,
    DEFAULT_MARGIN_ZONE,
    bboxFromXYWH,
    bboxHeight,
    bboxWidth,
    type MarginItem,
    type MarginRemovalResult,
    type MarginSettings,
    type RawPageData,
    type RawLine,
    type StyleProfile,
} from "./types";
import { buildPageAnalysisContext } from "./PageAnalysisContext";
import {
    detectDominantTextOrientation,
    inverseRotateBBox,
    rotateBBox,
    rotateRawPage,
    type RotationAngle,
} from "./PageRotationNormalizer";

export interface FilteredParagraphContext {
    /**
     * Pages that participate in cross-page analysis (margin smart
     * removal, document-wide style profile). The caller is responsible
     * for resolving the analysis window — typically via
     * `resolveAnalysisPages` in `AnalysisWindow.ts`.
     */
    pages: RawPageData[];
    /**
     * The **document** page index of the target page (matches
     * `RawPageData.pageIndex`, NOT the position of the page within
     * `pages[]`). The helper finds the target via
     * `pages.find(p => p.pageIndex === pageIndex)`.
     */
    pageIndex: number;
    /**
     * Pre-computed cross-page smart-removal result. If omitted, the
     * helper computes it from `pages` using `marginZone` and the
     * threshold/sequence options below.
     */
    marginRemoval?: MarginRemovalResult;
    /**
     * Pre-computed document-wide style profile. If omitted, the helper
     * computes it from `pages` (StyleAnalyzer with default thresholds).
     */
    styleProfile?: StyleProfile;
    /** Simple margin thresholds for `filterPageWithSmartRemoval`. */
    margins?: MarginSettings;
    /** Wider margin zone for smart-removal candidate collection. */
    marginZone?: MarginSettings;
    /** Minimum pages a text must appear on to be flagged as repeating. */
    repeatThreshold?: number;
    /**
     * Total number of pages in the source document. Used to decide whether
     * the document is short for the adaptive repeat-threshold relaxation.
     * If omitted, `pages.length` is used as a proxy — pass this when the
     * analysis window is a subset of a longer document.
     */
    totalPageCount?: number;
    /** Whether to detect ascending page-number sequences in margins. */
    detectPageSequences?: boolean;
    /** Forwarded to `detectParagraphs`. */
    paragraphSettings?: ParagraphDetectionSettings;
    /**
     * Bounding boxes of background-shaded display elements on the target
     * page (see `ColumnDetectionOptions.fillBoundaries`). When supplied,
     * `ColumnDetector` refuses to fuse text blocks across fill-zone
     * boundaries. Optional — caller is responsible for collecting +
     * filtering via `extractFilledRectsFromDoc` + `filterToContainerRects`
     * upstream. Empty / absent = no behavior change.
     */
    fillBoundaries?: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
}

/**
 * Per-phase timings emitted by `detectFilteredParagraphs`. All values
 * are `performance.now()` deltas in milliseconds. Populated whether or
 * not the caller pre-supplied `marginRemoval` / `styleProfile`; the
 * `analysisContextMs` field carries the cost of the auto-compute path
 * (zero when both overrides are supplied).
 */
export interface FilteredParagraphTimings {
    /** `buildPageAnalysisContext` when invoked internally (else 0). */
    analysisContextMs: number;
    /** Rotation detect + `rotateRawPage`. */
    rotationMs: number;
    /** `MarginFilter.filterPageWithSmartRemoval`. */
    marginFilterMs: number;
    /** `detectColumns`. */
    columnDetectMs: number;
    /** `detectLinesOnPage` (0 when no columns were found). */
    lineDetectMs: number;
    /** `detectParagraphs` (0 when no columns / no lines). */
    paragraphDetectMs: number;
}

export interface FilteredParagraphResult {
    /**
     * Paragraph detection result with `itemLines` populated, ready to
     * pass to `extractPageSentences` as
     * `precomputed: { paragraphResult }`.
     */
    paragraphResult: PageParagraphResult;
    /** Target page after simple + smart margin filtering. */
    filteredPage: RawPageData;
    /** Cross-page smart-removal result (echoed for downstream use). */
    marginRemoval: MarginRemovalResult;
    /** Document-wide style profile (echoed for downstream use). */
    styleProfile: StyleProfile;
    /** Column detection on the filtered page. */
    columnResult: ColumnDetectionResult;
    /** Line detection on the filtered page. */
    lineResult: PageLineResult;
    /**
     * Text lines removed by simple/smart margin filtering, represented as
     * first-class document items. These are intentionally not fed into
     * paragraph detection, markdown content, or sentence splitting; callers
     * append them to `ProcessedPage.items` so consumers can inspect or filter
     * marginalia explicitly.
     */
    marginItems: MarginItem[];
    /**
     * Rotation applied to the target page before column / paragraph
     * detection (0 = no rotation; pipeline ran in MuPDF frame).
     *
     * Detected per-target-page from the dominant text writing
     * direction. When non-zero, every emitted bbox in
     * `paragraphResult` / `columnResult` / `lineResult` is in the
     * **upright working frame** (`width`/`height` swapped for 90/270).
     * Downstream emit sites must inverse-rotate using `sourceWidth` /
     * `sourceHeight` so consumers see MuPDF coords.
     *
     * The sentence mapper reads this off `precomputed` to normalize
     * its detailed page input symmetrically before
     * `buildDetailedLineLookup`.
     */
    pageRotation: RotationAngle;
    /** Original MuPDF dims (only meaningful when `pageRotation !== 0`). */
    sourceWidth: number;
    /** Original MuPDF dims (only meaningful when `pageRotation !== 0`). */
    sourceHeight: number;
    /**
     * Phase timings for the filtered-paragraph pipeline. Populated on
     * every call so downstream profilers can sum sub-phases without
     * conditional logic.
     */
    timings: FilteredParagraphTimings;
}

/**
 * Run the filtered paragraph pipeline for a single target page.
 *
 * Throws when `ctx.pageIndex` is not present in `ctx.pages`. Empty/no-
 * column pages return a well-formed `paragraphResult` with empty
 * `items` and `itemLines` arrays — callers can pass it as `precomputed`
 * to the sentence mapper without special-casing.
 *
 * Rotation handling: when the target page's dominant text orientation
 * is non-zero, the target is rotated into an upright working frame
 * **before** margin filtering / column / paragraph detection. The
 * analysis-window pages stay in raw MuPDF frame (only their text and
 * font signals feed `marginRemoval` / `styleProfile`, both of which
 * are frame-agnostic). The result echoes `pageRotation` /
 * `sourceWidth` / `sourceHeight` so emit sites can inverse-rotate
 * outputs back to MuPDF coords.
 */
export function detectFilteredParagraphs(
    ctx: FilteredParagraphContext,
): FilteredParagraphResult {
    const rawTargetPage = ctx.pages.find((p) => p.pageIndex === ctx.pageIndex);
    if (!rawTargetPage) {
        throw new Error(
            `detectFilteredParagraphs: page_index ${ctx.pageIndex} not present in supplied pages`,
        );
    }

    const margins = ctx.margins ?? DEFAULT_MARGINS;
    const marginZone = ctx.marginZone ?? DEFAULT_MARGIN_ZONE;

    // Compute defaults for any missing overrides via the shared
    // PageAnalysisContext helper so extract and the sentence pipeline
    // produce identical styleProfile / marginRemoval values when fed
    // the same analysis pages. Skipped when both overrides are
    // supplied (trace mode pre-computes them upstream).
    //
    // Frame rule: `marginRemoval` and `styleProfile` are text/font-
    // based (not geometric) and stay frame-agnostic. They are always
    // computed from the raw analysis-window pages, before any
    // rotation normalization. The geometric `MarginFilter` /
    // `ColumnDetector` consume the (possibly rotated) target page.
    let styleProfile = ctx.styleProfile;
    let marginRemoval = ctx.marginRemoval;
    let analysisContextMs = 0;
    if (!styleProfile || !marginRemoval) {
        const tAnalysis = performance.now();
        const computed = buildPageAnalysisContext({
            pages: ctx.pages,
            totalPageCount: ctx.totalPageCount ?? ctx.pages.length,
            marginZone,
            repeatThreshold: ctx.repeatThreshold,
            detectPageSequences: ctx.detectPageSequences,
        });
        analysisContextMs = performance.now() - tAnalysis;
        styleProfile = styleProfile ?? computed.styleProfile;
        marginRemoval = marginRemoval ?? computed.marginRemoval;
    }

    // Detect dominant text orientation on the raw target page and
    // rotate into the upright working frame if needed. Detection runs
    // against the raw bboxes so the marginZone exclusion uses the
    // original page geometry.
    const tRotation = performance.now();
    const pageRotation = detectDominantTextOrientation(rawTargetPage, marginZone);
    const rotated = rotateRawPage(rawTargetPage, pageRotation);
    const targetPage = rotated.page;
    const rotationMs = performance.now() - tRotation;

    const tMarginFilter = performance.now();
    const filteredPage = MarginFilter.filterPageWithSmartRemoval(
        targetPage,
        margins,
        marginZone,
        marginRemoval,
        styleProfile.bodyStyles,
        styleProfile.primaryBodyStyle,
    );
    const marginFilterMs = performance.now() - tMarginFilter;
    const uprightMarginItems = collectMarginItemsFromFilteredPage(
        targetPage,
        filteredPage,
    );
    const marginItems =
        pageRotation === 0
            ? uprightMarginItems
            : uprightMarginItems.map((item) => ({
                  ...item,
                  bbox: inverseRotateBBox(
                      item.bbox,
                      pageRotation,
                      rotated.sourceWidth,
                      rotated.sourceHeight,
                  ),
                  lines: item.lines.map((line) => ({
                      ...line,
                      bbox: inverseRotateBBox(
                          line.bbox,
                          pageRotation,
                          rotated.sourceWidth,
                          rotated.sourceHeight,
                      ),
                  })),
              }));

    // Frame rule: `ctx.fillBoundaries` come from the page content
    // stream in raw MuPDF coordinates, but `filteredPage` (and its
    // text bboxes) are in the upright working frame. Apply the same
    // rotation to the fill rects so `ColumnDetector`'s zone guard
    // compares text and fill rects in the same coordinate frame. On
    // unrotated pages this is a no-op (rotateBBox short-circuits when
    // `rotation === 0`).
    const fillBoundaries =
        ctx.fillBoundaries && ctx.fillBoundaries.length > 0
            ? ctx.fillBoundaries.map((b) =>
                  {
                      const rotatedBox = rotateBBox(
                          bboxFromXYWH(b.x, b.y, b.w, b.h, "top-left"),
                          pageRotation,
                          rotated.sourceWidth,
                          rotated.sourceHeight,
                      );
                      return {
                          x: rotatedBox.l,
                          y: rotatedBox.t,
                          w: bboxWidth(rotatedBox),
                          h: bboxHeight(rotatedBox),
                      };
                  },
              )
            : ctx.fillBoundaries;

    const tColumnDetect = performance.now();
    const columnResult = detectColumns(filteredPage, {
        headerMargin: margins.top,
        footerMargin: margins.bottom,
        bodyStyles: styleProfile.bodyStyles,
        fillBoundaries,
    });
    const columnDetectMs = performance.now() - tColumnDetect;

    let lineResult: PageLineResult;
    let paragraphResult: PageParagraphResult;
    let lineDetectMs = 0;
    let paragraphDetectMs = 0;

    if (columnResult.columns.length > 0) {
        const tLineDetect = performance.now();
        lineResult = detectLinesOnPage(filteredPage, columnResult.columns);
        lineDetectMs = performance.now() - tLineDetect;
        if (lineResult.allLines.length > 0) {
            const tParagraphDetect = performance.now();
            paragraphResult = detectParagraphs(
                lineResult,
                styleProfile.bodyStyles,
                ctx.paragraphSettings ?? {},
                { paragraph: 0, header: 0 },
                { trackItemLines: true },
            );
            paragraphDetectMs = performance.now() - tParagraphDetect;
        } else {
            paragraphResult = emptyParagraphResult(filteredPage);
        }
    } else {
        lineResult = {
            pageIndex: filteredPage.pageIndex,
            width: filteredPage.width,
            height: filteredPage.height,
            columnResults: [],
            allLines: [],
        };
        paragraphResult = emptyParagraphResult(filteredPage);
    }

    return {
        paragraphResult,
        filteredPage,
        marginRemoval,
        styleProfile,
        columnResult,
        lineResult,
        marginItems,
        pageRotation,
        sourceWidth: rotated.sourceWidth,
        sourceHeight: rotated.sourceHeight,
        timings: {
            analysisContextMs,
            rotationMs,
            marginFilterMs,
            columnDetectMs,
            lineDetectMs,
            paragraphDetectMs,
        },
    };
}

export function collectMarginItemsFromFilteredPage(
    originalPage: RawPageData,
    filteredPage: RawPageData,
): MarginItem[] {
    const keptLines = new Set<RawLine>();
    for (const block of filteredPage.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) keptLines.add(line);
    }

    const items: MarginItem[] = [];
    for (const block of originalPage.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const text = (line.text ?? "").trim();
            if (!text || keptLines.has(line)) continue;
            const index = items.length;
            items.push({
                kind: "margin",
                id: `p${originalPage.pageIndex}:i${index}`,
                pageIndex: originalPage.pageIndex,
                index,
                bbox: line.bbox,
                columnIndex: 0,
                text: line.text,
                lines: [
                    {
                        text: line.text,
                        bbox: line.bbox,
                        fontSize: line.font?.size,
                    },
                ],
            });
        }
    }
    return items;
}

export function reindexMarginItems(
    marginItems: readonly MarginItem[],
    startIndex: number,
): MarginItem[] {
    return marginItems.map((item, offset) => {
        const index = startIndex + offset;
        return {
            ...item,
            id: `p${item.pageIndex}:i${index}`,
            index,
        };
    });
}

function emptyParagraphResult(page: RawPageData): PageParagraphResult {
    return {
        pageIndex: page.pageIndex,
        width: page.width,
        height: page.height,
        pageContent: "",
        items: [],
        paragraphCount: 0,
        headerCount: 0,
        itemLines: [],
    };
}
