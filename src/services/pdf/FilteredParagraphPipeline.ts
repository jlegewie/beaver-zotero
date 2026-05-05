/**
 * Filtered Paragraph Pipeline — shared "filter + detect" helper for the
 * sentence/paragraph extraction stack.
 *
 * Worker-safe: imports only sibling PDF modules — never the
 * `src/services/pdf/index.ts` barrel (`worker/ops.ts:15` forbids the
 * barrel inside the worker).
 */

import { MarginFilter } from "./MarginFilter";
import { StyleAnalyzer } from "./StyleAnalyzer";
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
    type MarginRemovalResult,
    type MarginSettings,
    type RawPageData,
    type StyleProfile,
} from "./types";

export interface FilteredParagraphContext {
    /**
     * Pages that participate in cross-page analysis (margin smart
     * removal, document-wide style profile). The caller is responsible
     * for resolving the analysis window — typically via
     * `resolveAnalysisPageIndices` in `AnalysisWindow.ts`.
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
    /** Whether to detect ascending page-number sequences in margins. */
    detectPageSequences?: boolean;
    /** Forwarded to `detectParagraphs`. */
    paragraphSettings?: ParagraphDetectionSettings;
}

export interface FilteredParagraphResult {
    /**
     * Paragraph detection result with `itemLines` populated, ready to
     * pass to `extractPageSentenceBBoxes` as
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
}

/**
 * Run the filtered paragraph pipeline for a single target page.
 *
 * Throws when `ctx.pageIndex` is not present in `ctx.pages`. Empty/no-
 * column pages return a well-formed `paragraphResult` with empty
 * `items` and `itemLines` arrays — callers can pass it as `precomputed`
 * to the sentence mapper without special-casing.
 */
export function detectFilteredParagraphs(
    ctx: FilteredParagraphContext,
): FilteredParagraphResult {
    const targetPage = ctx.pages.find((p) => p.pageIndex === ctx.pageIndex);
    if (!targetPage) {
        throw new Error(
            `detectFilteredParagraphs: page_index ${ctx.pageIndex} not present in supplied pages`,
        );
    }

    const margins = ctx.margins ?? DEFAULT_MARGINS;
    const marginZone = ctx.marginZone ?? DEFAULT_MARGIN_ZONE;

    const marginRemoval =
        ctx.marginRemoval ??
        MarginFilter.identifyElementsToRemove(
            MarginFilter.collectMarginElements(ctx.pages, marginZone),
            ctx.repeatThreshold ?? 3,
            ctx.detectPageSequences ?? true,
        );

    const styleProfile =
        ctx.styleProfile ?? new StyleAnalyzer().analyze(ctx.pages, 4, 0.15, 0);

    const filteredPage = MarginFilter.filterPageWithSmartRemoval(
        targetPage,
        margins,
        marginZone,
        marginRemoval,
    );

    const columnResult = detectColumns(filteredPage, {
        headerMargin: margins.top,
        footerMargin: margins.bottom,
    });

    let lineResult: PageLineResult;
    let paragraphResult: PageParagraphResult;

    if (columnResult.columns.length > 0) {
        lineResult = detectLinesOnPage(filteredPage, columnResult.columns);
        if (lineResult.allLines.length > 0) {
            paragraphResult = detectParagraphs(
                lineResult,
                styleProfile.bodyStyles,
                ctx.paragraphSettings ?? {},
                { paragraph: 0, header: 0 },
                { trackItemLines: true },
            );
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
    };
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
