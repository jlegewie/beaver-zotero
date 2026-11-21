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
import { resolveAnalysisPages } from "../AnalysisWindow";
import { setAnalyzerLogging } from "../logging";
import { SearchScorer } from "../SearchScorer";
import type {
    DocItem,
    InternalExtractionResult,
    ExtractionSettings,
    LayoutAnalysisResult,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFMetadata,
    PDFPageSearchResult,
    PDFSearchOptions,
    PDFSearchResult,
    PageGeometry,
    RawPageData,
    RawPageDataDetailed,
    StyleProfile,
    DegradationSummary,
} from "@beaver/agent-core/extract/types";
import {
    DEFAULT_EXTRACTION_SETTINGS,
    DEFAULT_PDF_SEARCH_OPTIONS,
    DEFAULT_SEARCH_SCORING_OPTIONS,
} from "@beaver/agent-core/extract/types";
import {
    CURRENT_PDF_EXTRACTION_PRESET,
    ITEM_KINDS,
    applyPresetOverrides,
    pdfExtractionPreset,
    type PdfExtractionPreset,
    type PresetOverrides,
    type BeaverExtractResult,
    type ExtractionDebug,
    type DebugSentence,
    type MarkdownExtractResult,
    type SerializedBeaverExtractResult,
    type StructuredExtractResult,
    type StructuredExtractWithDebugResult,
} from "../schema";
import { bboxToRect } from "../schema/bbox";
import { ERROR_CODES, postLog, workerError } from "./errors";
import { isRecoverablePageError } from "../wasmFatal";
import { acquireDoc, releaseDoc } from "./docCache";
import type { DocumentLike } from "./mupdfApi";
import { ensureApi } from "./wasmInit";
import { ensureSentencex } from "./sentencexInit";
import { resolveSplitter } from "./splitterResolver";
import { buildWarmupPdf } from "./warmupPdf";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import { buildInputPage, type InputPage } from "../features/itemInput";
import type { ItemPass } from "../pipeline/itemPasses";
import { ITEMS_EXPORT_TASKS, ItemsExportCollector, type ItemsExportRow } from "../pipeline/itemsExport";
import { RegionsExportCollector, type RegionsExportRow } from "../pipeline/regionsExport";
import type { SentenceSplitterConfig } from "../sentenceTypes";
import {
    DEFAULT_PAGE_IMAGE_OPTIONS,
    collectDocumentInfo,
    collectPageLabels,
    collectPagesData,
    extractRawPageDetailedFromDoc,
    assertDocumentHasPages,
    extractRawPageFromDoc,
    openDocUncached,
    rawPageProviderFromDoc,
    renderOnePage,
    resolveExplicitPageIndicesOrThrow,
    resolvePageIndices,
    resolvePageRangeOrThrow,
    resolveTruePageCount,
    searchPageInDoc,
} from "./docHelpers";
import {
    buildAnalysisFromDoc,
    PageWalkCache,
    type ResolvedExtractionSettings,
} from "../pipeline/documentAnalysis";
import { runExtraction, type ExtractionEngine } from "../pipeline/extract";
import { derivedPageLabelsForCache, pageLabelsToStringKeys, replaceControlCharsInResult } from "../pipeline/output";
import {
    project,
    createItemPasses,
    type StructuredRunObservers,
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
    const derivedPageLabels = derivedPageLabelsForCache(result);
    return {
        pageCount: doc.pageCount,
        pageLabels,
        ...(derivedPageLabels !== undefined ? { derivedPageLabels } : {}),
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

function resolvePdfExtractionPreset(schemaVersion: string | undefined, overrides?: PresetOverrides): PdfExtractionPreset {
    const preset = schemaVersion == null ? CURRENT_PDF_EXTRACTION_PRESET : pdfExtractionPreset(schemaVersion);
    if (!preset) throw new Error(`No extraction preset for PDF schema ${schemaVersion}`);
    return applyPresetOverrides(preset, overrides);
}

/**
 * A preset that detects regions needs the graphics summary in structured
 * extraction, so a WASM build without one cannot produce its schema version.
 */
async function assertRegionsSupported(preset: PdfExtractionPreset): Promise<void> {
    if (preset.regions && !(await ensureApi()).supportsGraphicsSummary) {
        throw workerError(
            ERROR_CODES.WASM_ERROR,
            `PDF schema ${preset.schemaVersion} needs a MuPDF build with graphics summary support`,
        );
    }
}

/** Arguments every extraction op accepts. */
type ExtractionRunArgs = {
    pdfData: Uint8Array | ArrayBuffer;
    structured?: {
        splitterConfig?: SentenceSplitterConfig;
        bboxPrecision?: number;
    };
    settings?: ExtractionSettings;
    paragraphSettings?: ParagraphDetectionSettings;
    /** Markdown engines only; structured extraction is full-document. */
    pageIndices?: number[];
    pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
    analysisWindow?: number;
    /** PDF schema version to produce; defaults to the current version. */
    schemaVersion?: string;
    /** Development only (CLI): switches of the schema's preset to override. */
    presetOverrides?: PresetOverrides;
};

/** Structured-run options of `withExtractionRun` (debug and training-export ops). */
interface StructuredRunOptions {
    /** Item passes to run; defaults to the preset's. */
    itemPasses?: (preset: PdfExtractionPreset) => ItemPass[];
    /** Observe the region pass or the item-boundary input of every page (training exports). */
    observers?: StructuredRunObservers;
    /** Open the document outside the worker's document cache and destroy it afterwards. */
    uncachedDoc?: boolean;
}

/**
 * Runs one extraction (`runExtraction`) in a single doc-open and hands the
 * internal result, the schema preset, and the document to `finish` while the
 * document is open.
 *
 * Fuses page-count + page-labels + OCR check + extract. Uses the strict
 * resolvers — explicit-but-all-invalid page inputs throw PAGE_OUT_OF_RANGE
 * with `{ pageCount }` in the payload so handlers can populate
 * `total_pages` in error responses. The structured engine extracts every
 * page; the markdown engines extract `pageRange` or `pageIndices`.
 */
async function withExtractionRun<T>(
    args: ExtractionRunArgs,
    engine: ExtractionEngine,
    finish: (internal: InternalExtractionResult, preset: PdfExtractionPreset, doc: DocumentLike) => T,
    structuredRun: StructuredRunOptions = {},
): Promise<T> {
    const isStructured = engine === "structured";
    const preset = resolvePdfExtractionPreset(args.schemaVersion, args.presetOverrides);
    const itemPasses = isStructured && structuredRun.itemPasses ? structuredRun.itemPasses(preset) : undefined;
    const tOpStart = performance.now();
    const tDocOpenStart = performance.now();
    const doc = structuredRun.uncachedDoc
        ? await openDocUncached(args.pdfData)
        : await acquireDoc(args.pdfData);
    const docOpenMs = performance.now() - tDocOpenStart;
    let docFailed = false;
    try {
        // Capture the caller-supplied threshold BEFORE the spread flattens
        // it to the default. `getEffectiveRepeatThreshold` uses this to
        // distinguish "user wanted 3" from "user omitted the field" so the
        // short-doc relaxation only kicks in when no explicit value was
        // provided.
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts: ResolvedExtractionSettings = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}) };
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
        // fonts during the detailed walk. Resolved up front so the OCR
        // gate's page cache can produce detailed walks the pipeline reuses.
        const fontApi = isStructured ? (await ensureApi()).Font : undefined;
        if (isStructured) await assertRegionsSupported(preset);

        // One walk per page for the whole op. The OCR gate samples a
        // spread of pages and the pipeline walks them again; sharing the
        // walk here keeps an expensive-to-walk page from being processed
        // twice (gate + extraction).
        const pageCache = new PageWalkCache(doc, fontApi, preset);

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
        // mode. The pipeline reuses it across all target pages.
        const splitter = isStructured
            ? await resolveSplitter(
                  args.structured?.splitterConfig ?? { type: "sentencex" },
                  { captionLabels: preset.captionLabels },
              )
            : undefined;

        const internal = runExtraction(doc, {
            engine,
            preset,
            pageCache,
            opts,
            requestedRepeatThreshold,
            targetIndices,
            analysisIndices,
            pageCount,
            pageLabels,
            paragraphSettings: args.paragraphSettings,
            splitter,
            itemPasses,
            observers: structuredRun.observers,
        });
        // `runExtraction` measures the phases it owns; `docOpenMs` and the
        // op-level `totalMs` (which includes the OCR check) are known only
        // here. Mutate the timings record we just got back — it's a fresh
        // object built inside the pipeline, so this is safe.
        if (internal.metadata.timings) {
            internal.metadata.timings.docOpenMs = docOpenMs;
            internal.metadata.timings.totalMs = performance.now() - tOpStart;
        }
        return finish(internal, preset, doc);
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        if (structuredRun.uncachedDoc) doc.destroy();
        else releaseDoc(doc, docFailed);
    }
}

/**
 * Strict, fused extract op for the agent handlers (`withExtractionRun`).
 *
 * `mode` selects the output product:
 *   - `"markdown"` (default) returns per-page text via the markdown
 *     engines below.
 *   - `"structured"` returns the structured result: items and sentences
 *     with bboxes for every page. Per-page detailed walk is the dominant
 *     cost — structured extracts pay it for every page of the document.
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
 *   - `mode === "structured"` with `pageIndices` or `pageRange`.
 *
 * `structured.splitterConfig` (only consulted when `mode ===
 * "structured"`) is a serializable splitter config — the worker
 * resolves the actual splitter via `resolveSplitter`. Default:
 * `{ type: "sentencex" }`.
 */
export async function opExtract(
    args: ExtractionRunArgs & {
        mode?: "markdown" | "structured";
        markdown?: { engine?: "block" | "paragraph" };
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

    // Resolve the engine:
    //   structured mode → "structured".
    //   markdown mode: explicit `markdown.engine` wins; default "paragraph".
    const engine: ExtractionEngine = isStructured ? "structured" : (explicitEngine ?? "paragraph");
    const includeDiagnostics = args.includeDiagnostics ?? false;
    return withExtractionRun(args, engine, (internal, preset, doc) => {
        if (!isStructured) return { result: toMarkdownExtractResult(internal, preset, includeDiagnostics) };
        const result = project(internal, preset, args.structured?.bboxPrecision ?? 1, includeDiagnostics);
        const infoTitle = collectDocumentInfo(doc).title?.trim();
        if (infoTitle) result.infoTitle = infoTitle;
        return { result };
    });
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

/**
 * Pages of the warm-up document (`buildWarmupPdf`). One page recovers little
 * of a fresh worker's first-extraction penalty, which is mostly code the
 * engine has not optimized yet; eight recover about half to two thirds of it
 * for a few hundred ms of warm-up, and more pages add little.
 */
const WARMUP_PAGES = 8;

/** Where the `__warmup` op spent its time, ms. */
export interface WarmupResult {
    /** Loading MuPDF (a no-op when an earlier op loaded it). */
    mupdfMs: number;
    /** Loading sentencex; null when it failed (extractions then fall back to the regex splitter). */
    sentencexMs: number | null;
    /** The structured extraction of the warm-up document. */
    extractMs: number;
}

/**
 * Prepare a fresh worker for its first request: load MuPDF and sentencex,
 * then run one structured extraction of a generated article
 * (`buildWarmupPdf`) the way backend requests run it (text-layer check,
 * projection, serialization), and discard the result.
 *
 * A worker's first extractions are slower than later ones: they decode the
 * learned layout models, fill module-level caches, and run pipeline code the
 * engine has not optimized yet. Doing that here moves part of the cost off
 * the first real request. The document bypasses the worker's document cache.
 * `pages` overrides the warm-up document's length.
 */
export async function opWarmup(args: { pages?: number }): Promise<OpReply<WarmupResult>> {
    let t = performance.now();
    await ensureApi();
    const mupdfMs = performance.now() - t;

    t = performance.now();
    let sentencexMs: number | null = null;
    try {
        await ensureSentencex();
        sentencexMs = performance.now() - t;
    } catch (e) {
        postLog("warn", `[mupdf-worker] warm-up could not load sentencex: ${e instanceof Error ? e.message : String(e)}`);
    }

    t = performance.now();
    await withExtractionRun(
        { pdfData: buildWarmupPdf(args.pages ?? WARMUP_PAGES), settings: { checkTextLayer: true } },
        "structured",
        (internal, preset) => serializeExtractResult(project(internal, preset, 1, false)),
        { uncachedDoc: true },
    );
    const extractMs = performance.now() - t;
    return { result: { mupdfMs, sentencexMs, extractMs } };
}

/** Arguments of the full-document structured debug and export ops. */
type StructuredRunArgs = Omit<ExtractionRunArgs, "pageIndices" | "pageRange">;

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
    return withExtractionRun(args, "structured", (internal, preset) => {
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
    return withExtractionRun(args, "structured", (internal) => {
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
    }, { itemPasses: () => [collect] });
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
    const boundaries = collector.boundaryObserver();
    return withExtractionRun(
        args,
        "structured",
        (internal, preset) => {
            const projected = project(internal, preset, bboxPrecision);
            return { result: collector.row(internal, projected, args.task, bboxPrecision) };
        },
        {
            itemPasses: (preset) => collector.passes(createItemPasses(preset)),
            observers: boundaries ? { boundaries } : {},
        },
    );
}

/**
 * Full-document structured extraction that returns the `regions-v2` export
 * row: per page, the region pass's text pieces and primitives and what the
 * detector did with them (see `pipeline/regionsExport.ts`). `pages` limits
 * the pages written; every page is extracted, as in production.
 */
export async function opRegionsExport(
    args: StructuredRunArgs & { pages?: number[] },
): Promise<OpReply<RegionsExportRow>> {
    const preset = resolvePdfExtractionPreset(args.schemaVersion, args.presetOverrides);
    if (!preset.regions) throw new Error(`PDF schema ${preset.schemaVersion} has no region detection`);
    const bboxPrecision = args.structured?.bboxPrecision ?? 1;
    const collector = new RegionsExportCollector(bboxPrecision, args.pages ? new Set(args.pages) : undefined);
    return withExtractionRun(
        args,
        "structured",
        (internal) => ({ result: collector.row(preset.schemaVersion, internal.analysis.pageCount) }),
        { observers: { region: collector } },
    );
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
        // The analysis of the current schema's extraction.
        const preset = CURRENT_PDF_EXTRACTION_PRESET;
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
        } = buildAnalysisFromDoc({
            pageCache: new PageWalkCache(doc, undefined, preset),
            preset,
            opts,
            requestedRepeatThreshold,
            analysisIndices,
            pageCount,
        });

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
                // Mirrors the version `runExtraction` writes so
                // analyze + extract advance together when the analysis
                // context build changes.
                version: preset.schemaVersion,
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
        const pageCache = new PageWalkCache(doc, fontApi, {
            textRepair: CURRENT_PDF_EXTRACTION_PRESET.textRepair,
            // OCR analysis reads text only.
            styleRuns: false,
            regions: false,
        });
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
        // `resolveTruePageCount` (not `doc.countPages()`), like extraction and
        // rendering: a corrupt PDF can advertise a page count its page tree
        // does not resolve to. The advertised count would also only hold on a
        // fresh open; a document reopened from the worker's cache has already
        // had its tree walked and reports the corrected count. A page-less
        // document stays at 0 (the probe would throw on it).
        const totalPages = doc.countPages() > 0 ? resolveTruePageCount(doc) : 0;

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
