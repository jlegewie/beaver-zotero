/**
 * Filtered Paragraph Pipeline — shared "filter + detect" helper for the
 * sentence/paragraph extraction stack.
 *
 * Worker-safe: imports only sibling PDF modules — never the
 * `src/beaver-extract/index.ts` barrel (`worker/ops.ts:15` forbids the
 * barrel inside the worker).
 */

import { MarginFilter } from "./MarginFilter";
import { StyleAnalyzer } from "./StyleAnalyzer";
import { detectColumns, logColumnDetection, type ColumnDetectionResult } from "./ColumnDetector";
import { detectLinesOnPage, logLineDetection, type PageLineResult } from "./LineDetector";
import {
    detectParagraphs,
    logParagraphDetection,
    type BoundaryCapture,
    type PageParagraphResult,
    type ParagraphDetectionSettings,
} from "./ParagraphDetector";
import { isAnalyzerLoggingEnabled } from "./logging";
import {
    DEFAULT_MARGINS,
    DEFAULT_MARGIN_ZONE,
    bboxFromXYWH,
    bboxHeight,
    bboxWidth,
    type BoundingBox,
    type MarginAnalysis,
    type MarginItem,
    type MarginRemovalResult,
    type MarginSettings,
    type RawPageData,
    type RawLine,
    type StyleProfile,
} from "@beaver/agent-core/extract/types";
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
    /** Match margin text rows rather than single lines (`ExtractionSettings.marginTextRows`). */
    marginTextRows?: boolean;
    /**
     * Keep the words of justified prose rows when filtering the target page
     * (`MarginFilter.filterPageWithSmartRemoval`'s `proseRows`). Follows
     * `marginTextRows` when omitted, and is off when both are.
     */
    marginProseRows?: boolean;
    /** Forwarded to `detectParagraphs`. */
    paragraphSettings?: ParagraphDetectionSettings;
    /**
     * The document's line-break vocabulary (`buildCompoundVocabulary`), for
     * joining item lines when `paragraphSettings.lineJoins` is on.
     */
    compoundVocabulary?: ReadonlySet<string>;
    /**
     * Bounding boxes of background-shaded display elements on the target
     * page (see `ColumnDetectionOptions.fillBoundaries`). When supplied,
     * `ColumnDetector` refuses to fuse text blocks across fill-zone
     * boundaries. Optional — caller is responsible for collecting via
     * `extractGraphicsFromDoc` and filtering with `filterToContainerRects`
     * upstream. Empty / absent = no behavior change.
     */
    fillBoundaries?: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
    /** Thin stroked layout dividers on the target page, in raw MuPDF frame. */
    dividerLines?: ReadonlyArray<{
        orientation: "horizontal" | "vertical";
        position: number;
        start: number;
        end: number;
        thickness: number;
    }>;
    /**
     * Regions (tables, figures, equations) whose lines were removed from the
     * target page, in raw MuPDF frame: the box and, for an equation, the boxes
     * of its lines. Each keeps the text above it apart from the text below it
     * in the reading frame; one spanning columns is read after the text above
     * it in every column, one within a column is read through
     * (`ColumnDetectionOptions.regionBarriers`).
     */
    regionBarriers?: ReadonlyArray<{ bbox: BoundingBox; content?: ReadonlyArray<BoundingBox> }>;
    /**
     * Dominant text orientation of the target page, when the caller detected
     * it before removing lines from the page (e.g. region text). Without it,
     * orientation is detected on the supplied page.
     */
    pageRotation?: RotationAngle;
    /**
     * Receives the item-boundary input of the target page; the region
     * barriers are its regions (training export only).
     */
    boundaries?: Pick<BoundaryCapture, "page">;
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
     * Paragraph detection result with `itemLines` populated, ready for
     * `draftItemsFromParagraphs` (the sentence mapper's input).
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
     * append them to `InternalProcessedPage.items` so consumers can inspect or filter
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
 * `items` and `itemLines` arrays — callers can make draft items of it
 * for the sentence mapper without special-casing.
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
            marginTextRows: ctx.marginTextRows,
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
    const pageRotation =
        ctx.pageRotation ?? detectDominantTextOrientation(rawTargetPage, marginZone);
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
        ctx.marginTextRows ?? true,
        ctx.marginProseRows ?? ctx.marginTextRows ?? false,
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
    const dividerLines =
        ctx.dividerLines && ctx.dividerLines.length > 0
            ? ctx.dividerLines.map((d) => {
                  const raw =
                      d.orientation === "horizontal"
                          ? bboxFromXYWH(
                                d.start,
                                d.position,
                                d.end - d.start,
                                0,
                                "top-left",
                            )
                          : bboxFromXYWH(
                                d.position,
                                d.start,
                                0,
                                d.end - d.start,
                                "top-left",
                            );
                  const rotatedBox = rotateBBox(
                      raw,
                      pageRotation,
                      rotated.sourceWidth,
                      rotated.sourceHeight,
                  );
                  const w = bboxWidth(rotatedBox);
                  const h = bboxHeight(rotatedBox);
                  if (w >= h) {
                      return {
                          orientation: "horizontal" as const,
                          position: (rotatedBox.t + rotatedBox.b) / 2,
                          start: Math.min(rotatedBox.l, rotatedBox.r),
                          end: Math.max(rotatedBox.l, rotatedBox.r),
                          thickness: d.thickness,
                      };
                  }
                  return {
                      orientation: "vertical" as const,
                      position: (rotatedBox.l + rotatedBox.r) / 2,
                      start: Math.min(rotatedBox.t, rotatedBox.b),
                      end: Math.max(rotatedBox.t, rotatedBox.b),
                      thickness: d.thickness,
                  };
              })
            : ctx.dividerLines;
    const uprightRect = (box: BoundingBox) => {
        const upright = rotateBBox(box, pageRotation, rotated.sourceWidth, rotated.sourceHeight);
        return { x: upright.l, y: upright.t, w: bboxWidth(upright), h: bboxHeight(upright) };
    };
    const regionBarriers = (ctx.regionBarriers ?? []).map((region) => ({
        box: uprightRect(region.bbox),
        ...(region.content ? { content: region.content.map(uprightRect) } : {}),
    }));

    const tColumnDetect = performance.now();
    const columnResult = detectColumns(filteredPage, {
        headerMargin: margins.top,
        footerMargin: margins.bottom,
        bodyStyles: styleProfile.bodyStyles,
        fillBoundaries,
        dividerLines,
        regionBarriers,
        debug: isAnalyzerLoggingEnabled(),
    });
    const columnDetectMs = performance.now() - tColumnDetect;
    logColumnDetection(filteredPage.pageIndex, columnResult);

    let lineResult: PageLineResult;
    let paragraphResult: PageParagraphResult;
    let lineDetectMs = 0;
    let paragraphDetectMs = 0;

    if (columnResult.columns.length > 0) {
        const tLineDetect = performance.now();
        lineResult = detectLinesOnPage(filteredPage, columnResult.columns, {
            exclusiveColumns: ctx.paragraphSettings?.exclusiveColumnLines ?? false,
            textRotation: pageRotation,
        });
        lineDetectMs = performance.now() - tLineDetect;
        logLineDetection(lineResult);
        if (lineResult.allLines.length > 0) {
            const tParagraphDetect = performance.now();
            paragraphResult = detectParagraphs(
                lineResult,
                styleProfile.bodyStyles,
                ctx.compoundVocabulary
                    ? { ...ctx.paragraphSettings, lineJoinVocabulary: ctx.compoundVocabulary }
                    : ctx.paragraphSettings ?? {},
                { paragraph: 0, header: 0 },
                {
                    trackItemLines: true,
                    ...(ctx.boundaries
                        ? {
                              boundaries: {
                                  regions: regionBarriers.map(({ box }): [number, number, number, number] => [
                                      box.x,
                                      box.y,
                                      box.x + box.w,
                                      box.y + box.h,
                                  ]),
                                  page: ctx.boundaries.page,
                              },
                          }
                        : {}),
                },
            );
            paragraphDetectMs = performance.now() - tParagraphDetect;
            logParagraphDetection(paragraphResult);
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

/**
 * Lines of a page that margin filtering removes from the prose in the page's top and
 * bottom margin bands (running headers and footers, page numbers, margin
 * identifiers), as `detectFilteredParagraphs` filters them: in the page's upright
 * working frame, with the document's smart-removal result. Side margins are left
 * out: a full-width figure's panel letters repeat there from page to page. The
 * lines returned are the page's own.
 */
export function marginFilteredLines(
    page: RawPageData,
    ctx: {
        marginRemoval: MarginRemovalResult;
        styleProfile: StyleProfile;
        margins?: MarginSettings;
        marginZone?: MarginSettings;
        /** Must match the setting `marginRemoval` was computed with. */
        marginTextRows?: boolean;
        pageRotation: RotationAngle;
    },
): Set<RawLine> {
    const rotated = rotateRawPage(page, ctx.pageRotation).page;
    const filtered = MarginFilter.filterPageWithSmartRemoval(
        rotated,
        ctx.margins ?? DEFAULT_MARGINS,
        ctx.marginZone ?? DEFAULT_MARGIN_ZONE,
        ctx.marginRemoval,
        ctx.styleProfile.bodyStyles,
        ctx.styleProfile.primaryBodyStyle,
        ctx.marginTextRows ?? true,
        ctx.marginTextRows ?? false,
    );
    const marginZone = ctx.marginZone ?? DEFAULT_MARGIN_ZONE;
    const kept = new Set<RawLine>();
    for (const block of filtered.blocks) {
        if (block.type === "text") for (const line of block.lines ?? []) kept.add(line);
    }
    for (const block of rotated.blocks) {
        if (block.type !== "text") continue;
        for (const line of block.lines ?? []) {
            const position = MarginFilter.getMarginPosition(line.bbox, rotated.width, rotated.height, marginZone);
            if (position !== "top" && position !== "bottom") kept.add(line);
        }
    }
    // Rotation copies lines in order, block by block.
    const removed = new Set<RawLine>();
    page.blocks.forEach((block, b) => {
        if (block.type !== "text") return;
        const turned = rotated.blocks[b].lines ?? [];
        (block.lines ?? []).forEach((line, k) => {
            if (!kept.has(turned[k])) removed.add(line);
        });
    });
    return removed;
}

/**
 * Running headers and footers that carry the page number (`Journal 2024 № 7 41`,
 * `Smith et al. — page 12`): lines in the top or bottom margin zone whose text,
 * spaces dropped, repeats on at least `repeat` pages of `analysis` with only its
 * numbers changing, one of them stepping with the page index. Exact repeats and
 * bare page numbers are the margin filter's; a header numbered page by page is
 * not one text for it. The lines returned are `page`'s.
 */
export function numberedRunningLines(page: RawPageData, analysis: MarginAnalysis, repeat: number, marginZone: MarginSettings = DEFAULT_MARGIN_ZONE): Set<RawLine> {
    const shape = (text: string) => {
        const compact = text.toLowerCase().replace(/\s+/gu, "");
        return { key: compact.replace(/\d+/gu, "#"), numbers: (compact.match(/\d+/gu) ?? []).map(Number) };
    };
    const found = new Set<RawLine>();
    for (const position of ["top", "bottom"] as const) {
        const byKey = new Map<string, { page: number; numbers: number[] }[]>();
        for (const el of analysis.elements.get(position) ?? []) {
            const { key, numbers } = shape(el.text);
            if (!numbers.length) continue;
            byKey.set(key, [...(byKey.get(key) ?? []), { page: el.pageIndex, numbers }]);
        }
        const numbered = new Set<string>();
        for (const [key, seen] of byKey) {
            const pages = new Map(seen.map((s) => [s.page, s.numbers]));
            if (pages.size < repeat) continue;
            const counts = [...pages.values()];
            if (counts.some((n) => n.length !== counts[0].length)) continue;
            const stepsWithPage = counts[0].some((_, k) => new Set([...pages].map(([p, n]) => n[k] - p)).size === 1);
            if (stepsWithPage) numbered.add(key);
        }
        if (!numbered.size) continue;
        for (const block of page.blocks) {
            if (block.type !== "text") continue;
            for (const line of block.lines ?? []) {
                if (!line.text.trim() || MarginFilter.getMarginPosition(line.bbox, page.width, page.height, marginZone) !== position) continue;
                if (numbered.has(shape(line.text).key)) found.add(line);
            }
        }
    }
    return found;
}

/** A line of body text holds at least this many words. */
const BODY_LINE_WORDS = 4;

/** Pages of one size share a body extent (`documentBodyExtents`). */
export function pageSizeKey(page: { width: number; height: number }): string {
    return `${Math.round(page.width)}x${Math.round(page.height)}`;
}

/**
 * Where a document's body text starts and ends down its pages, per page size
 * (`pageSizeKey`): the highest top and the lowest bottom of its lines of body text (in a
 * body style, a line of words, not margin text) on any page of that size. Running
 * headers and footers stand outside it on every page; a figure or table set at the top
 * or foot of a page stands inside it.
 */
export function documentBodyExtents(
    pages: readonly RawPageData[],
    ctx: { marginRemoval: MarginRemovalResult; styleProfile: StyleProfile; margins?: MarginSettings; marginZone?: MarginSettings; marginTextRows?: boolean },
): Map<string, { top: number; bottom: number }> {
    const extents = new Map<string, { top: number; bottom: number }>();
    for (const page of pages) {
        const kept = MarginFilter.filterPageWithSmartRemoval(
            page,
            ctx.margins ?? DEFAULT_MARGINS,
            ctx.marginZone ?? DEFAULT_MARGIN_ZONE,
            ctx.marginRemoval,
            ctx.styleProfile.bodyStyles,
            ctx.styleProfile.primaryBodyStyle,
            ctx.marginTextRows ?? true,
            ctx.marginTextRows ?? false,
        );
        let top = Infinity;
        let bottom = -Infinity;
        for (const block of kept.blocks) {
            if (block.type !== "text") continue;
            for (const line of block.lines ?? []) {
                if ((line.rotation ?? 0) !== 0 || line.wmode === 1) continue;
                if (line.text.trim().split(/\s+/u).length < BODY_LINE_WORDS || !StyleAnalyzer.isLineBodyStyled(line, ctx.styleProfile.bodyStyles)) continue;
                top = Math.min(top, line.bbox.t);
                bottom = Math.max(bottom, line.bbox.b);
            }
        }
        if (top >= bottom) continue;
        const key = pageSizeKey(page);
        const extent = extents.get(key);
        extents.set(key, extent ? { top: Math.min(extent.top, top), bottom: Math.max(extent.bottom, bottom) } : { top, bottom });
    }
    return extents;
}

/**
 * Page furniture no region may take: running headers and footers and page numbers
 * (`marginFilteredLines`, `numberedRunningLines`) set apart above the document's body
 * text or below it on pages of this page's size (`documentBodyExtents`). Text in the margin band inside the body's extent
 * (a figure's labels at the top of a page, a continued table's header) is not
 * furniture, however often it repeats. Pages read in another orientation have none.
 */
export function regionFurnitureLines(
    page: RawPageData,
    ctx: {
        marginRemoval: MarginRemovalResult;
        marginAnalysis: MarginAnalysis;
        styleProfile: StyleProfile;
        margins?: MarginSettings;
        marginZone?: MarginSettings;
        /** Must match the setting `marginRemoval` was computed with. */
        marginTextRows?: boolean;
        pageRotation: RotationAngle;
        /** Pages a running header repeats on (`getEffectiveRepeatThreshold`). */
        repeat: number;
        bodyExtents: ReadonlyMap<string, { top: number; bottom: number }>;
    },
): Set<RawLine> {
    const furniture = new Set<RawLine>();
    const body = ctx.bodyExtents.get(pageSizeKey(page));
    if (!body || ctx.pageRotation !== 0) return furniture;
    const candidates = [...marginFilteredLines(page, ctx), ...numberedRunningLines(page, ctx.marginAnalysis, ctx.repeat, ctx.marginZone)];
    for (const line of candidates) {
        // Set apart from the body by at least its own line height.
        const clearance = line.bbox.b - line.bbox.t;
        if (line.bbox.b <= body.top - clearance || line.bbox.t >= body.bottom + clearance) furniture.add(line);
    }
    // A page has one page number in a band: several bare numbers there are a figure's or a
    // table's, not furniture.
    for (const above of [true, false]) {
        const numbers = [...furniture].filter((l) => /^\d+$/u.test(l.text.trim()) && (l.bbox.b <= body.top) === above);
        if (numbers.length > 1) for (const l of numbers) furniture.delete(l);
    }
    return furniture;
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

    const removed: RawLine[] = [];
    for (const block of originalPage.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            if (!keptLines.has(line)) removed.push(line);
        }
    }
    return marginItemsForLines(originalPage.pageIndex, removed);
}

/** One margin item per non-blank line, in the given order and frame. */
export function marginItemsForLines(pageIndex: number, lines: readonly RawLine[]): MarginItem[] {
    const items: MarginItem[] = [];
    for (const line of lines) {
        const text = (line.text ?? "").trim();
        if (!text) continue;
        const index = items.length;
        items.push({
            kind: "margin",
            id: `p${pageIndex}:i${index}`,
            pageIndex,
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
