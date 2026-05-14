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

import { extractPageSentences } from "../ParagraphSentenceMapper";
import type { PageSentenceResult } from "../ParagraphSentenceMapper";
import { resolveAnalysisPages } from "../AnalysisWindow";
import {
    detectFilteredParagraphs,
    reindexMarginItems,
    type FilteredParagraphResult,
} from "../FilteredParagraphPipeline";
import { pagesForFilterWithBridgedFonts } from "../RawFontBridge";
import { buildPageAnalysisContext } from "../PageAnalysisContext";
import type { SentenceSplitter } from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type {
    SentenceSplitterConfig,
    SentenceTraceResult,
} from "../sentenceTypes";
import type {
    GraphicsLayerMode,
    MarginRemovalResult,
    MarginSettings,
    RawPageData,
    RawPageDataDetailed,
    StructuredPagePhaseTimings,
    StyleProfile,
} from "../types";
import { shouldProbeGraphicsLayer } from "../types";
import {
    extractFilledRectsFromDoc,
    extractRawPageDetailedFromDoc,
    extractRawPageFromDoc,
    filterToContainerRects,
} from "./docHelpers";
import type { DocumentLike, FontApi } from "./mupdfApi";
import { ensureApi } from "./wasmInit";
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
     * Analysis pages covering the target page (may be the detailed
     * page itself when the caller pre-walked it — see `preWalkedDetailed`).
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
    /**
     * Whether to probe the PDF graphics layer for tinted display
     * containers (`fill_path` events) on this page. See
     * `GraphicsLayerMode` — `"off"` skips the per-page WASM→JS
     * device walk entirely, restoring v0.20 per-page performance for
     * callers that don't need fill-zone column detection.
     * Default `"auto"` (matches `"on"` today).
     */
    graphicsLayerMode?: GraphicsLayerMode;
    /**
     * Optional pre-walked detailed page for `pageIndex`. Lets the
     * multi-page structured caller walk the target once (in
     * `runExtractFromIndices`) and reuse it both as the analysis-window
     * entry AND the input to the sentence mapper, eliminating the
     * redundant per-target JSON walk.
     */
    preWalkedDetailed?: RawPageDataDetailed;
    /**
     * Time spent creating `preWalkedDetailed` before this call. When the
     * caller pre-walks target pages outside the per-page loop, this keeps
     * page-level phase timings attributed to the page that paid the walk.
     */
    preWalkedDetailedMs?: number;
    /**
     * Font accessors for the WASM detailed walker. Required when
     * `preWalkedDetailed` is omitted — otherwise lines come out with
     * empty fonts and downstream heading detection silently degrades.
     */
    fontApi?: FontApi;
}): {
    sentenceResult: PageSentenceResult;
    filteredResult: FilteredParagraphResult;
    phaseTimings: StructuredPagePhaseTimings;
} {
    const tDetailed = performance.now();
    const detailed =
        args.preWalkedDetailed ??
        extractRawPageDetailedFromDoc(args.doc, args.pageIndex, false, args.fontApi);
    const measuredDetailedWalkMs = performance.now() - tDetailed;
    const detailedWalkMs =
        args.preWalkedDetailed !== undefined
            ? (args.preWalkedDetailedMs ?? 0)
            : measuredDetailedWalkMs;

    const tFontBridge = performance.now();
    const pagesForFilter = pagesForFilterWithBridgedFonts(
        args.analysisPages,
        args.pageIndex,
        detailed,
    );
    const fontBridgeMs = performance.now() - tFontBridge;

    // Collect background-fill rectangles via the JS device (PDF content-
    // stream walk). These mark tinted sidebars / callouts / "facts"
    // boxes — `ColumnDetector` uses them as hard zone boundaries.
    // Gated by `graphicsLayerMode`: `"off"` skips the WASM→JS device
    // walk entirely, restoring v0.20 per-page performance. `"on"`
    // and `"auto"` (and undefined for legacy callers) probe — see
    // `shouldProbeGraphicsLayer` for the per-mode decision.
    const fillBoundaries = shouldProbeGraphicsLayer(args.graphicsLayerMode)
        ? filterToContainerRects(
              extractFilledRectsFromDoc(args.doc, args.pageIndex),
              detailed.width,
              detailed.height,
          )
        : undefined;

    const tFiltered = performance.now();
    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex: args.pageIndex,
        marginRemoval: args.marginRemoval,
        styleProfile: args.styleProfile,
        margins: args.margins,
        marginZone: args.marginZone,
        paragraphSettings: args.paragraphSettings,
        fillBoundaries,
    });
    const filteredParagraphsMs = performance.now() - tFiltered;

    const tSentence = performance.now();
    const sentenceResult = extractPageSentences(detailed, {
        paragraphSettings: args.paragraphSettings,
        splitter: args.splitter,
        precomputed: {
            paragraphResult: filteredResult.paragraphResult,
            pageRotation: filteredResult.pageRotation,
            sourceWidth: filteredResult.sourceWidth,
            sourceHeight: filteredResult.sourceHeight,
        },
    });
    sentenceResult.items = [
        ...sentenceResult.items,
        ...reindexMarginItems(
            filteredResult.marginItems,
            sentenceResult.items.length,
        ),
    ];
    const sentenceMapMs = performance.now() - tSentence;

    const { charCount, lineCount } = countDetailedPageSizes(detailed);
    const phaseTimings: StructuredPagePhaseTimings = {
        pageIndex: args.pageIndex,
        detailedWalkMs,
        fontBridgeMs,
        filteredParagraphsMs,
        marginFilterMs: filteredResult.timings.marginFilterMs,
        columnDetectMs: filteredResult.timings.columnDetectMs,
        lineDetectMs: filteredResult.timings.lineDetectMs,
        paragraphDetectMs: filteredResult.timings.paragraphDetectMs,
        sentenceMapMs,
        charCount,
        lineCount,
        itemCount: sentenceResult.items.length,
        degradationCount: sentenceResult.degradation?.count ?? 0,
    };

    return { sentenceResult, filteredResult, phaseTimings };
}

/**
 * Sum char and line counts across every text block on a detailed page.
 * Used as the normalization denominator for per-phase profile output —
 * `<phase>Ms / charCount * 1000` gives ms-per-1k-chars and makes
 * cross-page comparisons size-invariant.
 */
function countDetailedPageSizes(
    page: RawPageDataDetailed,
): { charCount: number; lineCount: number } {
    let charCount = 0;
    let lineCount = 0;
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            lineCount++;
            charCount += line.chars?.length ?? 0;
        }
    }
    return { charCount, lineCount };
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
    /**
     * Graphics-layer probe mode. See `GraphicsLayerMode`. `"off"`
     * skips the per-page WASM→JS device walk; `"on"` and `"auto"`
     * (default behavior, including undefined) probe. The debug
     * single-page paths honour the same setting as production so
     * trace output matches the corresponding `extract` call.
     */
    graphicsLayerMode?: GraphicsLayerMode;
}

export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace?: false },
): Promise<{ result: PageSentenceResult }>;
export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace: true },
): Promise<SentenceTraceResult>;
export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace?: boolean },
): Promise<{ result: PageSentenceResult } | SentenceTraceResult> {
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
        graphicsLayerMode,
        trace: wantTrace,
    } = args;
    const probeGraphics = shouldProbeGraphicsLayer(graphicsLayerMode);

    // Resolve the splitter once per request (not per paragraph).
    const splitter: SentenceSplitter = await resolveSplitter(
        splitterConfig ?? { type: "sentencex" },
    );

    const { Font: fontApi } = await ensureApi();

    // Detailed target page (per-character quads + bbox identity for the
    // mapper). Walked once and substituted into the analysis window.
    const detailed = extractRawPageDetailedFromDoc(doc, pageIndex, false, fontApi);

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
        const fillBoundaries = probeGraphics
            ? filterToContainerRects(
                  extractFilledRectsFromDoc(doc, pageIndex),
                  detailed.width,
                  detailed.height,
              )
            : undefined;
        const filtered = detectFilteredParagraphs({
            pages: pagesForFilter,
            pageIndex,
            marginRemoval,
            styleProfile,
            margins,
            marginZone,
            paragraphSettings,
            fillBoundaries,
        });
        const result = extractPageSentences(detailed, {
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
    const traceFillBoundaries = probeGraphics
        ? filterToContainerRects(
              extractFilledRectsFromDoc(doc, pageIndex),
              detailed.width,
              detailed.height,
          )
        : undefined;
    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex,
        marginRemoval,
        styleProfile,
        margins,
        marginZone,
        paragraphSettings,
        fillBoundaries: traceFillBoundaries,
    });
    const result = extractPageSentences(detailed, {
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
