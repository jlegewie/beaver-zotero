/**
 * Worker-side sentence extraction helpers: the per-page core of structured
 * extraction.
 *
 * `detectPageParagraphs` + `mapPageSentences`: given a doc, the target
 * page's detailed walk, the analysis pages, a pre-computed analysis context
 * (`marginRemoval` + `styleProfile`) and the caller's extraction margins,
 * run `detectFilteredParagraphs` and map paragraphs to sentence bboxes. The
 * structured pipeline (`../pipeline/structured.ts`) runs the first half for
 * every page before any document-level item pass and the second half after.
 *
 * Caller is responsible for `acquireDoc`/`releaseDoc` and pageIndex
 * validation. These helpers trust their inputs.
 */

import {
    extractPageSentences,
} from "../ParagraphSentenceMapper";
import type { PageSentenceResult } from "../ParagraphSentenceMapper";
import { addBlockToVocabulary, LineJoinVocabulary } from "../lineJoins";
import {
    detectFilteredParagraphs,
    marginItemsForLines,
    reindexMarginItems,
    type FilteredParagraphContext,
    type FilteredParagraphResult,
} from "../FilteredParagraphPipeline";
import { pagesForFilterWithBridgedFonts } from "../RawFontBridge";
import type { RotationAngle } from "../PageRotationNormalizer";
import type { SentenceSplitter } from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
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
    filterToDividerLines,
    filterToContainerRects,
} from "./docHelpers";
import type { DocumentLike } from "./mupdfApi";
import { placeRegionItems, splitRegionItems, type RegionItemDraft } from "../regions/regionItems";
import { draftPageFromParagraphs, type DraftPage } from "../pipeline/draftItems";

/** Arguments of the per-page structured work (`detectPageParagraphs`, `mapPageSentences`). */
export interface PageSentenceArgs {
    doc: DocumentLike;
    pageIndex: number;
    /**
     * Analysis pages covering the target page (may be the detailed
     * page itself — see `preWalkedDetailed`). Shared across loop
     * iterations in the multi-page caller.
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
    /** Match margin text rows rather than single lines (`FilteredParagraphContext.marginTextRows`). */
    marginTextRows: boolean;
    /** Keep the words of justified prose rows (`FilteredParagraphContext.marginProseRows`). */
    marginProseRows: boolean;
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
     * Detailed walk of `pageIndex`. The multi-page structured caller walks
     * the target once (in `analyzeDocument`) and reuses it both as the
     * analysis-window entry AND the input to the sentence mapper,
     * eliminating a redundant per-target JSON walk.
     */
    preWalkedDetailed: RawPageDataDetailed;
    /**
     * Time spent creating `preWalkedDetailed` before this call, so
     * page-level phase timings are attributed to the page that paid the walk.
     */
    preWalkedDetailedMs: number;
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
 * Detect the target page's paragraphs and create its draft items. The
 * multi-page caller runs this for every page before `mapPageSentences`, so
 * document-level item passes (reference classification) can edit the draft
 * items in between.
 */
export function detectPageParagraphs(args: PageSentenceArgs): PageParagraphs {
    const detailed = args.preWalkedDetailed;
    const detailedWalkMs = args.preWalkedDetailedMs;

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
        marginProseRows: args.marginProseRows,
        paragraphSettings: args.paragraphSettings,
        compoundVocabulary: args.compoundVocabulary,
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
 * Build the document's genuine hyphenated-compound vocabulary from the
 * analysis-window pages' line text (`buildAnalysisFromDoc`): the sentence
 * mapper's line-break de-hyphenation signal.
 */
export function buildCompoundVocabulary(
    pages: readonly RawPageData[],
): LineJoinVocabulary {
    const vocabulary = new LineJoinVocabulary();
    for (const page of pages) {
        for (const block of page.blocks) {
            if (block.type !== "text" || !block.lines) continue;
            addBlockToVocabulary(
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
