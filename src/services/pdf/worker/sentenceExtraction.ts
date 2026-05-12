/**
 * Worker-side sentence extraction helpers.
 *
 * Two entry points:
 *
 *   - `extractSentencesForPage` (the per-page core): given a doc, target
 *     page index, pre-walked analysis pages, a pre-computed analysis
 *     context (`marginRemoval` + `styleProfile`) and the caller's
 *     extraction margins, walks the detailed target page, runs
 *     `detectFilteredParagraphs`, and maps paragraphs to sentence
 *     bboxes. Returns both the sentence result AND the
 *     `FilteredParagraphResult` so callers (the structured-mode
 *     `runExtractFromIndices` branch) can read columns / lines /
 *     content from the same single call. Used by the structured
 *     multi-page `extract` path AND by the single-page debug
 *     `runSentenceExtractionFromDoc` below.
 *
 *   - `runSentenceExtractionFromDoc` (debug-only single-page): owns
 *     splitter resolution, JSON walk over the analysis window, and
 *     the analysis-context build, then delegates to
 *     `extractSentencesForPage`. In trace mode it also returns the
 *     pipeline intermediates needed by dev surfaces (visualizer,
 *     fixture capture, extract-trace endpoint).
 *
 * **Quality bar, not parity.** The structured multi-page caller
 * (`runExtractFromIndices` in `worker/ops.ts`) computes
 * `marginRemoval` / `styleProfile` ONCE over JSON-walked analysis
 * pages — no per-target detailed substitution. The debug single-page
 * path (`runSentenceExtractionFromDoc` in trace mode) computes them
 * over the substituted `pagesForFilter` (with the detailed target
 * spliced in via `pagesForFilterWithBridgedFonts`). The two paths can
 * therefore produce subtly different results on the same page in
 * isolation. That divergence is intentional — the debug op is NOT a
 * parity oracle for structured extraction. The bar for structured is
 * "no extraction-quality regression on representative fixtures" (no
 * added margin junk, no lost body paragraphs, no worse heading/body
 * classification, no measurable rise in `degradation.count`). See
 * `tests/smoke/extractFixtures.smoke.test.ts` for the regression surface.
 *
 * Caller is responsible for `acquireDoc`/`releaseDoc` and pageIndex
 * validation. These helpers trust their inputs.
 */

import { extractPageSentenceBBoxes } from "../ParagraphSentenceMapper";
import type { PageSentenceBBoxResult } from "../ParagraphSentenceMapper";
import { resolveAnalysisPages } from "../AnalysisWindow";
import {
    detectFilteredParagraphs,
    type FilteredParagraphResult,
} from "../FilteredParagraphPipeline";
import { pagesForFilterWithBridgedFonts } from "../RawFontBridge";
import { buildPageAnalysisContext } from "../PageAnalysisContext";
import type { SentenceSplitter } from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type {
    SentenceSplitterConfig,
    SentenceBBoxTraceResult,
} from "../sentenceTypes";
import type {
    MarginRemovalResult,
    MarginSettings,
    RawPageData,
    StyleProfile,
} from "../types";
import { extractRawPageDetailedFromDoc, extractRawPageFromDoc } from "./docHelpers";
import type { DocumentLike } from "./mupdfApi";
import { resolveSplitter } from "./splitterResolver";

/**
 * Per-page sentence work given pre-walked context. Cheap to call in a
 * loop — the caller resolves the splitter, walks the analysis pages,
 * and builds the analysis context once and reuses them across pages.
 *
 * Returns both the sentence result and the `FilteredParagraphResult`
 * so the multi-page caller can populate `ProcessedPage.content` /
 * `columns` / `lines` from the same call (the paragraph-engine
 * markdown text is already produced inside the filter step as
 * `paragraphResult.pageContent`).
 */
export function extractSentencesForPage(args: {
    doc: DocumentLike;
    pageIndex: number;
    /**
     * JSON-walked analysis pages (must include the target page).
     * Shared across loop iterations in the multi-page caller.
     */
    analysisPages: RawPageData[];
    /** Resolved once per request, reused across pages. */
    splitter: SentenceSplitter;
    paragraphSettings?: ParagraphDetectionSettings;
    /**
     * Pre-computed cross-page smart-removal result. Computed once over
     * `analysisPages` by the caller so MarginFilter / StyleAnalyzer
     * don't run per page.
     */
    marginRemoval: MarginRemovalResult;
    /** Pre-computed document-wide style profile. */
    styleProfile: StyleProfile;
    /** Caller-supplied extraction margins. Match the markdown branch. */
    margins: MarginSettings;
    marginZone: MarginSettings;
}): {
    sentenceResult: PageSentenceBBoxResult;
    filteredResult: FilteredParagraphResult;
} {
    const detailed = extractRawPageDetailedFromDoc(
        args.doc,
        args.pageIndex,
        false,
    );
    const pagesForFilter = pagesForFilterWithBridgedFonts(
        args.analysisPages,
        args.pageIndex,
        detailed,
    );
    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex: args.pageIndex,
        marginRemoval: args.marginRemoval,
        styleProfile: args.styleProfile,
        margins: args.margins,
        marginZone: args.marginZone,
        paragraphSettings: args.paragraphSettings,
    });
    const sentenceResult = extractPageSentenceBBoxes(detailed, {
        paragraphSettings: args.paragraphSettings,
        splitter: args.splitter,
        precomputed: {
            paragraphResult: filteredResult.paragraphResult,
            pageRotation: filteredResult.pageRotation,
            sourceWidth: filteredResult.sourceWidth,
            sourceHeight: filteredResult.sourceHeight,
        },
    });
    return { sentenceResult, filteredResult };
}

interface BaseArgs {
    doc: DocumentLike;
    pageIndex: number;
    pageCount: number;
    splitterConfig?: SentenceSplitterConfig;
    analysisWindow?: number;
    paragraphSettings?: ParagraphDetectionSettings;
    /** Caller-supplied extraction margins. Defaulted by the caller if absent. */
    margins?: MarginSettings;
    marginZone?: MarginSettings;
    /**
     * Smart-removal candidate frequency cutoff. Forwarded to
     * `buildPageAnalysisContext`; falsy / undefined falls back to that
     * helper's default.
     */
    repeatThreshold?: number;
    /**
     * Whether to detect ascending page-number sequences in margins.
     * Forwarded to `buildPageAnalysisContext`; defaults to `true` there.
     */
    detectPageSequences?: boolean;
}

export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace?: false },
): Promise<{ result: PageSentenceBBoxResult }>;
export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace: true },
): Promise<SentenceBBoxTraceResult>;
export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace?: boolean },
): Promise<{ result: PageSentenceBBoxResult } | SentenceBBoxTraceResult> {
    const {
        doc,
        pageIndex,
        pageCount,
        splitterConfig,
        analysisWindow,
        paragraphSettings,
        margins,
        marginZone,
        repeatThreshold,
        detectPageSequences,
        trace: wantTrace,
    } = args;

    // Resolve the splitter once per request (not per paragraph).
    const splitter: SentenceSplitter = await resolveSplitter(
        splitterConfig ?? { type: "sentencex" },
    );

    // Detailed target page (per-character quads + bbox identity for the
    // mapper). Walked once and substituted into the analysis window.
    const detailed = extractRawPageDetailedFromDoc(doc, pageIndex, false);

    // Analysis window for cross-page smart margin removal + style profile.
    const analysisPageIndices = resolveAnalysisPages({
        targetPageIndices: [pageIndex],
        totalPageCount: pageCount,
        analysisWindow,
    });
    const jsonPages = analysisPageIndices.map((i) =>
        extractRawPageFromDoc(doc, i),
    );
    const pagesForFilter = pagesForFilterWithBridgedFonts(
        jsonPages,
        pageIndex,
        detailed,
    );

    if (!wantTrace) {
        // Production single-page path. Compute the analysis context from
        // `pagesForFilter` (substituted detailed target) and call the
        // shared per-page helper. NOTE: this path is preserved for
        // legacy single-page callers via `runSentenceExtractionFromDoc`.
        // The structured multi-page `extract` path goes through the
        // shared helper directly (see `extractSentencesForPage`) with a
        // JSON-only analysis context — see the file-level comment on
        // why these can diverge.
        const { styleProfile, marginRemoval } = buildPageAnalysisContext({
            pages: pagesForFilter,
            totalPageCount: pageCount,
            marginZone,
            repeatThreshold,
            detectPageSequences,
        });
        const filtered = detectFilteredParagraphs({
            pages: pagesForFilter,
            pageIndex,
            marginRemoval,
            styleProfile,
            margins,
            marginZone,
            paragraphSettings,
        });
        const result = extractPageSentenceBBoxes(detailed, {
            paragraphSettings,
            splitter,
            precomputed: {
                paragraphResult: filtered.paragraphResult,
                pageRotation: filtered.pageRotation,
                sourceWidth: filtered.sourceWidth,
                sourceHeight: filtered.sourceHeight,
            },
        });
        return { result };
    }

    // Trace path. Pre-compute marginAnalysis/marginRemoval/styleProfile
    // from `pagesForFilter` so we can return them. `detectFilteredParagraphs`
    // would otherwise compute identical values internally; recomputing
    // from `jsonPages` instead would silently diverge on the target page.
    const { marginAnalysis, marginRemoval, styleProfile } =
        buildPageAnalysisContext({
            pages: pagesForFilter,
            totalPageCount: pageCount,
            marginZone,
            repeatThreshold,
            detectPageSequences,
        });
    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex,
        marginRemoval,
        styleProfile,
        margins,
        marginZone,
        paragraphSettings,
    });
    const result = extractPageSentenceBBoxes(detailed, {
        paragraphSettings,
        splitter,
        precomputed: {
            paragraphResult: filteredResult.paragraphResult,
            pageRotation: filteredResult.pageRotation,
            sourceWidth: filteredResult.sourceWidth,
            sourceHeight: filteredResult.sourceHeight,
        },
    });

    return {
        result,
        trace: {
            analysisPageIndices,
            rawDoc: { pageCount, pages: jsonPages },
            detailed,
            pagesForFilter,
            marginAnalysis,
            marginRemoval,
            filteredResult,
        },
    };
}
