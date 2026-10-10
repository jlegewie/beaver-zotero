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
 *   import type { RawPageData, InternalExtractionResult } from "@beaver/agent-core/extract/types";
 */

import { DocumentAnalyzer, type RawPageProvider } from "../DocumentAnalyzer";
import { MarginFilter } from "../MarginFilter";
import { PageExtractor } from "../PageExtractor";
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
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFMetadata,
    PDFPageSearchResult,
    PDFSearchOptions,
    PDFSearchResult,
    InternalProcessedPage,
    PageGeometry,
    RawPageData,
    RawPageDataDetailed,
    StructuredPagePhaseTimings,
    StyleProfile,
    DegradationSummary,
} from "@beaver/agent-core/extract/types";
import {
    DEFAULT_EXTRACTION_SETTINGS,
    DEFAULT_MARGIN_ZONE,
    DEFAULT_PDF_SEARCH_OPTIONS,
    DEFAULT_SEARCH_SCORING_OPTIONS,
    shouldProbeGraphicsLayer,
    bboxHeight,
    bboxWidth,
} from "@beaver/agent-core/extract/types";
import {
    CURRENT_PDF_EXTRACTION_PRESET,
    ITEM_KINDS,
    SCHEMA_VERSION,
    pdfExtractionPreset,
    type PdfExtractionPreset,
    type BeaverExtractResult,
    type ExtractionDebug,
    type DebugSentence,
    type MarkdownExtractResult,
    type SerializedBeaverExtractResult,
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
import { runSentenceExtractionFromDoc } from "./sentenceExtraction";
import { resolveSplitter } from "./splitterResolver";
import type { SentenceSplitter } from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import { buildInputPage, type InputPage } from "../features/itemInput";
import type { ItemPass } from "../pipeline/itemPasses";
import { ITEMS_EXPORT_TASKS, ItemsExportCollector, type ItemsExportRow } from "../pipeline/itemsExport";
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
import {
    buildAnalysisFromDoc,
    PageWalkCache,
    type ResolvedExtractionSettings,
} from "../pipeline/documentAnalysis";
import { pageLabelsToStringKeys, projectColumnRect, replaceControlCharsInResult } from "../pipeline/output";
import {
    analyzeDocument,
    mapSentences,
    project,
    runItemPasses,
    createItemPasses,
    segmentPages,
    type StructuredRunContext,
} from "../pipeline/structured";


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
 * OCR-gate page provider over an op's shared page walks.
 *
 * Structured extraction decides whether a document is queued for OCR from
 * the detailed walk (with the schema preset's text repair), so standalone
 * OCR analysis uses the same walk and every OCR verdict judges identical text.
 */
function ocrGateProvider(
    pageCache: PageWalkCache,
    pageCount: number,
    detailed: boolean,
): RawPageProvider {
    return {
        getPageCount: () => pageCount,
        extractRawPage: (i) =>
            detailed
                ? (pageCache.getDetailed(i, true) as unknown as RawPageData)
                : pageCache.getPlain(i, true),
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
 * Shared body for `opExtract`. The per-page loop has three branches keyed
 * off `engine`:
 *   - `"paragraph"` → `detectFilteredParagraphs` produces
 *     `paragraphResult.pageContent` (`## ` headers, `\n\n` separators).
 *   - `"block"` → column detection + PageExtractor (block-based).
 *   - `"structured"` → the structured pipeline (`../pipeline/structured`):
 *     per-page detailed walk, segmentation, item passes and sentence
 *     mapping. Populates `items`, `sentences`, `columns`, plus
 *     paragraph-engine `content`. Requires `splitter` (resolved by the
 *     caller). Per-page detailed walk is the dominant cost — multi-page
 *     structured extracts pay N× this per the `targetIndices` length.
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
    opts: ResolvedExtractionSettings,
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
    itemPasses: readonly ItemPass[] = [],
    pageNumberRuns = true,
): InternalExtractionResult {
    setAnalyzerLogging(!!opts.analyzerLogging);
    try {
    const tStart = performance.now();

    // Structured mode walks every target in detailed mode first and reuses
    // those walks for the analysis window (`analyzeDocument`). Markdown
    // engines don't need per-char data and go straight to the JSON walk
    // inside `buildAnalysisFromDoc`. Same helper `opAnalyzeLayout` calls —
    // keeps the prefix byte-identical between extract and analyze.
    const structuredStudy = engine === "structured"
        ? analyzeDocument(
            doc,
            opts,
            requestedRepeatThreshold,
            targetIndices,
            analysisIndices,
            pageCount,
            fontApi,
            pageCache,
            pageNumberRuns,
        )
        : undefined;
    const study = structuredStudy ?? buildAnalysisFromDoc(
        doc,
        opts,
        requestedRepeatThreshold,
        analysisIndices,
        pageCount,
        undefined,
        pageCache,
        pageNumberRuns,
    );
    const { analysisPages, analysisPageByIndex, styleProfile, marginAnalysis, marginRemoval, walkMs, analysisMs } = study;

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
                marginTextRows: opts.marginTextRows,
                paragraphSettings,
                compoundVocabulary: study.compoundVocabulary,
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
        // Structured engine: reuses the shared analysis context so margin
        // removal and the style profile run only once across the document.
        if (!splitter) {
            throw new Error(
                "runExtractFromIndices: engine='structured' requires a resolved `splitter` argument",
            );
        }
        const ctx: StructuredRunContext = {
            doc,
            opts,
            requestedRepeatThreshold,
            pageCount,
            pageCache,
            paragraphSettings,
            splitter,
        };
        const segmented = segmentPages(ctx, structuredStudy!, effectiveTargetIndices);
        const passes = runItemPasses(segmented, structuredStudy!, pageCount, itemPasses, paragraphSettings);
        const mapped = mapSentences(ctx, segmented, passes, study.compoundVocabulary);
        pages.push(...mapped.pages);
        perPageMs.push(...mapped.perPageMs);
        perPagePhases.push(...mapped.perPagePhases);
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
                opts.marginTextRows,
                opts.marginTextRows,
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
    preset: PdfExtractionPreset,
    includeDiagnostics = false,
): MarkdownExtractResult {
    replaceControlCharsInResult(result, preset);
    return {
        mode: "markdown",
        schemaVersion: preset.schemaVersion,
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

function buildSerializedCacheMetadata(
    result: BeaverExtractResult,
): SerializedBeaverExtractResult["cacheMetadata"] {
    const doc = result.document;
    const pageLabels = doc.pageLabels ?? Object.fromEntries(
        doc.pages
            .filter((page) => page.label)
            .map((page) => [String(page.index), page.label as string]),
    );
    const pages: (PageGeometry | null)[] = new Array(doc.pageCount).fill(null);
    for (const page of doc.pages) {
        pages[page.index] = {
            viewBox: page.viewBox,
            width: page.viewBox[2] - page.viewBox[0],
            height: page.viewBox[3] - page.viewBox[1],
            rotation: page.rotation,
        };
    }
    return {
        pageCount: doc.pageCount,
        pageLabels,
        pages,
    };
}

function serializeExtractResult(result: BeaverExtractResult): SerializedBeaverExtractResult {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(result));
    return {
        mode: result.mode,
        schemaVersion: result.schemaVersion,
        pageCount: result.document.pageCount,
        byteLength: jsonBytes.byteLength,
        jsonBytes,
        cacheMetadata: buildSerializedCacheMetadata(result),
    };
}

/**
 * Paragraph settings with the schema preset's switches applied. The caller may
 * override `hangingIndentBlocks`; `headingLabelFilters`, `isolatedHeadings`,
 * `pageBodyStyles`, `exclusiveColumnLines`, `lineJoins` and `noteMarkers`
 * always follow the preset.
 */
function presetParagraphSettings(
    preset: PdfExtractionPreset,
    settings: ParagraphDetectionSettings | undefined,
): ParagraphDetectionSettings {
    return {
        hangingIndentBlocks: preset.hangingIndentBlocks,
        ...settings,
        headingLabelFilters: preset.headingLabelFilters,
        isolatedHeadings: preset.isolatedHeadings,
        pageBodyStyles: preset.pageBodyStyles,
        exclusiveColumnLines: preset.exclusiveColumnLines,
        lineJoins: preset.lineJoins,
        noteMarkers: preset.noteMarkers,
    };
}

function resolvePdfExtractionPreset(schemaVersion: string | undefined): PdfExtractionPreset {
    const preset = schemaVersion == null ? CURRENT_PDF_EXTRACTION_PRESET : pdfExtractionPreset(schemaVersion);
    if (!preset) throw new Error(`No extraction preset for PDF schema ${schemaVersion}`);
    return preset;
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
/**
 * Whether the preset detects regions. Its output depends on the graphics
 * summary, so a WASM build without one cannot produce this schema version.
 */
async function regionsSupported(preset: PdfExtractionPreset): Promise<boolean> {
    if (!preset.regions) return false;
    if (!(await ensureApi()).supportsGraphicsSummary) {
        throw workerError(
            ERROR_CODES.WASM_ERROR,
            `PDF schema ${preset.schemaVersion} needs a MuPDF build with graphics summary support`,
        );
    }
    return true;
}

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
        /** PDF schema version to produce; defaults to the current version. */
        schemaVersion?: string;
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
    const preset = resolvePdfExtractionPreset(args.schemaVersion);

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
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}), marginTextRows: preset.marginTextRows };
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
        const pageCache = new PageWalkCache(
            doc,
            fontApi,
            preset.textRepair,
            preset.styleRuns,
            isStructured && (await regionsSupported(preset)),
        );

        if (opts.checkTextLayer) {
            // Run the gate over the SAME walk the pipeline will reuse —
            // detailed for structured, JSON for markdown — so a sampled
            // page is never re-walked by the extraction below.
            const ocrProvider = ocrGateProvider(pageCache, pageCount, isStructured);
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
                  { captionLabels: preset.captionLabels },
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
            presetParagraphSettings(preset, args.paragraphSettings),
            splitter,
            fontApi,
            pageCache,
            isStructured ? createItemPasses(preset) : [],
            preset.pageNumberRuns,
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
            ? project(
                internal,
                preset,
                args.structured?.bboxPrecision ?? 1,
                args.includeDiagnostics ?? false,
              )
            : toMarkdownExtractResult(internal, preset, args.includeDiagnostics ?? false);
        return { result };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

export async function opExtractSerialized(
    args: Parameters<typeof opExtract>[0],
): Promise<OpReply<SerializedBeaverExtractResult>> {
    const { result } = await opExtract(args);
    const serialized = serializeExtractResult(result);
    return {
        result: serialized,
        transfer: [serialized.jsonBytes.buffer],
    };
}

type StructuredRunArgs = {
    pdfData: Uint8Array | ArrayBuffer;
    structured?: {
        splitterConfig?: SentenceSplitterConfig;
        bboxPrecision?: number;
    };
    settings?: ExtractionSettings;
    paragraphSettings?: ParagraphDetectionSettings;
    analysisWindow?: number;
    /** PDF schema version to produce; defaults to the current version. */
    schemaVersion?: string;
};

/**
 * Full-document structured extraction for the debug and export ops: the
 * `opExtract` structured path, with the internal result and the result
 * projection handed to `finish` while the document is open.
 */
async function withStructuredRun<T>(
    args: StructuredRunArgs,
    /** Item passes to run; defaults to the preset's. */
    itemPassesFor: ((preset: PdfExtractionPreset) => ItemPass[]) | undefined,
    finish: (internal: InternalExtractionResult, preset: PdfExtractionPreset) => T,
): Promise<T> {
    const preset = resolvePdfExtractionPreset(args.schemaVersion);
    const itemPasses = (itemPassesFor ?? createItemPasses)(preset);
    const tOpStart = performance.now();
    const tDocOpenStart = performance.now();
    const doc = await acquireDoc(args.pdfData);
    const docOpenMs = performance.now() - tDocOpenStart;
    let docFailed = false;
    try {
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}), marginTextRows: preset.marginTextRows };
        assertDocumentHasPages(doc.countPages());
        const pageCount = resolveTruePageCount(doc);
        assertDocumentHasPages(pageCount);
        const pageLabels = collectPageLabels(doc);
        const fontApi = (await ensureApi()).Font;
        const pageCache = new PageWalkCache(
            doc,
            fontApi,
            preset.textRepair,
            preset.styleRuns,
            await regionsSupported(preset),
        );

        if (opts.checkTextLayer) {
            const ocrProvider = ocrGateProvider(pageCache, pageCount, true);
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
            { captionLabels: preset.captionLabels },
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
            presetParagraphSettings(preset, args.paragraphSettings),
            splitter,
            fontApi,
            pageCache,
            itemPasses,
            preset.pageNumberRuns,
        );
        if (internal.metadata.timings) {
            internal.metadata.timings.docOpenMs = docOpenMs;
            internal.metadata.timings.totalMs = performance.now() - tOpStart;
        }
        return finish(internal, preset);
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}

// Type aliases, not interfaces: the worker dispatcher casts its untyped
// arguments to these, which needs an implicit index signature.
type StructuredDebugArgs = StructuredRunArgs & {
    mode?: "structured";
    capturePages: number[];
    debugMode?: "triage" | "full";
};

export async function opStructuredExtractWithDebug(
    args: StructuredDebugArgs,
): Promise<OpReply<StructuredExtractWithDebugResult>> {
    return withStructuredRun(args, undefined, (internal, preset) => {
        const bboxPrecision = args.structured?.bboxPrecision ?? 1;
        const result = project(internal, preset, bboxPrecision);
        const debug = buildDebugProjection(
            internal,
            result,
            args.capturePages,
            bboxPrecision,
            args.debugMode === "full",
        );
        return { result: { result, debug } };
    });
}

/** A page of `opReferenceInputs`: the line model's input and the page's items. */
export interface ReferenceInputPage {
    input: InputPage;
    /** Page size in the public (MuPDF) frame; `input` uses the upright frame. */
    width: number;
    height: number;
    /**
     * The page's published (citable) items in public-frame coordinates,
     * aligned with `input.items` by index.
     */
    items: Array<{ kind: DocItem["kind"]; bbox: [number, number, number, number] }>;
}

/**
 * Full-document structured extraction that returns every page's step-2
 * items as the reference line model reads them (`InputPage`), before any
 * item pass: the training export of the line model.
 */
export async function opReferenceInputs(
    args: StructuredRunArgs,
): Promise<OpReply<{ pageCount: number; pages: ReferenceInputPage[] }>> {
    let inputs: InputPage[] = [];
    const collect: ItemPass = {
        name: "referenceInputs",
        run(doc) {
            inputs = doc.pages.map((page) => buildInputPage(page, doc.styleProfile));
        },
    };
    return withStructuredRun(args, () => [collect], (internal) => {
        const pages = internal.pages.map((page, i): ReferenceInputPage => {
            const input = inputs[i];
            const items = page.items.filter((item) => ITEM_KINDS[item.kind].citable);
            return {
                input,
                width: page.width,
                height: page.height,
                items: items.slice(0, input.items.length).map((item) => ({
                    kind: item.kind,
                    bbox: bboxToRect(item.bbox, 1),
                })),
            };
        });
        return { result: { pageCount: internal.pages.length, pages } };
    });
}

/**
 * Full-document structured extraction that returns the `items export` row of
 * a model task: the structured items with their lines, the lines the margin
 * filter removed and the task's feature rows (see `pipeline/itemsExport.ts`).
 */
export async function opItemsExport(
    args: StructuredRunArgs & { task: string },
): Promise<OpReply<ItemsExportRow>> {
    const task = ITEMS_EXPORT_TASKS[args.task];
    if (!task) {
        throw new Error(`Unknown items export task "${args.task}" (known: ${Object.keys(ITEMS_EXPORT_TASKS).join(", ")})`);
    }
    const collector = new ItemsExportCollector(task);
    const bboxPrecision = args.structured?.bboxPrecision ?? 1;
    return withStructuredRun(args, (preset) => collector.passes(createItemPasses(preset)), (internal, preset) => {
        const projected = project(internal, preset, bboxPrecision);
        return { result: collector.row(internal, projected, args.task, bboxPrecision) };
    });
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
        // check covers `resolveTruePageCount` correcting an advertised count
        // down to 0.
        assertDocumentHasPages(doc.countPages());
        const pageCount = resolveTruePageCount(doc);
        assertDocumentHasPages(pageCount);
        const fontApi = (await ensureApi()).Font;
        const pageCache = new PageWalkCache(
            doc,
            fontApi,
            CURRENT_PDF_EXTRACTION_PRESET.textRepair,
            // OCR analysis reads text only.
            false,
        );
        const analyzer = new DocumentAnalyzer(ocrGateProvider(pageCache, pageCount, true));
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
            paragraphSettings: presetParagraphSettings(CURRENT_PDF_EXTRACTION_PRESET, opts?.paragraphSettings),
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
