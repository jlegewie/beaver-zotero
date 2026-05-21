/**
 * PageAnalysisContext — shared cross-page analysis stage.
 *
 * Single source of truth for the StyleAnalyzer + MarginFilter passes
 * that both the markdown fast path (`runExtractFromIndices`) and the
 * sentence structured path (`detectFilteredParagraphs`) need to run
 * before per-page processing.
 *
 * Returns `marginAnalysis` alongside `marginRemoval` because the
 * extract result envelope publishes it as
 * `InternalExtractionResult.analysis.marginAnalysis`. Returning both keeps the
 * contract intact without forcing the extract op to recompute the
 * collection pass.
 *
 * Worker-safe: depends only on sibling PDF modules; never imports the
 * package barrel (`worker/ops.ts` forbids the barrel inside the
 * worker).
 */

import { MarginFilter, getEffectiveRepeatThreshold } from "./MarginFilter";
import { StyleAnalyzer } from "./StyleAnalyzer";
import {
    DEFAULT_MARGIN_ZONE,
    type MarginAnalysis,
    type MarginRemovalResult,
    type MarginSettings,
    type RawPageData,
    type StyleProfile,
} from "./types";

export interface PageAnalysisContextInput {
    /**
     * Pre-walked pages to analyze. Caller is responsible for resolving
     * the page set via `resolveAnalysisPages` and walking those
     * indices via the doc helpers.
     */
    pages: RawPageData[];
    /**
     * Total page count of the source document. Used by
     * `getEffectiveRepeatThreshold` to decide whether the document is
     * short enough for the adaptive repeat-threshold relaxation.
     */
    totalPageCount: number;
    /** Wider margin zone for smart-removal candidate collection. */
    marginZone?: MarginSettings;
    /** Minimum pages a text must appear on to be flagged as repeating. */
    repeatThreshold?: number;
    /** Whether to detect ascending page-number sequences in margins. */
    detectPageSequences?: boolean;
}

export interface PageAnalysisContext {
    /** Document-wide style profile (echoed to InternalExtractionResult.analysis). */
    styleProfile: StyleProfile;
    /**
     * Margin zone elements collected per position. Echoed to
     * `InternalExtractionResult.analysis.marginAnalysis`.
     */
    marginAnalysis: MarginAnalysis;
    /**
     * Per-page removal map plus aggregate candidates. Consumed by
     * `MarginFilter.filterPageWithSmartRemoval` during per-page
     * processing.
     */
    marginRemoval: MarginRemovalResult;
}

/**
 * Run StyleAnalyzer + MarginFilter on the supplied pages.
 *
 * `StyleAnalyzer.analyze` is invoked with `sampleSize=0` (no random
 * subsample) — the caller already chose the analysis size by selecting
 * the input page set via `resolveAnalysisPages`.
 */
export function buildPageAnalysisContext(
    input: PageAnalysisContextInput,
): PageAnalysisContext {
    const {
        pages,
        totalPageCount,
        marginZone = DEFAULT_MARGIN_ZONE,
        repeatThreshold,
        detectPageSequences = true,
    } = input;

    const styleProfile = new StyleAnalyzer().analyze(pages, 4, 0.15, 0);

    const marginAnalysis = MarginFilter.collectMarginElements(
        pages,
        marginZone,
    );
    const marginRemoval = MarginFilter.identifyElementsToRemove(
        marginAnalysis,
        getEffectiveRepeatThreshold({
            requested: repeatThreshold,
            totalPageCount,
            analysisPageCount: pages.length,
        }),
        detectPageSequences,
    );

    return { styleProfile, marginAnalysis, marginRemoval };
}
