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
 * `MuPDFWorkerClient` (and the `PDFExtractor` facade that wraps it), the
 * main-thread worker proxy that spawns workers via `getConfig()` URLs —
 * pulling it in here would try to spawn another worker from inside this
 * one. Import analyzers and types directly:
 *   import { StyleAnalyzer } from "../StyleAnalyzer";
 *   import type { RawPageData, ExtractionResult } from "../types";
 */

import { DocumentAnalyzer } from "../DocumentAnalyzer";
import { StyleAnalyzer } from "../StyleAnalyzer";
import { MarginFilter, getEffectiveRepeatThreshold } from "../MarginFilter";
import { PageExtractor } from "../PageExtractor";
import { buildPageAnalysisContext } from "../PageAnalysisContext";
import { resolveAnalysisPages } from "../AnalysisWindow";
import { detectColumns, logColumnDetection } from "../ColumnDetector";
import type { PageLineResult } from "../LineDetector";
import { detectFilteredParagraphs } from "../FilteredParagraphPipeline";
import { SearchScorer } from "../SearchScorer";
import type {
    DocumentAnalysis,
    ExtractionResult,
    ExtractionSettings,
    ExtractedLine,
    LayoutAnalysisResult,
    MarginAnalysis,
    MarginRemovalResult,
    MarginSettings,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFMetadata,
    PDFPageSearchResult,
    PDFSearchOptions,
    PDFSearchResult,
    ProcessedPage,
    RawDocumentData,
    RawPageData,
    RawPageDataDetailed,
    StyleProfile,
} from "../types";
import {
    DEFAULT_EXTRACTION_SETTINGS,
    DEFAULT_MARGIN_ZONE,
    DEFAULT_PDF_SEARCH_OPTIONS,
    DEFAULT_SEARCH_SCORING_OPTIONS,
} from "../types";
import { DEFAULT_ANALYSIS_WINDOW_CAP } from "../AnalysisWindow";
import type {
    SentenceBBoxTraceResult,
    WorkerSentenceBBoxDebugOptions,
} from "../sentenceTypes";
import { ERROR_CODES, workerError } from "./errors";
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
    extractRawPageDetailedFromDoc,
    extractRawPageFromDoc,
    rawPageProviderFromDoc,
    renderOnePage,
    resolveExplicitPageIndicesOrThrow,
    resolvePageIndices,
    resolvePageRangeOrThrow,
    searchPageInDoc,
} from "./docHelpers";
import type { DocumentLike } from "./mupdfApi";

export interface OpReply<T = unknown> {
    result: T;
    transfer?: Transferable[];
}

// ---------------------------------------------------------------------------
// PR #1 / PR #2 carry-forward ops — semantics must remain byte-identical.
// ---------------------------------------------------------------------------

export async function opGetPageCount(args: { pdfData: Uint8Array | ArrayBuffer }): Promise<OpReply<{ count: number }>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        return { result: { count: doc.countPages() } };
    } finally {
        releaseDoc(doc);
    }
}

export async function opGetMetadata(
    args: { pdfData: Uint8Array | ArrayBuffer },
): Promise<OpReply<PDFMetadata>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const pageCount = doc.countPages();
        const pageLabels = collectPageLabels(doc);
        const info = collectDocumentInfo(doc);
        return { result: { pageCount, pageLabels, ...info } };
    } finally {
        releaseDoc(doc);
    }
}

export async function opExtractRawPages(
    args: { pdfData: Uint8Array | ArrayBuffer; pageIndices?: number[] },
): Promise<OpReply<RawDocumentData>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const pageCount = doc.countPages();
        const indices = resolvePageIndices(pageCount, args.pageIndices);
        const pages = indices.map((i) => extractRawPageFromDoc(doc, i));
        return { result: { pageCount, pages } as RawDocumentData };
    } finally {
        releaseDoc(doc);
    }
}

export async function opExtractRawPageDetailed(
    args: { pdfData: Uint8Array | ArrayBuffer; pageIndex: number; includeImages?: boolean },
): Promise<OpReply<RawPageDataDetailed>> {
    const doc = await acquireDoc(args.pdfData);
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
        const result = extractRawPageDetailedFromDoc(doc, args.pageIndex, !!args.includeImages);
        return { result };
    } finally {
        releaseDoc(doc);
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
    try {
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...(args.options || {}) };
        const pageCount = doc.countPages();
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
    } finally {
        releaseDoc(doc);
    }
}

export async function opSearchPages(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        query: string;
        pageIndices?: number[];
        maxHitsPerPage?: number;
    },
): Promise<OpReply<PDFPageSearchResult[]>> {
    const doc = await acquireDoc(args.pdfData);
    const limit = typeof args.maxHitsPerPage === "number" && args.maxHitsPerPage > 0
        ? args.maxHitsPerPage
        : 100;
    try {
        const pageCount = doc.countPages();
        const indices = resolvePageIndices(pageCount, args.pageIndices);
        const results: PDFPageSearchResult[] = [];
        for (const pageIndex of indices) {
            const r = searchPageInDoc(doc, pageIndex, args.query, limit);
            if (r.matchCount > 0) results.push(r);
        }
        return { result: results };
    } finally {
        releaseDoc(doc);
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
 */
function buildAnalysisFromDoc(
    doc: DocumentLike,
    opts: ExtractionSettings,
    requestedRepeatThreshold: number | undefined,
    analysisIndices: number[],
    pageCount: number,
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
    const analysisPages: RawPageData[] = analysisIndices.map((i) =>
        extractRawPageFromDoc(doc, i),
    );
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

/**
 * Project a `PageLineResult` into the flat `ExtractedLine[]` shape that
 * lives on `ProcessedPage.lines`. Used by the structured-engine branch.
 */
function flattenColumnLines(lineResult: PageLineResult): ExtractedLine[] {
    const out: ExtractedLine[] = [];
    for (const colResult of lineResult.columnResults) {
        for (const line of colResult.lines) {
            out.push({
                text: line.text,
                bbox: line.bbox,
                fontSize: line.fontSize,
                columnIndex: colResult.columnIndex,
            });
        }
    }
    return out;
}

/**
 * Shared body for `opExtract`. The per-page loop has three branches keyed
 * off `engine`:
 *   - `"paragraph"` → `detectFilteredParagraphs` produces
 *     `paragraphResult.pageContent` (`## ` headers, `\n\n` separators);
 *     `ProcessedPage.blocks` is left empty.
 *   - `"block"` → column detection + PageExtractor (block-based).
 *   - `"structured"` → `extractSentencesForPage` (per-page detailed walk
 *     + sentence mapping). Populates `paragraphs`, `sentences`,
 *     `columns`, `lines`, plus paragraph-engine `content`. `blocks: []`.
 *     Requires `splitter` (resolved by the caller). Per-page detailed
 *     walk is the dominant cost — multi-page structured extracts pay
 *     N× this per the `targetIndices` length.
 *
 * The combination `engine === "structured"` && `markdown.engine` is
 * rejected upstream by `opExtract`. All other steps (raw extraction,
 * style + margin analysis, fullText assembly, analysis build) are
 * identical, and the result shape is the same `ExtractionResult` for
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
): ExtractionResult {
    const tStart = performance.now();

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
        walkMs,
        analysisMs,
    } = buildAnalysisFromDoc(
        doc,
        opts,
        requestedRepeatThreshold,
        analysisIndices,
        pageCount,
    );

    const pages: ProcessedPage[] = [];
    const perPageMs: number[] = [];

    if (engine === "paragraph") {
        // Paragraph engine: line + paragraph detection produces markdown-shaped
        // page text via `paragraphResult.pageContent` (headers prefixed `## `,
        // paragraphs separated by `\n\n`). `detectFilteredParagraphs` accepts
        // the precomputed `marginRemoval` and `styleProfile` so it skips
        // re-running cross-page analysis. `blocks: []` because content is
        // emitted via `pageContent` rather than per-block.
        for (const i of targetIndices) {
            const tPage = performance.now();
            const rawPage = analysisPageByIndex.get(i)!;
            const filtered = detectFilteredParagraphs({
                pages: analysisPages,
                pageIndex: rawPage.pageIndex,
                marginRemoval,
                styleProfile,
                margins: opts.margins,
                marginZone: opts.marginZone,
                paragraphSettings,
            });
            logColumnDetection(rawPage.pageIndex, filtered.columnResult);
            pages.push({
                index: rawPage.pageIndex,
                label: rawPage.label,
                width: rawPage.width,
                height: rawPage.height,
                blocks: [],
                content: filtered.paragraphResult.pageContent,
                columns: filtered.columnResult.columns.map((col) => ({
                    l: col.x,
                    t: col.y,
                    r: col.x + col.w,
                    b: col.y + col.h,
                })),
            } as ProcessedPage);
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
        for (const i of targetIndices) {
            const tPage = performance.now();
            const rawPage = analysisPageByIndex.get(i)!;
            const { sentenceResult, filteredResult } = extractSentencesForPage({
                doc,
                pageIndex: rawPage.pageIndex,
                analysisPages,
                splitter,
                paragraphSettings,
                marginRemoval,
                styleProfile,
                margins: opts.margins,
                marginZone: opts.marginZone,
            });
            logColumnDetection(rawPage.pageIndex, filteredResult.columnResult);
            pages.push({
                index: sentenceResult.pageIndex,
                label: rawPage.label,
                width: sentenceResult.width,
                height: sentenceResult.height,
                blocks: [],
                content: filteredResult.paragraphResult.pageContent,
                columns: filteredResult.columnResult.columns.map((col) => ({
                    l: col.x,
                    t: col.y,
                    r: col.x + col.w,
                    b: col.y + col.h,
                })),
                lines: flattenColumnLines(filteredResult.lineResult),
                paragraphs: sentenceResult.paragraphs,
                sentences: sentenceResult.sentences,
                degradation: sentenceResult.degradation,
            } as ProcessedPage);
            perPageMs.push(performance.now() - tPage);
        }
    } else {
        const pageExtractor = new PageExtractor({ styleProfile });

        for (const i of targetIndices) {
            const tPage = performance.now();
            const rawPage = analysisPageByIndex.get(i)!;
            const filteredPage = MarginFilter.filterPageWithSmartRemoval(
                rawPage,
                opts.margins,
                opts.marginZone,
                marginRemoval,
            );
            const columnResult = detectColumns(filteredPage, {
                headerMargin: opts.margins.top,
                footerMargin: opts.margins.bottom,
            });
            logColumnDetection(rawPage.pageIndex, columnResult);

            pages.push(
                pageExtractor.extractPageWithColumns(filteredPage, columnResult, true),
            );
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
    const baseResult: ExtractionResult = {
        pages,
        analysis,
        fullText,
        pageLabels: Object.keys(pageLabels).length > 0 ? pageLabels : undefined,
        metadata: {
            extractedAt: new Date().toISOString(),
            version: "2.2.0",
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
            },
        },
    };

    return baseResult;
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
 *   - `"structured"` returns the same `ExtractionResult` shape with
 *     `pages[i].sentences` / `paragraphs` / `columns` / `lines`
 *     populated alongside paragraph-engine `content`. Per-page detailed
 *     walk is the dominant cost — multi-page structured extracts pay
 *     N× this per the requested page count.
 *
 * `markdown.engine` selects the markdown engine when `mode === "markdown"`:
 *   - `"paragraph"` (default): line + paragraph detection via
 *     `detectFilteredParagraphs`. `ProcessedPage.content` is
 *     `paragraphResult.pageContent` (markdown-shaped with `## ` headers
 *     and `\n\n` paragraph separators); `blocks: []`.
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
        structured?: { splitterConfig?: SentenceSplitterConfig };
        settings?: ExtractionSettings;
        paragraphSettings?: ParagraphDetectionSettings;
        pageIndices?: number[];
        pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        analysisWindow?: number;
    },
): Promise<OpReply<ExtractionResult>> {
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
    try {
        // Capture the caller-supplied threshold BEFORE the spread flattens
        // it to the default. `getEffectiveRepeatThreshold` uses this to
        // distinguish "user wanted 3" from "user omitted the field" so the
        // short-doc relaxation only kicks in when no explicit value was
        // provided.
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}) };
        const provider = rawPageProviderFromDoc(doc);
        const docAnalyzer = new DocumentAnalyzer(provider);
        const pageCount = docAnalyzer.getPageCount();
        const pageLabels = collectPageLabels(doc);

        if (opts.checkTextLayer) {
            const ocr = docAnalyzer.getDetailedOCRAnalysis({ minTextPerPage: opts.minTextPerPage });
            if (ocr.needsOCR) {
                throw workerError(
                    ERROR_CODES.NO_TEXT_LAYER,
                    `Document may require OCR: ${ocr.primaryReason} (${Math.round(ocr.issueRatio * 100)}% of sampled pages have issues)`,
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

        // Resolve the splitter once per request when running structured
        // mode. The helper reuses it across all target pages.
        const splitter = isStructured
            ? await resolveSplitter(
                  args.structured?.splitterConfig ?? { type: "sentencex" },
              )
            : undefined;

        const result = runExtractFromIndices(
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
        );
        // `runExtractFromIndices` measures the phases it owns; `docOpenMs`
        // and the op-level `totalMs` (which includes the OCR check) are
        // known only here. Mutate the timings record we just got back —
        // it's a fresh object built inside the helper, so this is safe.
        if (result.metadata.timings) {
            result.metadata.timings.docOpenMs = docOpenMs;
            result.metadata.timings.totalMs = performance.now() - tOpStart;
        }
        return { result };
    } finally {
        releaseDoc(doc);
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
    try {
        // Same prefix as `opExtract`: capture caller-supplied threshold
        // before defaults flatten it; merge defaults; collect labels;
        // optional OCR gate.
        const requestedRepeatThreshold = args.settings?.repeatThreshold;
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(args.settings || {}) };
        const provider = rawPageProviderFromDoc(doc);
        const docAnalyzer = new DocumentAnalyzer(provider);
        const pageCount = docAnalyzer.getPageCount();
        const pageLabels = collectPageLabels(doc);

        if (opts.checkTextLayer) {
            const ocr = docAnalyzer.getDetailedOCRAnalysis({
                minTextPerPage: opts.minTextPerPage,
            });
            if (ocr.needsOCR) {
                throw workerError(
                    ERROR_CODES.NO_TEXT_LAYER,
                    `Document may require OCR: ${ocr.primaryReason} (${Math.round(ocr.issueRatio * 100)}% of sampled pages have issues)`,
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
        // order. `resolveAnalysisPages` guarantees every target index is
        // present in the analysis union, so the lookups never miss.
        const pages: RawPageData[] = targetIndices.map(
            (i) => analysisPageByIndex.get(i)!,
        );

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
                version: "2.2.0",
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
    } finally {
        releaseDoc(doc);
    }
}

export async function opAnalyzeOCRNeeds(
    args: { pdfData: Uint8Array | ArrayBuffer; options?: OCRDetectionOptions },
): Promise<OpReply<OCRDetectionResult>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const provider = rawPageProviderFromDoc(doc);
        const analyzer = new DocumentAnalyzer(provider);
        const result = analyzer.getDetailedOCRAnalysis(args.options || {});
        return { result };
    } finally {
        releaseDoc(doc);
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

        // Step 1: search (inline of opSearchPages — share the open doc)
        const pageResults: PDFPageSearchResult[] = [];
        for (const pageIndex of indices) {
            const r = searchPageInDoc(doc, pageIndex, args.query, limit);
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
    } finally {
        releaseDoc(doc);
    }
}

/**
 * Single-page sentence-level bbox extraction with intermediates surfaced.
 * Debug-only — production sentence-level extraction goes through
 * `opExtract` with `mode: "structured"` (multi-page, returns
 * `ExtractionResult` with `pages[i].sentences`).
 *
 * Powers the dev visualizer / fixture capture / pipeline-trace
 * endpoints: returns the production sentence result PLUS the pipeline
 * intermediates (analysis-window indices, raw doc, detailed page,
 * font-bridged `pagesForFilter`, margin analysis/removal,
 * filtered-paragraph result). When `options.recordSplitter === true`,
 * also returns the `(text → ranges)` pairs from the resolved splitter.
 */
export async function opExtractSentenceBBoxesDebug(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        pageIndex: number;
        options?: WorkerSentenceBBoxDebugOptions;
    },
): Promise<OpReply<SentenceBBoxTraceResult>> {
    const doc = await acquireDoc(args.pdfData);
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
        const opts = args.options;
        const traceResult = await runSentenceExtractionFromDoc({
            doc,
            pageIndex: args.pageIndex,
            pageCount,
            splitterConfig: opts?.splitterConfig,
            analysisWindow: opts?.analysisWindow,
            paragraphSettings: opts?.paragraphSettings,
            trace: true,
            recordSplitter: opts?.recordSplitter,
        });
        return { result: traceResult };
    } finally {
        releaseDoc(doc);
    }
}

/**
 * Cross-page margin-removal analysis without column / line / paragraph
 * detection or rendering. Backs the dev-only `/pdf-smart-removal-summary`
 * triage endpoint — keeps the analysis pass off the main thread (the
 * handler used to ship raw pages back and re-run the same MarginFilter
 * passes on the UI thread).
 *
 * Page resolution mirrors the legacy handler: explicit `pageIndices` wins,
 * else `pageRange` (inclusive `start..end`), else all pages. Out-of-range
 * entries are silently filtered. The slice is then capped at
 * `DEFAULT_ANALYSIS_WINDOW_CAP` (slice from the start, not centered — the
 * caller chose which pages to scan and centering would silently drop
 * pages they asked for).
 *
 * `MarginRemovalResult.removalsByPage` and `textsToRemove` carry
 * `Map`/`Set` fields. `postMessage` preserves them via structured clone,
 * but `JSON.stringify` does NOT — flatten before writing HTTP responses.
 */
export async function opAnalyzeMarginRemoval(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        pageIndices?: number[];
        pageRange?: { start: number; end: number };
        repeatThreshold?: number;
        detectPageSequences?: boolean;
        marginZone?: MarginSettings;
    },
): Promise<OpReply<{
    totalPages: number;
    analysisPages: number[];
    result: MarginRemovalResult;
}>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const totalPages = doc.countPages();

        let analysisIndices: number[];
        if (Array.isArray(args.pageIndices)) {
            analysisIndices = args.pageIndices
                .map((n) => Number(n))
                .filter((n) => Number.isInteger(n) && n >= 0 && n < totalPages);
        } else if (args.pageRange && typeof args.pageRange === "object") {
            const start = Math.max(0, Number(args.pageRange.start) || 0);
            const end = Math.min(totalPages - 1, Number(args.pageRange.end));
            analysisIndices = [];
            for (let i = start; i <= end; i++) analysisIndices.push(i);
        } else {
            analysisIndices = [];
            for (let i = 0; i < totalPages; i++) analysisIndices.push(i);
        }
        if (analysisIndices.length > DEFAULT_ANALYSIS_WINDOW_CAP) {
            analysisIndices = analysisIndices.slice(0, DEFAULT_ANALYSIS_WINDOW_CAP);
        }
        if (analysisIndices.length === 0) {
            throw workerError(
                ERROR_CODES.PAGE_OUT_OF_RANGE,
                "No valid pages to analyze",
                { pageCount: totalPages },
            );
        }

        const pages: RawPageData[] = analysisIndices.map((i) =>
            extractRawPageFromDoc(doc, i),
        );
        const marginZone = args.marginZone ?? DEFAULT_MARGIN_ZONE;
        const requestedRepeatThreshold =
            Number.isInteger(args.repeatThreshold) &&
            (args.repeatThreshold as number) > 0
                ? args.repeatThreshold
                : undefined;
        const detectPageSequences = args.detectPageSequences !== false;

        const marginAnalysis = MarginFilter.collectMarginElements(
            pages,
            marginZone,
        );
        const result = MarginFilter.identifyElementsToRemove(
            marginAnalysis,
            getEffectiveRepeatThreshold({
                requested: requestedRepeatThreshold,
                totalPageCount: totalPages,
                analysisPageCount: analysisIndices.length,
            }),
            detectPageSequences,
        );
        return {
            result: {
                totalPages,
                analysisPages: analysisIndices,
                result,
            },
        };
    } finally {
        releaseDoc(doc);
    }
}

