/**
 * Worker op handlers.
 *
 * Each op opens the document via `acquireDoc` (which routes through the
 * short-lived doc cache, see `./docCache.ts`), runs work in terms of the
 * worker-internal helpers, and returns `{ result, transfer? }`. The
 * dispatcher in `index.ts` posts the reply. Pair every `acquireDoc` with
 * `releaseDoc(doc)` in a finally block — never call `doc.destroy()`
 * directly from cached ops.
 *
 * IMPORTANT: do NOT import from `../index` (the barrel). It re-exports
 * `MuPDFWorkerClient` (and the `BeaverExtractor` facade that wraps it), the
 * main-thread worker proxy that spawns workers via `getConfig()` URLs —
 * pulling it in here would try to spawn another worker from inside this
 * one. Import analyzers and types directly:
 *   import { StyleAnalyzer } from "../StyleAnalyzer";
 *   import type { RawPageData, InternalExtractionResult } from "../types";
 */

import { DocumentAnalyzer, type RawPageProvider } from "../DocumentAnalyzer";
import { StyleAnalyzer } from "../StyleAnalyzer";
import { MarginFilter, getEffectiveRepeatThreshold } from "../MarginFilter";
import { PageExtractor } from "../PageExtractor";
import { buildPageAnalysisContext } from "../PageAnalysisContext";
import { resolveAnalysisPages } from "../AnalysisWindow";
import { detectColumns, logColumnDetection } from "../ColumnDetector";
import { setAnalyzerLogging } from "../logging";
import type { PageLine } from "../LineDetector";
import {
    collectMarginItemsFromFilteredPage,
    detectFilteredParagraphs,
    reindexMarginItems,
} from "../FilteredParagraphPipeline";
import {
    inverseRotateBBox,
    type RotationAngle,
} from "../PageRotationNormalizer";
import { SearchScorer } from "../SearchScorer";
import type {
    DocumentAnalysis,
    BoundingBox,
    DocItem,
    InternalExtractionResult,
    ExtractionSettings,
    ItemLine,
    LayoutAnalysisResult,
    MarginAnalysis,
    MarginRemovalResult,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFMetadata,
    PDFPageSearchResult,
    PDFSearchOptions,
    PDFSearchResult,
    InternalProcessedPage,
    RawPageData,
    RawPageDataDetailed,
    StructuredPagePhaseTimings,
    StyleProfile,
    DegradationSummary,
} from "../types";
import {
    DEFAULT_EXTRACTION_SETTINGS,
    DEFAULT_MARGIN_ZONE,
    DEFAULT_PDF_SEARCH_OPTIONS,
    DEFAULT_SEARCH_SCORING_OPTIONS,
    shouldProbeGraphicsLayer,
    bboxFromXYWH,
    bboxHeight,
    bboxWidth,
} from "../types";
import {
    SCHEMA_VERSION,
    assignDocumentIds,
    buildCitationIndex,
    projectStructuredPage,
    type BeaverExtractResult,
    type ExtractionDebug,
    type DebugSentence,
    type MarkdownExtractResult,
    type StructuredExtractResult,
    type StructuredExtractWithDebugResult,
} from "../schema";
import { bboxToRect } from "../schema/bbox";
import type {
    SentenceTraceResult,
    WorkerSentenceDebugOptions,
} from "../sentenceTypes";
import { ERROR_CODES, postLog, workerError } from "./errors";
import { isRecoverablePageError } from "../wasmFatal";
import { acquireDoc, releaseDoc } from "./docCache";
import { ensureApi } from "./wasmInit";
import {
    extractSentencesForPage,
    runSentenceExtractionFromDoc,
} from "./sentenceExtraction";
import { resolveSplitter } from "./splitterResolver";
import type { SentenceSplitter } from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type { SentenceSplitterConfig } from "../sentenceTypes";
import {
    DEFAULT_PAGE_IMAGE_OPTIONS,
    collectDocumentInfo,
    collectPageLabels,
    collectPagesData,
    extractGraphicsFromDoc,
    extractRawPageDetailedFromDoc,
    assertDocumentHasPages,
    extractRawPageFromDoc,
    filterToDividerLines,
    filterToContainerRects,
    rawPageProviderFromDoc,
    renderOnePage,
    resolveExplicitPageIndicesOrThrow,
    resolvePageIndices,
    resolvePageRangeOrThrow,
    resolveTruePageCount,
    searchPageInDoc,
} from "./docHelpers";
import type { DocumentLike, FontApi } from "./mupdfApi";

export interface OpReply<T = unknown> {
    result: T;
    transfer?: Transferable[];
}

// ---------------------------------------------------------------------------
// PR #1 / PR #2 carry-forward ops — semantics must remain byte-identical.
// ---------------------------------------------------------------------------

export async function opGetPageCount(args: { pdfData: Uint8Array | ArrayBuffer }): Promise<OpReply<{ count: number }>> {
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        return { result: { count: doc.countPages() } };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

export async function opGetMetadata(
    args: { pdfData: Uint8Array | ArrayBuffer },
): Promise<OpReply<PDFMetadata>> {
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        const pageCount = doc.countPages();
        const { pageLabels, pages } = collectPagesData(doc);
        const info = collectDocumentInfo(doc);
        return { result: { pageCount, pageLabels, pages, ...info } };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

export async function opExtractRawPageDetailed(
    args: { pdfData: Uint8Array | ArrayBuffer; pageIndex: number; includeImages?: boolean },
): Promise<OpReply<RawPageDataDetailed>> {
    const api = await ensureApi();
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        const pageCount = doc.countPages();
        if (
            typeof args.pageIndex !== "number" ||
            args.pageIndex < 0 ||
            args.pageIndex >= pageCount
        ) {
            throw workerError(
                ERROR_CODES.PAGE_OUT_OF_RANGE,
                `Page index ${args.pageIndex} out of range (0..${pageCount - 1})`,
            );
        }
        const result = extractRawPageDetailedFromDoc(
            doc,
            args.pageIndex,
            !!args.includeImages,
            api.Font,
        );
        return { result };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

/**
 * Strict, fused render-pages op for the images handler.
 *
 * Returns metadata alongside the rendered pages in a single doc-open so
 * the handler can populate `total_pages` and per-page `page_label` in
 * the response without an extra round-trip. Image buffers are
 * transferred (per-page `r.data.buffer`).
 */
export async function opRenderPages(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        pageIndices?: number[];
        pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        options?: PageImageOptions;
    },
): Promise<OpReply<{ pageCount: number; pageLabels: Record<number, string>; pages: PageImageResult[] }>> {
    const api = await ensureApi();
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...(args.options || {}) };
        // `resolveTruePageCount` (not `doc.countPages()`): a corrupt PDF can
        // advertise a positive `/Root/Pages/Count` whose page tree resolves
        // to zero pages. Two `assertDocumentHasPages` guards, both required:
        //  - before: a genuinely page-less document makes the `loadPage(0)`
        //    probe throw a raw "invalid page number" error.
        //  - after: `resolveTruePageCount` can correct an advertised count
        //    down to 0, which would otherwise let `renderOnePage` throw a
        //    raw "invalid page number" instead of a classified error.
        assertDocumentHasPages(doc.countPages());
        const pageCount = resolveTruePageCount(doc);
        assertDocumentHasPages(pageCount);
        const pageLabels = collectPageLabels(doc);
        const indices = args.pageRange
            ? resolvePageRangeOrThrow(pageCount, args.pageRange)
            : resolveExplicitPageIndicesOrThrow(pageCount, args.pageIndices);
        const out: PageImageResult[] = [];
        const transfer: Transferable[] = [];
        for (const pageIndex of indices) {
            const r = renderOnePage(api, doc, pageIndex, opts);
            out.push(r);
            transfer.push(r.data.buffer);
        }
        return {
            result: { pageCount, pageLabels, pages: out },
            transfer,
        };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

/**
 * Per-`opExtract` page-walk cache.
 *
 * The OCR gate (`DocumentAnalyzer`) samples a spread of pages across the
 * document, and the extraction pipeline then walks every target/analysis
 * page. For a whole-document extract every sampled page is also a
 * pipeline page, so without sharing each such page's `toStructuredText`
 * walk runs twice — once for the gate, once for extraction. The doubling
 * is invisible on cheap pages but doubles the wall time of a page that is
 * expensive to walk (heavy vector content, redraw-stamped text layers).
 *
 * This cache memoizes the walk so each page is walked at most once per
 * `opExtract` call: the gate populates it, the pipeline reuses it.
 *
 * `includeImages` only takes effect on a cache MISS. It is the OCR gate,
 * not the extraction pipeline, that needs image blocks (to measure
 * scanned-page coverage). The gate always runs first, so the pages it
 * samples are walked WITH images and the pipeline reuses them as-is —
 * image blocks are inert for every downstream text consumer (line /
 * column / paragraph / margin / sentence detection all filter to
 * `type === "text"`). Pages the gate did not sample — and every page
 * when `checkTextLayer` is off and the gate never runs — are walked by
 * the pipeline WITHOUT images, exactly as before this cache existed.
 *
 *  - `getPlain`    — JSON-walk pages for the markdown engines and the
 *                    markdown-mode gate.
 *  - `getDetailed` — per-char detailed-walk pages for structured
 *                    extraction and the structured-mode gate.
 */
class PageWalkCache {
    private readonly plain = new Map<number, RawPageData>();
    private readonly detailed = new Map<number, RawPageDataDetailed>();

    constructor(
        private readonly doc: DocumentLike,
        private readonly fontApi?: FontApi,
    ) {}

    getPlain(pageIndex: number, includeImages: boolean): RawPageData {
        let page = this.plain.get(pageIndex);
        if (!page) {
            page = extractRawPageFromDoc(this.doc, pageIndex, { includeImages });
            this.plain.set(pageIndex, page);
        }
        return page;
    }

    getDetailed(pageIndex: number, includeImages: boolean): RawPageDataDetailed {
        let page = this.detailed.get(pageIndex);
        if (!page) {
            page = extractRawPageDetailedFromDoc(
                this.doc,
                pageIndex,
                includeImages,
                this.fontApi,
            );
            this.detailed.set(pageIndex, page);
        }
        return page;
    }
}

/**
 * Shared analysis-context prefix for `runExtractFromIndices` and
 * `opAnalyzeLayout`. Walks the analysis-window pages once and runs the
 * cross-page `buildPageAnalysisContext` (StyleAnalyzer + MarginFilter)
 * over them.
 *
 * Both extract and analyzeLayout call this so they see the SAME
 * `marginRemoval` / `marginAnalysis` / `styleProfile` for the same input
 * `analysisIndices`. This is what guarantees the margins overlay (built
 * on `analyzeLayout`'s output) and structured extract agree on a given
 * page's filter decisions.
 *
 * Caller resolves `analysisIndices` (typically via `resolveAnalysisPages`)
 * and supplies the document's total `pageCount` (so
 * `getEffectiveRepeatThreshold` can apply the short-doc relaxation).
 *
 * `preWalked` lets the structured branch reuse target-page detailed
 * walks (which carry every field a JSON walk produces — line bbox,
 * font, page dims — with the WASM font helpers wired up). Indices in
 * the map are NOT re-walked; everything else gets a JSON walk as
 * before. This is what eliminates the redundant per-target JSON walk
 * for structured mode when `analysisWindow=0`.
 */
function buildAnalysisFromDoc(
    doc: DocumentLike,
    opts: ExtractionSettings,
    requestedRepeatThreshold: number | undefined,
    analysisIndices: number[],
    pageCount: number,
    preWalked?: Map<number, RawPageData>,
    pageCache?: PageWalkCache,
): {
    analysisPages: RawPageData[];
    analysisPageByIndex: Map<number, RawPageData>;
    styleProfile: StyleProfile;
    marginAnalysis: MarginAnalysis;
    marginRemoval: MarginRemovalResult;
    walkMs: number;
    analysisMs: number;
} {
    const tWalkStart = performance.now();
    const analysisPages: RawPageData[] = [];
    for (const i of analysisIndices) {
        const pre = preWalked?.get(i);
        if (pre) {
            analysisPages.push(pre);
            continue;
        }
        try {
            analysisPages.push(
                pageCache
                    ? pageCache.getPlain(i, false)
                    : extractRawPageFromDoc(doc, i),
            );
        } catch (err) {
            // A malformed page tree can fail to resolve individual leaves.
            // Skip the bad page and keep going so one unresolvable page
            // does not abort the whole extraction (mirrors `mutool`).
            if (!isRecoverablePageError(err)) throw err;
            postLog(
                "warn",
                `[mupdf-worker] buildAnalysisFromDoc: skipping unresolvable page ${i}: ${String(err)}`,
            );
        }
    }
    const analysisPageByIndex = new Map<number, RawPageData>(
        analysisPages.map((p) => [p.pageIndex, p]),
    );
    const walkMs = performance.now() - tWalkStart;

    const tAnalysisStart = performance.now();
    const { styleProfile, marginAnalysis, marginRemoval } = buildPageAnalysisContext({
        pages: analysisPages,
        totalPageCount: pageCount,
        marginZone: opts.marginZone,
        repeatThreshold: requestedRepeatThreshold,
        detectPageSequences: opts.detectPageSequences,
    });
    const analysisMs = performance.now() - tAnalysisStart;
    StyleAnalyzer.logStyleProfile(styleProfile);
    MarginFilter.logRemovalCandidates(marginRemoval);

    return {
        analysisPages,
        analysisPageByIndex,
        styleProfile,
        marginAnalysis,
        marginRemoval,
        walkMs,
        analysisMs,
    };
}

function inverseMaybe<T extends { bbox: BoundingBox }>(
    value: T,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): T {
    return pageRotation === 0
        ? value
        : {
              ...value,
              bbox: inverseRotateBBox(
                  value.bbox,
                  pageRotation,
                  sourceWidth,
                  sourceHeight,
              ),
          };
}

function itemLinesFromPageLines(
    lines: PageLine[],
    fallbackText: string,
    fallbackBBox: BoundingBox,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): ItemLine[] {
    const mapped = lines.map((line) =>
        inverseMaybe(
            {
                text: line.text,
                bbox: line.bbox,
                fontSize: line.fontSize,
            },
            pageRotation,
            sourceWidth,
            sourceHeight,
        ),
    );
    if (mapped.length > 0) return mapped;
    return [
        inverseMaybe(
            { text: fallbackText, bbox: fallbackBBox },
            pageRotation,
            sourceWidth,
            sourceHeight,
        ),
    ];
}

function docItemsFromParagraphResult(
    paragraphResult: import("../ParagraphDetector").PageParagraphResult,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): DocItem[] {
    return paragraphResult.items.map((item, index) => {
        const bbox = pageRotation === 0
            ? item.bbox
            : inverseRotateBBox(item.bbox, pageRotation, sourceWidth, sourceHeight);
        const lines = itemLinesFromPageLines(
            paragraphResult.itemLines?.[index] ?? [],
            item.text,
            item.bbox,
            pageRotation,
            sourceWidth,
            sourceHeight,
        );
        const base = {
            id: `p${paragraphResult.pageIndex}:i${index}`,
            pageIndex: paragraphResult.pageIndex,
            index,
            bbox,
            columnIndex: item.columnIndex,
            text: item.text,
            lines,
        };
        if (item.type === "header") {
            return { ...base, kind: "section_header" as const, level: 1 };
        }
        return { ...base, kind: "text" as const };
    });
}

/**
 * Inverse-rotate a column rect (`{x, y, w, h}` in upright frame) back
 * to MuPDF coords and project into the `{l, t, r, b}` shape stored on
 * `InternalProcessedPage.columns`.
 */
function projectColumnRect(
    col: { x: number; y: number; w: number; h: number },
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): BoundingBox {
    const box = bboxFromXYWH(col.x, col.y, col.w, col.h, "top-left");
    return pageRotation === 0
        ? box
        : inverseRotateBBox(box, pageRotation, sourceWidth, sourceHeight);
}

/**
 * Shared body for `opExtract`. The per-page loop has three branches keyed
 * off `engine`:
 *   - `"paragraph"` → `detectFilteredParagraphs` produces
 *     `paragraphResult.pageContent` (`## ` headers, `\n\n` separators).
 *   - `"block"` → column detection + PageExtractor (block-based).
 *   - `"structured"` → `extractSentencesForPage` (per-page detailed walk
 *     + sentence mapping). Populates `items`, `sentences`, `columns`,
 *     plus paragraph-engine `content`.
 *     Requires `splitter` (resolved by the caller). Per-page detailed
 *     walk is the dominant cost — multi-page structured extracts pay
 *     N× this per the `targetIndices` length.
 *
 * The combination `engine === "structured"` && `markdown.engine` is
 * rejected upstream by `opExtract`. All other steps (raw extraction,
 * style + margin analysis, fullText assembly, analysis build) are
 * identical, and the result shape is the same `InternalExtractionResult` for
 * every branch — `version` and `engine` come from this single metadata
 * builder.
 *
 * The caller is responsible for opening the doc, resolving target +
 * analysis indices, collecting page labels, running the OCR text-layer
 * check, and (for structured engine) resolving the splitter. NO_TEXT_LAYER
 * needs `pageLabels` and `pageCount` in its payload, which the caller
 * already has.
 *
 * Index sets:
 *  - `targetIndices` — pages to process and emit in the result.
 *  - `analysisIndices` — superset used for cross-page style + margin
 *    analysis. With `analysisWindow=0` this equals `targetIndices`;
 *    with `N>0` it adds neighbors so margin smart-removal and the
 *    body-style estimate see more of the document. Walked once; the
 *    target loop reuses the cached pages.
 */
export function runExtractFromIndices(
    doc: DocumentLike,
    opts: Required<Omit<ExtractionSettings, 'pages' | 'minTextPerPage'>> & ExtractionSettings,
    requestedRepeatThreshold: number | undefined,
    targetIndices: number[],
    analysisIndices: number[],
    pageCount: number,
    pageLabels: Record<number, string>,
    engine: "block" | "paragraph" | "structured",
    paragraphSettings?: ParagraphDetectionSettings,
    splitter?: SentenceSplitter,
    fontApi?: FontApi,
    pageCache?: PageWalkCache,
): InternalExtractionResult {
    setAnalyzerLogging(!!opts.analyzerLogging);
    try {
    const tStart = performance.now();

    // Structured mode pre-walks every target in detailed mode FIRST so
    // the analysis-window step can reuse those walks instead of
    // duplicating them with a JSON walk. Markdown engines don't need
    // per-char data so they skip this and go straight to the JSON walk
    // inside `buildAnalysisFromDoc`.
    //
    // The detailed walk carries every field a JSON walk produces (line
    // bbox, font family/weight/style/size — the WASM `_wasm_font_*`
    // helpers populate the line font directly, so no separate
    // `RawFontBridge` pass is needed for the target page). Once both
    // walks become substitutable, target pages incur exactly one walk
    // even when they also live in the analysis window (the
    // `analysisWindow=0` default).
    let preWalkedTargets: Map<number, RawPageData> | undefined;
    let preWalkedDetailedTargets: Map<number, RawPageDataDetailed> | undefined;
    let preWalkedDetailedMsByTarget: Map<number, number> | undefined;
    let preWalkMs = 0;
    if (engine === "structured") {
        if (!fontApi) {
            throw new Error(
                "runExtractFromIndices: engine='structured' requires a `fontApi` argument so the detailed walker can populate line fonts",
            );
        }
        const tPreWalk = performance.now();
        preWalkedDetailedTargets = new Map<number, RawPageDataDetailed>();
        preWalkedDetailedMsByTarget = new Map<number, number>();
        preWalkedTargets = new Map<number, RawPageData>();
        for (const i of targetIndices) {
            const tTargetPreWalk = performance.now();
            let detailed: RawPageDataDetailed;
            try {
                // Reuse the OCR gate's walk of this page when the shared
                // cache is present; otherwise walk it fresh. The pipeline
                // never needs image blocks, so a page the gate did not
                // already sample is walked without them.
                detailed = pageCache
                    ? pageCache.getDetailed(i, false)
                    : extractRawPageDetailedFromDoc(doc, i, false, fontApi);
            } catch (err) {
                if (engine === "structured" || !isRecoverablePageError(err)) {
                    throw err;
                }
                // Markdown extraction can still skip an unresolvable leaf in
                // a malformed page tree. Structured extraction is
                // full-document canonical output and must fail instead.
                postLog(
                    "warn",
                    `[mupdf-worker] runExtractFromIndices: skipping unresolvable page ${i}: ${String(err)}`,
                );
                continue;
            }
            preWalkedDetailedMsByTarget.set(
                i,
                performance.now() - tTargetPreWalk,
            );
            preWalkedDetailedTargets.set(i, detailed);
            // `RawPageDataDetailed` is structurally a `RawPageData`
            // (readonly arrays make blocks/lines covariant). Reusing
            // the same object keeps `pagesForFilterWithBridgedFonts`
            // a no-op for the target page later on.
            preWalkedTargets.set(i, detailed as unknown as RawPageData);
        }
        preWalkMs = performance.now() - tPreWalk;
    }

    // Walk the analysis union once; targets are guaranteed to be in it
    // (resolveAnalysisPages always includes them), so the output loop
    // looks them up in the pre-walked map without re-extracting. Same
    // helper `opAnalyzeLayout` calls — keeps the prefix byte-identical
    // between extract and analyze.
    const {
        analysisPages,
        analysisPageByIndex,
        styleProfile,
        marginAnalysis,
        marginRemoval,
        walkMs: jsonWalkMs,
        analysisMs,
    } = buildAnalysisFromDoc(
        doc,
        opts,
        requestedRepeatThreshold,
        analysisIndices,
        pageCount,
        preWalkedTargets,
        pageCache,
    );
    // Fold the structured prewalk into the same `walkMs` counter the
    // markdown engines use. Profilers and the `timings` envelope see a
    // single "walk" total, regardless of whether the work was done as
    // a detailed pre-walk or a JSON walk inside `buildAnalysisFromDoc`.
    const walkMs = jsonWalkMs + preWalkMs;

    // Drop any target page that failed to walk (unresolvable leaf in a
    // malformed page tree). `buildAnalysisFromDoc` skips such pages, so they
    // are absent from `analysisPageByIndex`; the per-engine output loops below
    // rely on that lookup and would otherwise dereference `undefined`.
    const effectiveTargetIndices = targetIndices.filter((i) =>
        analysisPageByIndex.has(i),
    );
    if (effectiveTargetIndices.length === 0 && targetIndices.length > 0) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `None of the ${targetIndices.length} requested page(s) could be resolved (malformed page tree)`,
            { pageCount },
        );
    }

    const pages: InternalProcessedPage[] = [];
    const perPageMs: number[] = [];
    // Per-page phase breakdown — only populated by the structured branch.
    // Stays undefined on the final result for markdown engines so the
    // typings (perPagePhases: optional) match the engine's actual output.
    const perPagePhases: StructuredPagePhaseTimings[] = [];

    if (engine === "paragraph") {
        // Paragraph engine: line + paragraph detection produces markdown-shaped
        // page text via `paragraphResult.pageContent` (headers prefixed `## `,
        // paragraphs separated by `\n\n`). `detectFilteredParagraphs` accepts
        // the precomputed `marginRemoval` and `styleProfile` so it skips
        // re-running cross-page analysis.
        const probeGraphics = shouldProbeGraphicsLayer(opts.graphicsLayerMode);
        for (const i of effectiveTargetIndices) {
            const tPage = performance.now();
            const rawPage = analysisPageByIndex.get(i)!;
            // Gate the device walk on `graphicsLayerMode`. Skipping it
            // when off avoids the WASM→JS bridge cost per drawing
            // primitive (dominated by `fill_text` events on
            // text-dense pages) — restores v0.20 paragraph-engine
            // per-page performance for callers that don't need
            // tinted-display-container detection.
            const graphics = probeGraphics
                ? extractGraphicsFromDoc(doc, rawPage.pageIndex)
                : undefined;
            const fillBoundaries = graphics
                ? filterToContainerRects(graphics.fills, rawPage.width, rawPage.height)
                : undefined;
            const dividerLines = graphics
                ? filterToDividerLines(graphics.strokes, rawPage.width, rawPage.height)
                : undefined;
            const filtered = detectFilteredParagraphs({
                pages: analysisPages,
                pageIndex: rawPage.pageIndex,
                marginRemoval,
                styleProfile,
                margins: opts.margins,
                marginZone: opts.marginZone,
                paragraphSettings,
                fillBoundaries,
                dividerLines,
            });
            logColumnDetection(rawPage.pageIndex, filtered.columnResult);
            pages.push({
                index: rawPage.pageIndex,
                label: rawPage.label,
                // Always MuPDF-frame dims (rawPage came pre-rotation).
                width: rawPage.width,
                height: rawPage.height,
                viewBox: rawPage.viewBox,
                rotation: rawPage.rotation,
                content: filtered.paragraphResult.pageContent,
                // Column rects come out of the (possibly normalized)
                // pipeline in the upright working frame; project back
                // to MuPDF coords using the same source dims the
                // pipeline reported.
                columns: filtered.columnResult.columns.map((col) =>
                    projectColumnRect(
                        col,
                        filtered.pageRotation,
                        filtered.sourceWidth,
                        filtered.sourceHeight,
                    ),
                ),
                items: [
                    ...docItemsFromParagraphResult(
                        filtered.paragraphResult,
                        filtered.pageRotation,
                        filtered.sourceWidth,
                        filtered.sourceHeight,
                    ),
                    ...reindexMarginItems(
                        filtered.marginItems,
                        filtered.paragraphResult.items.length,
                    ),
                ],
            } as InternalProcessedPage);
            perPageMs.push(performance.now() - tPage);
        }
    } else if (engine === "structured") {
        // Structured engine: per-page detailed walk + paragraph-scoped
        // sentence mapping. Reuses the shared analysis context so margin
        // removal and the style profile run only once across the multi-page
        // extract. `content` is populated from the same paragraph result
        // the sentence mapper consumes, so structured-mode `fullText`
        // matches paragraph-engine markdown for the same pages.
        if (!splitter) {
            throw new Error(
                "runExtractFromIndices: engine='structured' requires a resolved `splitter` argument",
            );
        }
        for (const i of effectiveTargetIndices) {
            const tPage = performance.now();
            const rawPage = analysisPageByIndex.get(i)!;
            const preWalkedDetailedMs = preWalkedDetailedMsByTarget!.get(i) ?? 0;
            const { sentenceResult, filteredResult, phaseTimings } =
                extractSentencesForPage({
                    doc,
                    pageIndex: rawPage.pageIndex,
                    analysisPages,
                    splitter,
                    paragraphSettings,
                    marginRemoval,
                    styleProfile,
                    margins: opts.margins,
                    marginZone: opts.marginZone,
                    graphicsLayerMode: opts.graphicsLayerMode,
                    // Reuse the detailed walk done before
                    // `buildAnalysisFromDoc` so we don't pay a second
                    // walk per target page.
                    preWalkedDetailed: preWalkedDetailedTargets!.get(i),
                    preWalkedDetailedMs,
                });
            logColumnDetection(rawPage.pageIndex, filteredResult.columnResult);
            pages.push({
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
            perPageMs.push(preWalkedDetailedMs + (performance.now() - tPage));
            perPagePhases.push(phaseTimings);
        }
    } else {
        const pageExtractor = new PageExtractor({ styleProfile });

        for (const i of effectiveTargetIndices) {
            const tPage = performance.now();
            const rawPage = analysisPageByIndex.get(i)!;
            const filteredPage = MarginFilter.filterPageWithSmartRemoval(
                rawPage,
                opts.margins,
                opts.marginZone,
                marginRemoval,
                styleProfile.bodyStyles,
                styleProfile.primaryBodyStyle,
            );
            const marginItems = collectMarginItemsFromFilteredPage(
                rawPage,
                filteredPage,
            );
            const columnResult = detectColumns(filteredPage, {
                headerMargin: opts.margins.top,
                footerMargin: opts.margins.bottom,
                bodyStyles: styleProfile.bodyStyles,
                debug: !!opts.analyzerLogging,
            });
            logColumnDetection(rawPage.pageIndex, columnResult);

            const page = pageExtractor.extractPageWithColumns(
                filteredPage,
                columnResult,
                true,
            );
            page.items = [
                ...page.items,
                ...reindexMarginItems(marginItems, page.items.length),
            ];
            pages.push(page);
            perPageMs.push(performance.now() - tPage);
        }
    }

    const fullText = pages.map((p) => p.content).join("\n\n");
    const analysis: DocumentAnalysis = {
        pageCount,
        hasTextLayer: true,
        styleProfile,
        marginAnalysis,
    };

    const finalSettings = { ...opts };
    const recordedEngine: "block" | "paragraph" | "structured" = engine;

    const totalMs = performance.now() - tStart;
    const baseResult: InternalExtractionResult = {
        pages,
        analysis,
        fullText,
        pageLabels: Object.keys(pageLabels).length > 0 ? pageLabels : undefined,
        metadata: {
            extractedAt: new Date().toISOString(),
            version: SCHEMA_VERSION,
            settings: finalSettings,
            engine: recordedEngine,
            // `docOpenMs` is unknown to this helper (the doc is already open
            // when we're called). `opExtract` writes it onto the returned
            // result after we return. Default to 0 so the field always exists.
            timings: {
                totalMs,
                docOpenMs: 0,
                walkMs,
                analysisMs,
                perPageMs,
                // Only emit the structured per-page phase array when
                // the structured branch ran. Markdown engines never push
                // into `perPagePhases`, so it stays empty there and we
                // omit the field entirely — undefined signals "no phase
                // breakdown available" to downstream consumers.
                ...(perPagePhases.length > 0
                    ? { perPagePhases }
                    : {}),
            },
        },
    };

    return baseResult;
    } finally {
        setAnalyzerLogging(false);
    }
}

function pageLabelsToStringKeys(
    pageLabels?: Record<number, string>,
): Record<string, string> | undefined {
    if (!pageLabels || Object.keys(pageLabels).length === 0) return undefined;
    return Object.fromEntries(
        Object.entries(pageLabels).map(([index, label]) => [String(index), label]),
    );
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

function translateDegradationItemIds(
    degradation: DegradationSummary | undefined,
    itemIdByInternalId: Map<string, string>,
): DegradationSummary | undefined {
    if (!degradation) return undefined;
    return {
        ...degradation,
        notes: degradation.notes.map((note) => ({
            ...note,
            itemId: itemIdByInternalId.get(note.itemId) ?? note.itemId,
        })),
    };
}

function toMarkdownExtractResult(
    result: InternalExtractionResult,
    includeDiagnostics = false,
): MarkdownExtractResult {
    return {
        mode: "markdown",
        schemaVersion: SCHEMA_VERSION,
        createdAt: result.metadata.extractedAt,
        // Profiling/diagnostics payload is opt-in.
        ...(includeDiagnostics
            ? {
                diagnostics: {
                    settings: result.metadata.settings,
                    engine: result.metadata.engine ?? "paragraph",
                    timings: result.metadata.timings,
                },
            }
            : {}),
        document: {
            pageCount: result.analysis.pageCount,
            pageLabels: pageLabelsToStringKeys(result.pageLabels),
            pages: result.pages.map((page) => ({
                index: page.index,
                label: page.label,
                width: page.width,
                height: page.height,
                viewBox: page.viewBox,
                rotation: page.rotation,
                markdown: page.content,
            })),
        },
    };
}

function toStructuredExtractResult(
    result: InternalExtractionResult,
    bboxPrecision: number,
    includeDiagnostics = false,
    debug?: ExtractionDebug,
): StructuredExtractResult {
    const pages = result.pages.map((page) =>
        projectStructuredPage(page, bboxPrecision),
    );
    assignDocumentIds(pages);
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
        schemaVersion: SCHEMA_VERSION,
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
            citationIndex: buildCitationIndex(pages),
        },
        ...(mergedDebug ? { debug: mergedDebug } : {}),
    };
}

function buildDebugProjection(
    internal: InternalExtractionResult,
    structured: StructuredExtractResult,
    capturePages: number[],
    precision: number,
    full = false,
): ExtractionDebug {
    const capture = new Set(capturePages);
    const pages: NonNullable<ExtractionDebug["pages"]> = {};
    const degradation: NonNullable<ExtractionDebug["degradation"]> = {};
    for (const page of internal.pages) {
        if (!capture.has(page.index)) continue;
        const structuredPage = structured.document.pages.find(
            (candidate) => candidate.index === page.index,
        );
        const itemIdByInternalId = new Map(
            (structuredPage?.items ?? []).map((item) => [
                `p${page.index}:i${item.order}`,
                item.id,
            ]),
        );
        const pageDegradation = translateDegradationItemIds(
            page.degradation,
            itemIdByInternalId,
        );
        const internalSentencesByParent = new Map(
            (page.sentences ?? []).map((sentence) => [
                `${sentence.parentId}:${sentence.index}`,
                sentence,
            ]),
        );
        const sentences: DebugSentence[] = structuredPage?.items.flatMap((item) =>
            "sentences" in item
                ? (item.sentences ?? []).map((sentence) => {
                    const internalSentence = internalSentencesByParent.get(
                        `p${page.index}:i${item.order}:${sentence.order}`,
                    );
                    return {
                        ...sentence,
                        itemId: item.id,
                        ...(internalSentence?.fragments?.length
                            ? {
                                fragments: internalSentence.fragments.map((fragment) => ({
                                    lineIndex: fragment.lineIndex,
                                    text: fragment.text,
                                    bbox: bboxToRect(fragment.bbox, precision),
                                })),
                            }
                            : {}),
                    };
                })
                : [],
        ) ?? [];
        pages[String(page.index)] = {
            pageIndex: page.index,
            pageLabel: page.label,
            width: page.width,
            height: page.height,
            counts: {
                items: structuredPage?.items.length ?? page.items.length,
                sentences: sentences.length,
                columns: page.columns.length,
                lines: page.items.reduce((sum, item) => (
                    "lines" in item ? sum + item.lines.length : sum
                ), 0),
            },
            columns: page.columns.map((bbox) => bboxToRect(bbox, precision)),
            items: structuredPage?.items,
            sentences,
            marginCandidates: internal.analysis.marginAnalysis.elements
                ? Array.from(internal.analysis.marginAnalysis.elements.entries())
                    .flatMap(([position, elements]) =>
                        elements
                            .filter((element) => element.pageIndex === page.index)
                            .map((element) => ({
                                text: element.text,
                                position,
                                bbox: bboxToRect(element.bbox, precision),
                            })),
                    )
                : undefined,
            ...(full
                ? {
                    lines: page.items.flatMap((item) =>
                        "lines" in item
                            ? item.lines.map((line, offset) => ({
                                id: `${item.id}:l${offset}`,
                                text: line.text,
                                bbox: bboxToRect(line.bbox, precision),
                                columnIndex: item.columnIndex,
                            }))
                            : [],
                    ),
                    sentenceFragments: sentences.flatMap((sentence) => sentence.fragments ?? []),
                    styleProfile: serializeStyleProfile(internal.analysis.styleProfile),
                    marginDecisions: page.items
                        .filter((item) => item.kind === "margin")
                        .map((item) => ({
                            id: item.id,
                            text: "text" in item ? item.text : undefined,
                            bbox: bboxToRect(item.bbox, precision),
                        })),
                }
                : {}),
            ...(pageDegradation ? { degradation: pageDegradation } : {}),
        };
        if (pageDegradation) {
            degradation[String(page.index)] = pageDegradation;
        }
    }
    return {
        pages,
        ...(Object.keys(degradation).length > 0 ? { degradation } : {}),
    };
}

function serializeStyleProfile(styleProfile: StyleProfile): unknown {
    return {
        primaryBodyStyle: styleProfile.primaryBodyStyle,
        bodyStyles: styleProfile.bodyStyles,
        topStyles: Array.from(styleProfile.styleCounts.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 20)
            .map(({ count, style }) => ({ count, style })),
    };
}

/**
 * Strict, fused extract op for the agent handlers.
 *
 * Fuses page-count + page-labels + OCR check + extract into a single
 * doc-open. Uses the strict resolvers — explicit-but-all-invalid page
 * inputs throw PAGE_OUT_OF_RANGE with `{ pageCount }` in the payload so
 * handlers can populate `total_pages` in error responses.
 *
 * `mode` selects the output product:
 *   - `"markdown"` (default) returns per-page text via the markdown
 *     engines below.
 *   - `"structured"` returns the same `InternalExtractionResult` shape with
 *     `pages[i].sentences` / `items` / `columns`
 *     populated alongside paragraph-engine `content`. Per-page detailed
 *     walk is the dominant cost — multi-page structured extracts pay
 *     N× this per the requested page count.
 *
 * `markdown.engine` selects the markdown engine when `mode === "markdown"`:
 *   - `"paragraph"` (default): line + paragraph detection via
 *     `detectFilteredParagraphs`. `InternalProcessedPage.content` is
 *     `paragraphResult.pageContent` (markdown-shaped with `## ` headers
 *     and `\n\n` paragraph separators).
 *   - `"block"`: block-based PageExtractor.
 *
 * Rejected combinations:
 *   - `mode === "structured"` && `markdown.engine` is set —
 *     `markdown.engine` is meaningless in structured mode.
 *
 * `structured.splitterConfig` (only consulted when `mode ===
 * "structured"`) is a serializable splitter config — the worker
 * resolves the actual splitter via `resolveSplitter`. Default:
 * `{ type: "sentencex" }`.
 */
export async function opExtract(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        mode?: "markdown" | "structured";
        markdown?: { engine?: "block" | "paragraph" };
        structured?: {
            splitterConfig?: SentenceSplitterConfig;
            bboxPrecision?: number;
        };
        settings?: ExtractionSettings;
        paragraphSettings?: ParagraphDetectionSettings;
        pageIndices?: number[];
        pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        analysisWindow?: number;
        /** Attach the opt-in `diagnostics` block */
        includeDiagnostics?: boolean;
    },
): Promise<OpReply<BeaverExtractResult>> {
    // Defense in depth: the facade enforces this too, but the worker is
    // reachable directly via the worker-client RPC and any future caller
    // (e.g. tests) shouldn't be able to slip past the contract.
    const explicitEngine = args.markdown?.engine;
    const isStructured = args.mode === "structured";

    if (isStructured && explicitEngine) {
        throw new Error(
            "opExtract: markdown.engine is not applicable when mode='structured'",
        );
    }
    if (isStructured && ((args.pageIndices?.length ?? 0) > 0 || args.pageRange)) {
        throw workerError(
            ERROR_CODES.STRUCTURED_PAGE_SELECTION_REJECTED,
            "Structured extraction is full-document only; pageIndices and pageRange are only supported for markdown extraction.",
        );
    }

    // Resolve the engine for the helper:
    //   structured mode → "structured".
    //   markdown mode: explicit `markdown.engine` wins; default "paragraph".
    const engine: "block" | "paragraph" | "structured" = isStructured
        ? "structured"
        : (explicitEngine ?? "paragraph");

    const tOpStart = performance.now();
    const tDocOpenStart = performance.now();
    const doc = await acquireDoc(args.pdfData);
    const docOpenMs = performance.now() - tDocOpenStart;
    let docFailed = false;
    try {
        // Capture the caller-supplied threshold BEFORE the spread flattens
        // it to the default. `getEffectiveRepeatThreshold` uses this to
        // distinguish "user wanted 3" from "user omitted the field" so the
        // short-doc relaxation only kicks in when no explicit value was
        // provided.
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}) };
        // `resolveTruePageCount` (not `doc.countPages()`): a corrupt or
        // truncated PDF can advertise more pages in `/Root/Pages/Count`
        // than its page tree can resolve. Using the advertised count
        // would drive the page walk past the last real page and abort
        // the whole extraction with `invalid page number`.
        //
        // Two `assertDocumentHasPages` guards, both required:
        //  - before `resolveTruePageCount`: a genuinely page-less document
        //    makes its `loadPage(0)` probe throw a raw "invalid page
        //    number" error, which `resolveTruePageCount` rethrows.
        //  - after: `resolveTruePageCount` itself can correct an advertised
        //    count down to 0, which would otherwise reach the OCR gate /
        //    `resolveAnalysisPages` and throw a raw unclassified error.
        assertDocumentHasPages(doc.countPages());
        const pageCount = resolveTruePageCount(doc);
        assertDocumentHasPages(pageCount);
        const pageLabels = collectPageLabels(doc);

        // Structured mode needs the WASM `Font` helpers to populate line
        // fonts during the detailed walk (the JSON walk used to cover this
        // — we now skip it for target pages). Resolved up front so the OCR
        // gate's page cache can produce detailed walks the pipeline reuses.
        const fontApi = isStructured ? (await ensureApi()).Font : undefined;

        // One walk per page for the whole op. The OCR gate samples a
        // spread of pages and the pipeline walks them again; sharing the
        // walk here keeps an expensive-to-walk page from being processed
        // twice (gate + extraction).
        const pageCache = new PageWalkCache(doc, fontApi);

        if (opts.checkTextLayer) {
            // Run the gate over the SAME walk the pipeline will reuse —
            // detailed for structured, JSON for markdown — so a sampled
            // page is never re-walked by the extraction below.
            const ocrProvider: RawPageProvider = {
                getPageCount: () => pageCount,
                extractRawPage: (i) =>
                    isStructured
                        ? (pageCache.getDetailed(i, true) as unknown as RawPageData)
                        : pageCache.getPlain(i, true),
            };
            const ocr = new DocumentAnalyzer(ocrProvider).getDetailedOCRAnalysis({
                minTextPerPage: opts.minTextPerPage,
            });
            if (ocr.needsOCR) {
                throw workerError(
                    ERROR_CODES.NO_TEXT_LAYER,
                    `Document may require OCR (${Math.round(ocr.issueRatio * 100)}% of sampled pages have issues)`,
                    { ocrAnalysis: ocr, pageLabels, pageCount },
                );
            }
        }

        const targetIndices = isStructured
            ? Array.from({ length: pageCount }, (_, index) => index)
            : args.pageRange
            ? resolvePageRangeOrThrow(pageCount, args.pageRange)
            : resolveExplicitPageIndicesOrThrow(pageCount, args.pageIndices);

        const analysisIndices = resolveAnalysisPages({
            targetPageIndices: targetIndices,
            totalPageCount: pageCount,
            analysisWindow: args.analysisWindow,
        });

        // Resolve the splitter once per request when running structured
        // mode. The helper reuses it across all target pages.
        const splitter = isStructured
            ? await resolveSplitter(
                  args.structured?.splitterConfig ?? { type: "sentencex" },
              )
            : undefined;

        const internal = runExtractFromIndices(
            doc,
            opts as any,
            requestedRepeatThreshold,
            targetIndices,
            analysisIndices,
            pageCount,
            pageLabels,
            engine,
            args.paragraphSettings,
            splitter,
            fontApi,
            pageCache,
        );
        // `runExtractFromIndices` measures the phases it owns; `docOpenMs`
        // and the op-level `totalMs` (which includes the OCR check) are
        // known only here. Mutate the timings record we just got back —
        // it's a fresh object built inside the helper, so this is safe.
        if (internal.metadata.timings) {
            internal.metadata.timings.docOpenMs = docOpenMs;
            internal.metadata.timings.totalMs = performance.now() - tOpStart;
        }
        const result = isStructured
            ? toStructuredExtractResult(
                internal,
                args.structured?.bboxPrecision ?? 1,
                args.includeDiagnostics ?? false,
              )
            : toMarkdownExtractResult(internal, args.includeDiagnostics ?? false);
        return { result };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

export async function opStructuredExtractWithDebug(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        mode?: "structured";
        structured?: {
            splitterConfig?: SentenceSplitterConfig;
            bboxPrecision?: number;
        };
        settings?: ExtractionSettings;
        paragraphSettings?: ParagraphDetectionSettings;
        analysisWindow?: number;
        capturePages: number[];
        debugMode?: "triage" | "full";
    },
): Promise<OpReply<StructuredExtractWithDebugResult>> {
    const tOpStart = performance.now();
    const tDocOpenStart = performance.now();
    const doc = await acquireDoc(args.pdfData);
    const docOpenMs = performance.now() - tDocOpenStart;
    let docFailed = false;
    try {
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}) };
        assertDocumentHasPages(doc.countPages());
        const pageCount = resolveTruePageCount(doc);
        assertDocumentHasPages(pageCount);
        const pageLabels = collectPageLabels(doc);
        const fontApi = (await ensureApi()).Font;
        const pageCache = new PageWalkCache(doc, fontApi);

        if (opts.checkTextLayer) {
            const ocrProvider: RawPageProvider = {
                getPageCount: () => pageCount,
                extractRawPage: (i) =>
                    pageCache.getDetailed(i, true) as unknown as RawPageData,
            };
            const ocr = new DocumentAnalyzer(ocrProvider).getDetailedOCRAnalysis({
                minTextPerPage: opts.minTextPerPage,
            });
            if (ocr.needsOCR) {
                throw workerError(
                    ERROR_CODES.NO_TEXT_LAYER,
                    `Document may require OCR (${Math.round(ocr.issueRatio * 100)}% of sampled pages have issues)`,
                    { ocrAnalysis: ocr, pageLabels, pageCount },
                );
            }
        }

        const targetIndices = Array.from({ length: pageCount }, (_, index) => index);
        const analysisIndices = resolveAnalysisPages({
            targetPageIndices: targetIndices,
            totalPageCount: pageCount,
            analysisWindow: args.analysisWindow,
        });
        const splitter = await resolveSplitter(
            args.structured?.splitterConfig ?? { type: "sentencex" },
        );
        const internal = runExtractFromIndices(
            doc,
            opts as any,
            requestedRepeatThreshold,
            targetIndices,
            analysisIndices,
            pageCount,
            pageLabels,
            "structured",
            args.paragraphSettings,
            splitter,
            fontApi,
            pageCache,
        );
        if (internal.metadata.timings) {
            internal.metadata.timings.docOpenMs = docOpenMs;
            internal.metadata.timings.totalMs = performance.now() - tOpStart;
        }
        const bboxPrecision = args.structured?.bboxPrecision ?? 1;
        const result = toStructuredExtractResult(internal, bboxPrecision);
        const debug = buildDebugProjection(
            internal,
            result,
            args.capturePages,
            bboxPrecision,
            args.debugMode === "full",
        );
        return { result: { result, debug } };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

/**
 * Document-wide style + margin analysis without per-page extraction.
 *
 * Runs the EXACT prefix `opExtract` runs (acquireDoc → page count → page
 * labels → settings merge → optional OCR check → target/analysis index
 * resolution → JSON walk → `buildPageAnalysisContext`) and returns the
 * `styleProfile` / `marginAnalysis` / `marginRemoval` it would have
 * passed to per-page processing. Does NOT run line/column/paragraph
 * detection, the filter pipeline, or sentence mapping.
 *
 * Argument shape mirrors `opExtract`'s pre-extraction fields exactly so
 * callers can re-run the analysis context for the same `settings` /
 * `pageIndices` / `analysisWindow` they used for an extract call and
 * trust the output is byte-identical.
 *
 * Backs the dev-only `/beaver/test/pdf-analyze-layout` endpoint and the
 * `level: "margins"` branch of `/beaver/test/pdf-render-overlay`.
 *
 * **Map/Set boundary.** `result.analysis.styleProfile.styleCounts`,
 * `result.analysis.marginAnalysis.elements`,
 * `result.analysis.marginRemoval.removalsByPage`, and
 * `result.analysis.marginRemoval.textsToRemove` carry `Map`/`Set` fields.
 * `postMessage` preserves them via structured clone, but
 * `JSON.stringify` does NOT — flatten before writing HTTP responses.
 */
export async function opAnalyzeLayout(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        settings?: ExtractionSettings;
        pageIndices?: number[];
        pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        analysisWindow?: number;
    },
): Promise<OpReply<LayoutAnalysisResult>> {
    const tOpStart = performance.now();
    const tDocOpenStart = performance.now();
    const doc = await acquireDoc(args.pdfData);
    const docOpenMs = performance.now() - tDocOpenStart;
    let docFailed = false;
    try {
        // Same prefix as `opExtract`: capture caller-supplied threshold
        // before defaults flatten it; merge defaults; collect labels;
        // optional OCR gate.
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}) };
        setAnalyzerLogging(!!opts.analyzerLogging);
        // Classify a 0-page document before `rawPageProviderFromDoc`, whose
        // `resolveTruePageCount` probe would otherwise throw a raw
        // "invalid page number" error for a page-less document. The second
        // check covers `resolveTruePageCount` correcting an advertised
        // count down to 0.
        assertDocumentHasPages(doc.countPages());
        const provider = rawPageProviderFromDoc(doc);
        const docAnalyzer = new DocumentAnalyzer(provider);
        const pageCount = docAnalyzer.getPageCount();
        assertDocumentHasPages(pageCount);
        const pageLabels = collectPageLabels(doc);

        if (opts.checkTextLayer) {
            const ocr = docAnalyzer.getDetailedOCRAnalysis({
                minTextPerPage: opts.minTextPerPage,
            });
            if (ocr.needsOCR) {
                throw workerError(
                    ERROR_CODES.NO_TEXT_LAYER,
                    `Document may require OCR (${Math.round(ocr.issueRatio * 100)}% of sampled pages have issues)`,
                    { ocrAnalysis: ocr, pageLabels, pageCount },
                );
            }
        }

        const targetIndices = args.pageRange
            ? resolvePageRangeOrThrow(pageCount, args.pageRange)
            : resolveExplicitPageIndicesOrThrow(pageCount, args.pageIndices);

        const analysisIndices = resolveAnalysisPages({
            targetPageIndices: targetIndices,
            totalPageCount: pageCount,
            analysisWindow: args.analysisWindow,
        });

        const {
            analysisPageByIndex,
            styleProfile,
            marginAnalysis,
            marginRemoval,
            walkMs,
            analysisMs,
        } = buildAnalysisFromDoc(
            doc,
            opts,
            requestedRepeatThreshold,
            analysisIndices,
            pageCount,
        );

        // Project analysis-window pages → target-page subset, in target
        // order. `resolveAnalysisPages` guarantees every target index is in
        // the analysis union, but `buildAnalysisFromDoc` drops unresolvable
        // pages (malformed page tree), so filter the misses out.
        const pages: RawPageData[] = targetIndices
            .map((i) => analysisPageByIndex.get(i))
            .filter((p): p is RawPageData => p != null);

        const result: LayoutAnalysisResult = {
            pages,
            pageCount,
            pageLabels:
                Object.keys(pageLabels).length > 0 ? pageLabels : undefined,
            analysisPageIndices: analysisIndices,
            analysis: {
                styleProfile,
                marginAnalysis,
                marginRemoval,
            },
            metadata: {
                extractedAt: new Date().toISOString(),
                // Mirrors the version `runExtractFromIndices` writes so
                // analyze + extract advance together when the analysis
                // context build changes.
                version: SCHEMA_VERSION,
                settings: opts,
                timings: {
                    docOpenMs,
                    walkMs,
                    analysisMs,
                    totalMs: performance.now() - tOpStart,
                },
            },
        };
        return { result };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        setAnalyzerLogging(false);
        releaseDoc(doc, docFailed);
    }
}

export async function opAnalyzeOCRNeeds(
    args: { pdfData: Uint8Array | ArrayBuffer; options?: OCRDetectionOptions },
): Promise<OpReply<OCRDetectionResult>> {
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        // Classify a 0-page document up front — `getDetailedOCRAnalysis`
        // would otherwise throw a raw, unclassified `Error`. The second
        // check covers `resolveTruePageCount` (inside `rawPageProviderFromDoc`)
        // correcting an advertised count down to 0.
        assertDocumentHasPages(doc.countPages());
        const provider = rawPageProviderFromDoc(doc);
        assertDocumentHasPages(provider.getPageCount());
        const analyzer = new DocumentAnalyzer(provider);
        const result = analyzer.getDetailedOCRAnalysis(args.options || {});
        return { result };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

export async function opSearch(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        query: string;
        options?: PDFSearchOptions;
        maxPageCount?: number;
    },
): Promise<OpReply<PDFSearchResult>> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_PDF_SEARCH_OPTIONS, ...(args.options || {}) };
    const scoringOpts = { ...DEFAULT_SEARCH_SCORING_OPTIONS, ...(opts.scoring || {}) };

    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        const totalPages = doc.countPages();

        // Page-count gate: lets cold-cache search drop the upfront getPageCount call.
        // Returns a flagged result (NOT an error) so the handler can map it to
        // the existing `too_many_pages` error response and write the page count
        // to its metadata cache.
        if (typeof args.maxPageCount === "number" && totalPages > args.maxPageCount) {
            return {
                result: {
                    query: args.query,
                    totalMatches: 0,
                    pagesWithMatches: 0,
                    totalPages,
                    pages: [],
                    exceedsPageCountLimit: true,
                    metadata: {
                        searchedAt: new Date().toISOString(),
                        durationMs: Date.now() - startTime,
                        options: opts,
                        scoringOptions: scoringOpts,
                    },
                } as PDFSearchResult,
            };
        }

        const limit = typeof opts.maxHitsPerPage === "number" && opts.maxHitsPerPage > 0
            ? opts.maxHitsPerPage
            : 100;
        // When `opts.pages` has length but every entry is out-of-range,
        // treat as "search all pages" rather than returning zero hits — a
        // stale `opts.pages` shouldn't silently produce a no-result
        // search. (Empty/undefined `opts.pages` already means "all pages"
        // via `resolvePageIndices`.)
        let indices: number[];
        if (opts.pages?.length) {
            const filtered = opts.pages.filter((i: number) => i >= 0 && i < totalPages);
            indices = filtered.length
                ? filtered
                : Array.from({ length: totalPages }, (_, i) => i);
        } else {
            indices = Array.from({ length: totalPages }, (_, i) => i);
        }

        // Step 1: per-page search — share the already-open doc with the
        // raw-page extraction in step 2 and the scoring pass in step 3.
        const pageResults: PDFPageSearchResult[] = [];
        for (const pageIndex of indices) {
            let r: PDFPageSearchResult;
            try {
                r = searchPageInDoc(doc, pageIndex, args.query, limit);
            } catch (err) {
                // Unresolvable page in a malformed page tree — skip it so
                // search still covers the rest of the document.
                if (!isRecoverablePageError(err)) throw err;
                postLog(
                    "warn",
                    `[mupdf-worker] opSearch: skipping unresolvable page ${pageIndex}: ${String(err)}`,
                );
                continue;
            }
            if (r.matchCount > 0) pageResults.push(r);
        }

        if (pageResults.length === 0) {
            return {
                result: {
                    query: args.query,
                    totalMatches: 0,
                    pagesWithMatches: 0,
                    totalPages,
                    pages: [],
                    metadata: {
                        searchedAt: new Date().toISOString(),
                        durationMs: Date.now() - startTime,
                        options: opts,
                        scoringOptions: scoringOpts,
                    },
                } as PDFSearchResult,
            };
        }

        // Step 2: extract raw pages for matched indices (same open)
        const matchedIndices = pageResults.map((pr) => pr.pageIndex);
        const rawPagesArray: RawPageData[] = matchedIndices.map((i) => extractRawPageFromDoc(doc, i));

        // Step 3: score
        const scorer = new SearchScorer(rawPagesArray, scoringOpts);
        const scored = scorer.scorePageResults(pageResults);

        const totalMatches = scored.reduce((sum, p) => sum + p.matchCount, 0);

        return {
            result: {
                query: args.query,
                totalMatches,
                pagesWithMatches: scored.length,
                totalPages,
                pages: scored,
                metadata: {
                    searchedAt: new Date().toISOString(),
                    durationMs: Date.now() - startTime,
                    options: opts,
                    scoringOptions: scoringOpts,
                },
            } as PDFSearchResult,
        };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

/**
 * Single-page sentence-level bbox extraction with intermediates surfaced.
 * Debug-only — production sentence-level extraction goes through
 * `opExtract` with `mode: "structured"` (multi-page, returns
 * `InternalExtractionResult` with `pages[i].sentences`).
 *
 * Powers the dev visualizer / extract-trace endpoints: returns the
 * production sentence result PLUS the pipeline intermediates
 * (analysis-window indices, raw doc, detailed page, font-bridged
 * `pagesForFilter`, margin analysis/removal, filtered-paragraph result).
 */
export async function opExtractSentenceDebug(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        pageIndex: number;
        options?: WorkerSentenceDebugOptions;
    },
): Promise<OpReply<SentenceTraceResult>> {
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        const pageCount = doc.countPages();
        assertDocumentHasPages(pageCount);
        if (
            typeof args.pageIndex !== "number" ||
            args.pageIndex < 0 ||
            args.pageIndex >= pageCount
        ) {
            throw workerError(
                ERROR_CODES.PAGE_OUT_OF_RANGE,
                `Page index ${args.pageIndex} out of range (0..${pageCount - 1})`,
            );
        }
        const opts = args.options;
        const traceResult = await runSentenceExtractionFromDoc({
            doc,
            pageIndex: args.pageIndex,
            pageCount,
            splitterConfig: opts?.splitterConfig,
            analysisWindow: opts?.analysisWindow,
            paragraphSettings: opts?.paragraphSettings,
            margins: opts?.margins,
            marginZone: opts?.marginZone,
            repeatThreshold: opts?.repeatThreshold,
            detectPageSequences: opts?.detectPageSequences,
            graphicsLayerMode: opts?.graphicsLayerMode,
            trace: true,
        });
        return { result: traceResult };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}
