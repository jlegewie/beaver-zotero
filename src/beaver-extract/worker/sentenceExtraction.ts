/**
 * Worker-side sentence extraction helpers.
 *
 * Entry points:
 *
 *   - `detectPageParagraphs` + `mapPageSentences` (the per-page core):
 *     given a doc, target page index, pre-walked analysis pages, a
 *     pre-computed analysis context (`marginRemoval` + `styleProfile`)
 *     and the caller's extraction margins, walk the detailed target page,
 *     run `detectFilteredParagraphs`, and map paragraphs to sentence
 *     bboxes. The structured pipeline (`../pipeline/structured.ts`) runs
 *     the first half for every page before any document-level item pass
 *     and the second half after. `extractSentencesForPage` runs both.
 *
 *   - `runSentenceExtractionFromDoc` (debug-only single-page): owns
 *     splitter resolution, JSON walk over the analysis window, and
 *     the analysis-context build, then delegates to
 *     `extractSentencesForPage`. In trace mode it also returns the
 *     pipeline intermediates needed by dev surfaces (visualizer,
 *     fixture capture, extract-trace endpoint).
 *
 * **Quality bar, not parity.** The structured multi-page caller
 * (`../pipeline/structured.ts`) computes
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

import {
    collectHyphenatedCompounds,
    extractPageSentences,
} from "../ParagraphSentenceMapper";
import type { PageSentenceResult } from "../ParagraphSentenceMapper";
import { resolveAnalysisPages } from "../AnalysisWindow";
import {
    detectFilteredParagraphs,
    marginItemsForLines,
    reindexMarginItems,
    type FilteredParagraphContext,
    type FilteredParagraphResult,
} from "../FilteredParagraphPipeline";
import { pagesForFilterWithBridgedFonts } from "../RawFontBridge";
import type { RotationAngle } from "../PageRotationNormalizer";
import { buildPageAnalysisContext } from "../PageAnalysisContext";
import type { SentenceSplitter } from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type {
    SentenceSplitterConfig,
    SentenceTraceResult,
} from "../sentenceTypes";
import type {
    GraphicsLayerMode,
    MarginItem,
    MarginRemovalResult,
    MarginSettings,
    RawLine,
    RawPageData,
    RawPageDataDetailed,
    StructuredPagePhaseTimings,
    StyleProfile,
} from "@beaver/agent-core/extract/types";
import { shouldProbeGraphicsLayer } from "@beaver/agent-core/extract/types";
import {
    extractGraphicsFromDoc,
    extractRawPageDetailedFromDoc,
    extractRawPageFromDoc,
    filterToDividerLines,
    filterToContainerRects,
} from "./docHelpers";
import type { DocumentLike, FontApi } from "./mupdfApi";
import { ensureApi } from "./wasmInit";
import { resolveSplitter } from "./splitterResolver";
import { CURRENT_PDF_EXTRACTION_PRESET } from "../schema";
import { placeRegionItems, splitRegionItems, type RegionItemDraft } from "../regions/regionItems";
import { draftItemsFromParagraphs, draftPageFromParagraphs, type DraftPage } from "../pipeline/draftItems";

/** Arguments of the per-page structured work (`extractSentencesForPage`). */
export interface PageSentenceArgs {
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
    /**
     * Document-wide genuine hyphenated-compound vocabulary (lowercased).
     * Drives line-break de-hyphenation in the sentence mapper — keep the
     * hyphen when the compound is attested, otherwise join. Built once over
     * `analysisPages` by the caller. Omitted ⇒ every line-break hyphen joins.
     */
    compoundVocabulary?: ReadonlySet<string>;
    /** Caller-supplied extraction margins. Match the markdown branch. */
    margins: MarginSettings;
    marginZone: MarginSettings;
    /** Match margin text rows rather than single lines (default true). */
    marginTextRows?: boolean;
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
     * `analyzeDocument`) and reuse it both as the analysis-window
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
    /**
     * Region items for this page (`regionItemsForPage`). `preWalkedDetailed`
     * must then be the page without the lines they absorbed.
     */
    regionItems?: readonly RegionItemDraft[];
    /**
     * Lines region detection set aside as page furniture (`PageRegionItems.margin`);
     * they become margin items. `preWalkedDetailed` must then be the page without them.
     */
    regionMargin?: readonly RawLine[];
    /** Time spent detecting regions before this call, reported in the phase timings. */
    regionsMs?: number;
    /**
     * Dominant text orientation of the page before region lines were removed
     * from `preWalkedDetailed` (`detectDominantTextOrientation`).
     */
    pageRotation?: RotationAngle;
    /** Receives the page's item-boundary input (training export only). */
    boundaries?: FilteredParagraphContext["boundaries"];
}

/** First half of the per-page work: paragraphs, before sentence mapping. */
export interface PageParagraphs {
    detailed: RawPageDataDetailed;
    filteredResult: FilteredParagraphResult;
    /**
     * The page's draft items, created from `filteredResult.paragraphResult`.
     * Item passes edit them; `mapPageSentences` maps them. The paragraph
     * result itself stays the detector's output (and markdown).
     */
    draft: DraftPage;
    detailedWalkMs: number;
    fontBridgeMs: number;
    filteredParagraphsMs: number;
}

/**
 * Walk (or reuse) the detailed target page, detect its paragraphs and create
 * its draft items. The multi-page caller runs this for every page before
 * `mapPageSentences`, so document-level item passes (reference
 * classification) can edit the draft items in between.
 */
export function detectPageParagraphs(args: PageSentenceArgs): PageParagraphs {
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

    // Collect graphics-layer fills/strokes via the JS device (PDF
    // content-stream walk). Fills mark tinted sidebars / callouts; thin
    // strokes mark layout dividers.
    // Gated by `graphicsLayerMode`: `"off"` skips the WASM→JS device
    // walk entirely. `"on"` and `"auto"` probe — see
    // `shouldProbeGraphicsLayer` for the per-mode decision.
    const graphics = shouldProbeGraphicsLayer(args.graphicsLayerMode)
        ? extractGraphicsFromDoc(args.doc, args.pageIndex)
        : undefined;
    const fillBoundaries = graphics
        ? filterToContainerRects(graphics.fills, detailed.width, detailed.height)
        : undefined;
    const dividerLines = graphics
        ? filterToDividerLines(graphics.strokes, detailed.width, detailed.height)
        : undefined;

    const tFiltered = performance.now();
    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex: args.pageIndex,
        marginRemoval: args.marginRemoval,
        styleProfile: args.styleProfile,
        margins: args.margins,
        marginZone: args.marginZone,
        marginTextRows: args.marginTextRows,
        paragraphSettings: args.paragraphSettings,
        fillBoundaries,
        dividerLines,
        regionBarriers: args.regionItems?.map((region) => ({
            bbox: region.bbox,
            // An equation's lines are its content. A figure's graphics and a
            // table's grid fill their box: cells leave gaps anywhere.
            ...(region.kind === "formula" ? { content: region.rows.flat().map((cell) => cell.bbox) } : {}),
        })),
        pageRotation: args.pageRotation,
        ...(args.boundaries ? { boundaries: args.boundaries } : {}),
    });
    const filteredParagraphsMs = performance.now() - tFiltered;
    const draft = draftPageFromParagraphs(filteredResult.paragraphResult);
    return { detailed, filteredResult, draft, detailedWalkMs, fontBridgeMs, filteredParagraphsMs };
}

/**
 * Second half of the per-page work: map the draft items to sentence bboxes,
 * then place region and margin items. `passTimings` holds the page's share
 * of the item passes (`referencesMs`, `itemTypesMs`, …), reported in the
 * phase timings.
 */
export function mapPageSentences(
    args: Pick<
        PageSentenceArgs,
        "paragraphSettings" | "splitter" | "compoundVocabulary" | "regionItems" | "regionMargin" | "regionsMs"
    >,
    paragraphs: PageParagraphs,
    passTimings: Partial<StructuredPagePhaseTimings> = {},
): {
    sentenceResult: PageSentenceResult;
    filteredResult: FilteredParagraphResult;
    phaseTimings: StructuredPagePhaseTimings;
} {
    const { detailed, filteredResult } = paragraphs;
    const tSentence = performance.now();
    // Margin draft items (furniture an item pass found) leave the reading
    // order: they are mapped last, so they don't break sentence continuations
    // or region placement, and join the margin filter's items at the end.
    const drafts = paragraphs.draft.items;
    const marginDrafts = drafts.filter((item) => item.kind === "margin");
    const sentenceResult = extractPageSentences(detailed, {
        paragraphSettings: args.paragraphSettings,
        splitter: args.splitter,
        compoundVocabulary: args.compoundVocabulary,
        precomputed: {
            items: marginDrafts.length > 0 ? [...drafts.filter((item) => item.kind !== "margin"), ...marginDrafts] : drafts,
            pageRotation: filteredResult.pageRotation,
            sourceWidth: filteredResult.sourceWidth,
            sourceHeight: filteredResult.sourceHeight,
        },
    });
    const draftMargins = sentenceResult.items.splice(sentenceResult.items.length - marginDrafts.length) as MarginItem[];
    // Their degradation notes, taken before region placement renames the other items.
    const marginNotes = draftMargins.length > 0
        ? (sentenceResult.degradation?.notes ?? []).flatMap((note) => {
            const k = draftMargins.findIndex((item) => item.id === note.itemId);
            return k >= 0 ? [{ note, k }] : [];
        })
        : [];
    let regionsMs = args.regionsMs ?? 0;
    if (args.regionItems?.length) {
        const tRegions = performance.now();
        // Column detection split equation boxes that merged one equation from
        // each column; the items follow, so each is placed in its own column.
        const regionItems = splitRegionItems(args.regionItems, filteredResult.columnResult.regionPieces);
        const placed = placeRegionItems(detailed.pageIndex, sentenceResult.items, regionItems, {
            rotation: filteredResult.pageRotation,
            sourceWidth: filteredResult.sourceWidth,
            sourceHeight: filteredResult.sourceHeight,
        });
        sentenceResult.items = placed.items;
        sentenceResult.sentences = placed.sentences;
        if (sentenceResult.degradation) {
            for (const note of sentenceResult.degradation.notes) {
                note.itemId = placed.renamed.get(note.itemId) ?? note.itemId;
            }
        }
        regionsMs += performance.now() - tRegions;
    }
    const margins = reindexMarginItems(
        [...draftMargins, ...filteredResult.marginItems, ...marginItemsForLines(detailed.pageIndex, args.regionMargin ?? [])],
        sentenceResult.items.length,
    );
    for (const { note, k } of marginNotes) note.itemId = margins[k].id;
    sentenceResult.items = [...sentenceResult.items, ...margins];
    const sentenceMapMs = performance.now() - tSentence;

    const { charCount, lineCount } = countDetailedPageSizes(detailed);
    const phaseTimings: StructuredPagePhaseTimings = {
        pageIndex: detailed.pageIndex,
        detailedWalkMs: paragraphs.detailedWalkMs,
        fontBridgeMs: paragraphs.fontBridgeMs,
        filteredParagraphsMs: paragraphs.filteredParagraphsMs,
        marginFilterMs: filteredResult.timings.marginFilterMs,
        columnDetectMs: filteredResult.timings.columnDetectMs,
        lineDetectMs: filteredResult.timings.lineDetectMs,
        paragraphDetectMs: filteredResult.timings.paragraphDetectMs,
        sentenceMapMs,
        ...(args.regionItems !== undefined ? { regionsMs } : {}),
        ...passTimings,
        charCount,
        lineCount,
        itemCount: sentenceResult.items.length,
        degradationCount: sentenceResult.degradation?.count ?? 0,
    };

    return { sentenceResult, filteredResult, phaseTimings };
}

/**
 * Per-page sentence work given pre-walked context: `detectPageParagraphs`
 * followed by `mapPageSentences`. Cheap to call in a loop — the caller
 * resolves the splitter, walks the analysis pages, and builds the analysis
 * context once and reuses them across pages.
 *
 * Returns both the sentence result and the `FilteredParagraphResult`
 * so the multi-page caller can populate `InternalProcessedPage.content` /
 * `columns` / `lines` from the same call (the paragraph-engine
 * markdown text is already produced inside the filter step as
 * `paragraphResult.pageContent`).
 */
export function extractSentencesForPage(args: PageSentenceArgs): {
    sentenceResult: PageSentenceResult;
    filteredResult: FilteredParagraphResult;
    phaseTimings: StructuredPagePhaseTimings;
} {
    return mapPageSentences(args, detectPageParagraphs(args));
}

/**
 * Build the document's genuine hyphenated-compound vocabulary from the
 * analysis-window pages' line text. Shared by the multi-page structured
 * extract (`buildAnalysisFromDoc`) and the debug single-page paths so all of
 * them feed the sentence mapper the same line-break de-hyphenation signal.
 */
export function buildCompoundVocabulary(
    pages: readonly RawPageData[],
): Set<string> {
    const vocabulary = new Set<string>();
    for (const page of pages) {
        for (const block of page.blocks) {
            if (block.type !== "text" || !block.lines) continue;
            collectHyphenatedCompounds(
                block.lines.map((line) => line.text),
                vocabulary,
            );
        }
    }
    return vocabulary;
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
     * Graphics-layer probe mode. See `GraphicsLayerMode`. `"off"` and
     * undefined skip the per-page WASM→JS device walk; `"on"` and
     * `"auto"` probe. The debug single-page paths honour the same setting
     * as production so trace output matches the corresponding `extract`
     * call.
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
        { captionLabels: CURRENT_PDF_EXTRACTION_PRESET.captionLabels },
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
    // Same line-break de-hyphenation signal the multi-page extract path uses,
    // scoped to this request's analysis window so the debug trace/overlay
    // matches production output.
    const compoundVocabulary = buildCompoundVocabulary(pagesForFilter);

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
        const graphics = probeGraphics
            ? extractGraphicsFromDoc(doc, pageIndex)
            : undefined;
        const fillBoundaries = graphics
            ? filterToContainerRects(graphics.fills, detailed.width, detailed.height)
            : undefined;
        const dividerLines = graphics
            ? filterToDividerLines(graphics.strokes, detailed.width, detailed.height)
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
            dividerLines,
        });
        const result = extractPageSentences(detailed, {
            paragraphSettings,
            splitter,
            compoundVocabulary,
            precomputed: {
                items: draftItemsFromParagraphs(filtered.paragraphResult),
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
    const traceGraphics = probeGraphics
        ? extractGraphicsFromDoc(doc, pageIndex)
        : undefined;
    const traceFillBoundaries = traceGraphics
        ? filterToContainerRects(traceGraphics.fills, detailed.width, detailed.height)
        : undefined;
    const traceDividerLines = traceGraphics
        ? filterToDividerLines(traceGraphics.strokes, detailed.width, detailed.height)
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
        dividerLines: traceDividerLines,
    });
    const result = extractPageSentences(detailed, {
        paragraphSettings,
        splitter,
        compoundVocabulary,
        precomputed: {
            items: draftItemsFromParagraphs(filteredResult.paragraphResult),
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
            fillBoundaries: traceFillBoundaries ?? [],
            dividerLines: traceDividerLines ?? [],
            filteredResult,
        },
    };
}
