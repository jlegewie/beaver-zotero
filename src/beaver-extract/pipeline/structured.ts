/**
 * Structured extraction pipeline, one function per phase:
 *
 *  1. `analyzeDocument` — detailed walk of every target page, then the
 *     cross-page study of the analysis window (body style, repeating margin
 *     text).
 *  2. `segmentPages` — per page: region detection, rotation, margin filter,
 *     columns, lines and items.
 *  3. `runItemPasses` — ordered document-level passes over the draft items
 *     of every page (`itemPasses.ts`); each preset lists its passes
 *     (`createItemPasses`).
 *  4. `mapSentences` — per page: sentence mapping, region item placement and
 *     margin items.
 *  5. `project` — the public structured result: projection and ids.
 *
 * `runExtractFromIndices` (`worker/ops.ts`) runs steps 1–4; the op wrappers
 * run step 5 on its result.
 *
 * Worker code: import package internals directly, never the `../index`
 * barrel (see `worker/ops.ts`).
 */

import { getEffectiveRepeatThreshold } from "../MarginFilter";
import { logColumnDetection } from "../ColumnDetector";
import { documentBodyExtents, regionFurnitureLines } from "../FilteredParagraphPipeline";
import { detectDominantTextOrientation, rotateBBox, type RotationAngle } from "../PageRotationNormalizer";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type { SentenceSplitter } from "../SentenceMapper";
import type {
    DegradationSummary,
    InternalExtractionResult,
    InternalProcessedPage,
    RawLine,
    RawPageData,
    RawPageDataDetailed,
    StructuredPagePhaseTimings,
    StyleProfile,
} from "@beaver/agent-core/extract/types";
import { bboxFromXYWH } from "@beaver/agent-core/extract/types";
import {
    ITEM_KINDS,
    assignDocumentIds,
    projectStructuredPage,
    type ExtractionDebug,
    type PdfExtractionPreset,
    type StructuredExtractResult,
} from "../schema";
import { ITEM_TYPE_PASS, itemTypePass } from "../itemTypes/pass";
import { REFERENCE_PASS, referencePass } from "../references/pass";
import { detectRegions } from "../regions/RegionDetector";
import { pageImageHashes, pageRegionDocContext } from "../regions/docContext";
import { regionItemsForPage, type PageRegionItems, type RegionItemDraft } from "../regions/regionItems";
import { REGION_MODEL } from "../regions/weights";
import { postLog } from "../worker/errors";
import { extractRawPageDetailedFromDoc } from "../worker/docHelpers";
import type { DocumentLike, FontApi } from "../worker/mupdfApi";
import type { GraphicsSummary } from "../worker/graphicsSummary";
import { DEFAULT_REGION_CONTEXT_PAGES } from "../worker/regionOps";
import {
    detectPageParagraphs,
    mapPageSentences,
    type PageParagraphs,
    type PageSentenceArgs,
} from "../worker/sentenceExtraction";
import {
    buildAnalysisFromDoc,
    type DocumentAnalysisContext,
    type PageWalkCache,
    type ResolvedExtractionSettings,
} from "./documentAnalysis";
import { runPasses, type ItemPass, type PagePassTimings } from "./itemPasses";
import { pageLabelsToStringKeys, projectColumnRect, replaceControlCharsInResult } from "./output";

/** Item pass factories, by the name presets list them under. */
const ITEM_PASSES: Record<ItemPassName, () => ItemPass> = {
    references: () => referencePass({ classify: true }),
};

export type ItemPassName = PdfExtractionPreset["itemPasses"][number];

/**
 * The item passes of a preset, in order: the item-type pass first when the
 * preset turns the model on, then the preset's listed passes.
 */
export function createItemPasses(preset: PdfExtractionPreset): ItemPass[] {
    return [
        ...(preset.itemTypeModel ? [itemTypePass({ referencePass: preset.itemPasses.includes("references") })] : []),
        ...preset.itemPasses.map((name) => ITEM_PASSES[name]()),
    ];
}

/** Inputs shared by the per-page phases of one structured run. */
export interface StructuredRunContext {
    doc: DocumentLike;
    opts: ResolvedExtractionSettings;
    requestedRepeatThreshold: number | undefined;
    pageCount: number;
    pageCache: PageWalkCache | undefined;
    paragraphSettings: ParagraphDetectionSettings | undefined;
    splitter: SentenceSplitter;
}

/** Step 1 result: the analysis context plus the detailed target walks. */
export interface StructuredDocumentStudy extends DocumentAnalysisContext {
    /** Detailed walk of every target page. */
    detailedTargets: Map<number, RawPageDataDetailed>;
    /** Time each target's detailed walk took, attributed to that page. */
    detailedMsByTarget: Map<number, number>;
}

/** Step 2 result for one page. */
export interface SegmentedPage {
    rawPage: RawPageData;
    paragraphs: PageParagraphs;
    regions?: Pick<PageSentenceArgs, "regionItems" | "regionMargin" | "regionsMs">;
    /** Page time so far: its detailed walk and segmentation. */
    ms: number;
}

/** Step 4 result. */
export interface MappedPages {
    pages: InternalProcessedPage[];
    perPageMs: number[];
    perPagePhases: StructuredPagePhaseTimings[];
}

/**
 * Step 1. Walks every target page in detailed mode first, so the
 * analysis-window step can reuse those walks instead of duplicating them
 * with a JSON walk.
 *
 * The detailed walk carries every field a JSON walk produces (line bbox,
 * font family/weight/style/size — the WASM `_wasm_font_*` helpers populate
 * the line font directly, so no separate `RawFontBridge` pass is needed for
 * the target page). Target pages therefore incur exactly one walk even when
 * they also live in the analysis window (the `analysisWindow=0` default).
 *
 * `walkMs` folds the detailed walks into the same counter the markdown
 * engines use, so profilers see a single "walk" total.
 */
export function analyzeDocument(
    doc: DocumentLike,
    opts: ResolvedExtractionSettings,
    requestedRepeatThreshold: number | undefined,
    targetIndices: number[],
    analysisIndices: number[],
    pageCount: number,
    fontApi: FontApi | undefined,
    pageCache: PageWalkCache | undefined,
    pageNumberRuns: boolean,
): StructuredDocumentStudy {
    if (!fontApi) {
        throw new Error(
            "runExtractFromIndices: engine='structured' requires a `fontApi` argument so the detailed walker can populate line fonts",
        );
    }
    const tPreWalk = performance.now();
    const detailedTargets = new Map<number, RawPageDataDetailed>();
    const detailedMsByTarget = new Map<number, number>();
    const preWalkedTargets = new Map<number, RawPageData>();
    for (const i of targetIndices) {
        const tTargetPreWalk = performance.now();
        // Reuse the OCR gate's walk of this page when the shared cache is
        // present; otherwise walk it fresh. The pipeline never needs image
        // blocks, so a page the gate did not already sample is walked
        // without them. Structured extraction is full-document canonical
        // output, so a page that fails to walk fails the extraction.
        const detailed = pageCache
            ? pageCache.getDetailed(i, false)
            : extractRawPageDetailedFromDoc(doc, i, false, fontApi);
        detailedMsByTarget.set(i, performance.now() - tTargetPreWalk);
        detailedTargets.set(i, detailed);
        // `RawPageDataDetailed` is structurally a `RawPageData` (readonly
        // arrays make blocks/lines covariant). Reusing the same object keeps
        // `pagesForFilterWithBridgedFonts` a no-op for the target page later on.
        preWalkedTargets.set(i, detailed as unknown as RawPageData);
    }
    const preWalkMs = performance.now() - tPreWalk;

    const analysis = buildAnalysisFromDoc(
        doc,
        opts,
        requestedRepeatThreshold,
        analysisIndices,
        pageCount,
        preWalkedTargets,
        pageCache,
        pageNumberRuns,
    );
    return {
        ...analysis,
        walkMs: analysis.walkMs + preWalkMs,
        detailedTargets,
        detailedMsByTarget,
    };
}

/**
 * Step 2. Region detection (with the preset's `regions`) and paragraph
 * detection for every target page, before any document-level item pass.
 */
export function segmentPages(
    ctx: StructuredRunContext,
    study: StructuredDocumentStudy,
    targetIndices: number[],
): SegmentedPage[] {
    const { opts, pageCache, pageCount } = ctx;
    const { analysisPages, analysisPageByIndex, marginRemoval, marginAnalysis, styleProfile, compoundVocabulary } = study;
    const regionImages = pageCache?.regions ? new Map<number, Set<number>>() : undefined;
    // Region detection keeps the document's running headers and footers out of regions.
    const bodyExtents = regionImages
        ? documentBodyExtents(analysisPages, { marginRemoval, styleProfile, margins: opts.margins, marginZone: opts.marginZone, marginTextRows: opts.marginTextRows })
        : new Map<string, { top: number; bottom: number }>();
    const runningRepeat = getEffectiveRepeatThreshold({
        requested: ctx.requestedRepeatThreshold,
        totalPageCount: pageCount,
        analysisPageCount: analysisPages.length,
    }).topBottom;
    if (regionImages) {
        for (const i of targetIndices) {
            const graphics = pageCache!.graphicsFor(i);
            if (graphics) regionImages.set(i, pageImageHashes(graphics));
        }
    }
    const segmented: SegmentedPage[] = [];
    for (const i of targetIndices) {
        const tPage = performance.now();
        const rawPage = analysisPageByIndex.get(i)!;
        const preWalkedDetailedMs = study.detailedMsByTarget.get(i) ?? 0;
        let detailed = study.detailedTargets.get(i);
        let regionItems: RegionItemDraft[] | undefined;
        let regionMargin: RawLine[] | undefined;
        let regionsMs: number | undefined;
        let pageRotation: RotationAngle | undefined;
        let pagesForTarget = analysisPages;
        if (regionImages && detailed) {
            const tRegions = performance.now();
            // Orientation is read from the full page: removing region text can
            // leave too little text to detect it.
            const rotation = detectDominantTextOrientation(detailed, opts.marginZone);
            // Running headers, footers and page numbers stay page furniture.
            const margin = regionFurnitureLines(detailed, {
                marginRemoval,
                marginAnalysis,
                styleProfile,
                margins: opts.margins,
                marginZone: opts.marginZone,
                marginTextRows: opts.marginTextRows,
                pageRotation: rotation,
                repeat: runningRepeat,
                bodyExtents,
            });
            const regions = pageRegions(detailed, pageCache!.graphicsFor(i), regionImages, pageCount, compoundVocabulary, margin);
            if (regions.page !== detailed) {
                // The target without absorbed lines replaces the walked page, so
                // paragraph detection never sees them (and no font bridge runs).
                pageRotation = rotation;
                const stripped = regions.page;
                pagesForTarget = analysisPages.map((p) =>
                    p.pageIndex === i ? (stripped as unknown as RawPageData) : p,
                );
                detailed = stripped;
            }
            regionItems = regions.items;
            regionMargin = regions.margin;
            regionsMs = performance.now() - tRegions;
        }
        const paragraphs = detectPageParagraphs({
            doc: ctx.doc,
            pageIndex: rawPage.pageIndex,
            analysisPages: pagesForTarget,
            splitter: ctx.splitter,
            paragraphSettings: ctx.paragraphSettings,
            marginRemoval,
            styleProfile,
            compoundVocabulary,
            margins: opts.margins,
            marginZone: opts.marginZone,
            graphicsLayerMode: opts.graphicsLayerMode,
            // Reuse the detailed walk done in `analyzeDocument` so we don't pay
            // a second walk per target page.
            preWalkedDetailed: detailed,
            preWalkedDetailedMs,
            regionItems,
            regionMargin,
            regionsMs,
            pageRotation,
        });
        const { pageRotation: rotation, sourceWidth, sourceHeight, columnResult } = paragraphs.filteredResult;
        paragraphs.draft.columns = columnResult.columns.map((col) => bboxFromXYWH(col.x, col.y, col.w, col.h, "top-left"));
        paragraphs.draft.frame = { rotation, sourceWidth, sourceHeight };
        if (regionItems) {
            paragraphs.draft.regions = regionItems.map((region) => ({
                kind: region.kind,
                bbox: rotation !== 0 ? rotateBBox(region.bbox, rotation, sourceWidth, sourceHeight) : region.bbox,
            }));
        }
        segmented.push({
            rawPage,
            paragraphs,
            regions: regionItems !== undefined ? { regionItems, regionMargin, regionsMs } : undefined,
            ms: preWalkedDetailedMs + (performance.now() - tPage),
        });
    }
    return segmented;
}

/**
 * Step 3. Runs the item passes in order over the draft items of every page;
 * they edit them in place. Returns each page's pass timings.
 */
export function runItemPasses(
    pages: SegmentedPage[],
    study: Pick<StructuredDocumentStudy, "styleProfile" | "marginAnalysis" | "analysisPages">,
    pageCount: number,
    passes: readonly ItemPass[],
    paragraphSettings: ParagraphDetectionSettings | undefined,
): PagePassTimings[] {
    const doc = {
        pages: pages.map(({ paragraphs }) => paragraphs.draft),
        pageCount,
        styleProfile: study.styleProfile,
        marginAnalysis: study.marginAnalysis,
        analysisPageIndices: study.analysisPages.map((page) => page.pageIndex),
    };
    return runPasses(passes, doc, paragraphSettings);
}

/**
 * Step 4. Maps each page's paragraphs to sentences and assembles the internal
 * page. `content` is the paragraph detector's markdown, so structured-mode
 * `fullText` matches paragraph-engine markdown for the same pages.
 */
export function mapSentences(
    ctx: StructuredRunContext,
    pages: SegmentedPage[],
    passes: PagePassTimings[],
    compoundVocabulary: ReadonlySet<string>,
): MappedPages {
    const sentenceArgs = { paragraphSettings: ctx.paragraphSettings, splitter: ctx.splitter, compoundVocabulary };
    const out: MappedPages = { pages: [], perPageMs: [], perPagePhases: [] };
    pages.forEach(({ rawPage, paragraphs, regions, ms }, k) => {
        const tPage = performance.now();
        const { filteredResult } = paragraphs;
        const { passes: byPass, parts } = passes[k];
        let passMs = 0;
        for (const ms of Object.values(byPass)) passMs += ms;
        const passTimings: Partial<StructuredPagePhaseTimings> = {
            ...(byPass[REFERENCE_PASS] !== undefined ? { referencesMs: byPass[REFERENCE_PASS] } : {}),
            ...(byPass[ITEM_TYPE_PASS] !== undefined ? { itemTypesMs: byPass[ITEM_TYPE_PASS], ...parts } : {}),
        };
        const { sentenceResult, phaseTimings } = mapPageSentences(
            { ...sentenceArgs, ...regions },
            paragraphs,
            passTimings,
        );
        logColumnDetection(rawPage.pageIndex, filteredResult.columnResult);
        out.pages.push({
            index: sentenceResult.pageIndex,
            label: rawPage.label,
            // sentenceResult.width/height are already in MuPDF
            // frame (the mapper reports source dims).
            width: sentenceResult.width,
            height: sentenceResult.height,
            viewBox: rawPage.viewBox,
            rotation: rawPage.rotation,
            content: filteredResult.paragraphResult.pageContent,
            columns: filteredResult.columnResult.columns.map((col) =>
                projectColumnRect(
                    col,
                    filteredResult.pageRotation,
                    filteredResult.sourceWidth,
                    filteredResult.sourceHeight,
                ),
            ),
            items: sentenceResult.items,
            sentences: sentenceResult.sentences,
            degradation: sentenceResult.degradation,
        } as InternalProcessedPage);
        out.perPageMs.push(ms + passMs + (performance.now() - tPage));
        out.perPagePhases.push(phaseTimings);
    });
    return out;
}

/**
 * Step 5. The public structured result of an internal result.
 *
 * Only citable kinds are published. Margin items stay internal: no consumer
 * reads them, and watermarks drawn glyph by glyph can make them a large share
 * of a document. They are appended after all other items, so dropping them
 * leaves the other items' order and ids unchanged. Debug output keeps them as
 * `marginDecisions`.
 */
export function project(
    result: InternalExtractionResult,
    preset: PdfExtractionPreset,
    bboxPrecision: number,
    includeDiagnostics = false,
    debug?: ExtractionDebug,
): StructuredExtractResult {
    replaceControlCharsInResult(result, preset);
    const pages = result.pages.map((page) =>
        projectStructuredPage(
            { ...page, items: page.items.filter((item) => ITEM_KINDS[item.kind].citable) },
            bboxPrecision,
        ),
    );
    assignDocumentIds(pages, preset.idScheme);
    const degradation = degradationSummary(result);
    const pageDegradation = degradationByPage(result);
    const mergedDebug: ExtractionDebug | undefined = pageDegradation
        ? {
            ...(debug ?? {}),
            degradation: {
                ...pageDegradation,
                ...(debug?.degradation ?? {}),
            },
        }
        : debug;
    return {
        mode: "structured",
        schemaVersion: preset.schemaVersion,
        createdAt: result.metadata.extractedAt,
        // Profiling/diagnostics payload is opt-in.
        ...(includeDiagnostics
            ? {
                diagnostics: {
                    settings: result.metadata.settings,
                    engine: "structured",
                    timings: result.metadata.timings,
                    ...(degradation ? { degradation } : {}),
                },
            }
            : {}),
        document: {
            pageCount: result.analysis.pageCount,
            pageLabels: pageLabelsToStringKeys(result.pageLabels),
            bboxOrigin: "top-left",
            bboxPrecision,
            pages,
        },
        ...(mergedDebug ? { debug: mergedDebug } : {}),
    };
}

/**
 * Region items of one page and the page without the lines they absorb. A page
 * the detector fails on keeps its text as prose; the failure is logged.
 */
function pageRegions(
    page: RawPageDataDetailed,
    graphics: GraphicsSummary | undefined,
    imagesByPage: ReadonlyMap<number, ReadonlySet<number>>,
    pageCount: number,
    vocabulary: ReadonlySet<string>,
    margin: ReadonlySet<RawLine>,
): PageRegionItems {
    if (!graphics || !REGION_MODEL) {
        throw new Error(`Region detection needs a graphics summary and a model (page ${page.pageIndex})`);
    }
    try {
        const detection = detectRegions(page, graphics, {
            pageIndex: page.pageIndex,
            doc: pageRegionDocContext(page.pageIndex, imagesByPage, pageCount, DEFAULT_REGION_CONTEXT_PAGES),
            model: REGION_MODEL,
            route: true,
            margin,
        });
        return regionItemsForPage(page, detection, vocabulary);
    } catch (err) {
        postLog("warn", `[mupdf-worker] region detection failed on page ${page.pageIndex}: ${String(err)}`);
        return { page, items: [], margin: [] };
    }
}

function degradationSummary(result: InternalExtractionResult):
    | { totalCount: number; pageCount: number }
    | undefined {
    let totalCount = 0;
    let pageCount = 0;
    for (const page of result.pages) {
        const count = page.degradation?.count ?? 0;
        if (count > 0) {
            totalCount += count;
            pageCount += 1;
        }
    }
    return totalCount > 0 ? { totalCount, pageCount } : undefined;
}

function degradationByPage(
    result: InternalExtractionResult,
): Record<string, DegradationSummary> | undefined {
    const byPage: Record<string, DegradationSummary> = {};
    for (const page of result.pages) {
        if (!page.degradation || page.degradation.count <= 0) continue;
        byPage[String(page.index)] = page.degradation;
    }
    return Object.keys(byPage).length > 0 ? byPage : undefined;
}
