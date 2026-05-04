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
 * MuPDFService, MuPDFWorkerClient, and the getPref-using PDFExtractor —
 * none of which are worker-safe. Import analyzers and types directly:
 *   import { StyleAnalyzer } from "../StyleAnalyzer";
 *   import type { RawPageData, ExtractionResult } from "../types";
 */

import { DocumentAnalyzer } from "../DocumentAnalyzer";
import { StyleAnalyzer } from "../StyleAnalyzer";
import { MarginFilter } from "../MarginFilter";
import { PageExtractor } from "../PageExtractor";
import { detectColumns, logColumnDetection } from "../ColumnDetector";
import { detectLinesOnPage, logLineDetection } from "../LineDetector";
import type { PageLineResult } from "../LineDetector";
import { SearchScorer } from "../SearchScorer";
import { extractPageSentenceBBoxes } from "../ParagraphSentenceMapper";
import type {
    DocumentAnalysis,
    ExtractionResult,
    ExtractionSettings,
    ExtractedLine,
    LineExtractionResult,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFPageSearchResult,
    PDFSearchOptions,
    PDFSearchResult,
    ProcessedPage,
    RawDocumentData,
    RawPageData,
    RawPageDataDetailed,
} from "../types";
import {
    DEFAULT_EXTRACTION_SETTINGS,
    DEFAULT_PDF_SEARCH_OPTIONS,
    DEFAULT_SEARCH_SCORING_OPTIONS,
} from "../types";
import type { PageSentenceBBoxOptions, PageSentenceBBoxResult } from "../ParagraphSentenceMapper";
import { ERROR_CODES, workerError } from "./errors";
import { acquireDoc, releaseDoc } from "./docCache";
import { ensureApi } from "./wasmInit";
import {
    DEFAULT_PAGE_IMAGE_OPTIONS,
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

export async function opGetPageCountAndLabels(
    args: { pdfData: Uint8Array | ArrayBuffer },
): Promise<OpReply<{ count: number; labels: Record<number, string> }>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const count = doc.countPages();
        const labels = collectPageLabels(doc);
        return { result: { count, labels } };
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

export async function opRenderPagesToImages(
    args: { pdfData: Uint8Array | ArrayBuffer; pageIndices?: number[]; options?: PageImageOptions },
): Promise<OpReply<PageImageResult[]>> {
    const api = await ensureApi();
    const doc = await acquireDoc(args.pdfData);
    try {
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...(args.options || {}) };
        const pageCount = doc.countPages();
        const indices = resolvePageIndices(pageCount, args.pageIndices);
        const out: PageImageResult[] = [];
        const transfer: Transferable[] = [];
        for (const pageIndex of indices) {
            const r = renderOnePage(api, doc, pageIndex, opts);
            out.push(r);
            transfer.push(r.data.buffer);
        }
        return { result: out, transfer };
    } finally {
        releaseDoc(doc);
    }
}

/**
 * Strict, fused render-pages op for the images handler.
 *
 * Combines `getPageCountAndLabels` + `renderPagesToImages` into a single
 * doc-open. Returns metadata alongside the rendered pages so the handler
 * can populate `total_pages` and per-page `page_label` in the response
 * without an extra round-trip. Image buffers are transferred (per-page
 * `r.data.buffer`).
 */
export async function opRenderPagesToImagesWithMeta(
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

export async function opRenderPageToImage(
    args: { pdfData: Uint8Array | ArrayBuffer; pageIndex: number; options?: PageImageOptions },
): Promise<OpReply<PageImageResult>> {
    const api = await ensureApi();
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
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...(args.options || {}) };
        const result = renderOnePage(api, doc, args.pageIndex, opts);
        return { result, transfer: [result.data.buffer] };
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
 * Shared body for `extract` / `extractByLines` / `extractWithMeta`. Differs
 * only in the per-page loop: column detection + PageExtractor (extract) vs
 * column + line detection (extractByLines). All other steps (raw extraction,
 * style + margin analysis, fullText assembly, analysis build) are identical.
 *
 * The caller is responsible for opening the doc, resolving the page indices,
 * collecting page labels, and running the OCR text-layer check (NO_TEXT_LAYER
 * needs `pageLabels` and `pageCount` in its payload, which the caller already
 * has). This helper just turns those inputs into an ExtractionResult.
 */
function runExtractFromIndices(
    doc: DocumentLike,
    opts: Required<Omit<ExtractionSettings, 'pages' | 'useLineDetection' | 'minTextPerPage' | 'styleSampleSize'>> & ExtractionSettings,
    indices: number[],
    pageCount: number,
    pageLabels: Record<number, string>,
    useLineDetection: boolean,
): ExtractionResult | LineExtractionResult {
    const rawPages: RawPageData[] = indices.map((i) => extractRawPageFromDoc(doc, i));
    const rawData: RawDocumentData = { pageCount, pages: rawPages };

    const styleAnalyzer = new StyleAnalyzer();
    const styleProfile = styleAnalyzer.analyze(
        rawData.pages,
        4,
        0.15,
        opts.styleSampleSize,
    );
    StyleAnalyzer.logStyleProfile(styleProfile);

    const marginAnalysis = MarginFilter.collectMarginElements(rawData.pages, opts.marginZone);
    const removalResult = MarginFilter.identifyElementsToRemove(
        marginAnalysis,
        opts.repeatThreshold,
        opts.detectPageSequences,
    );
    MarginFilter.logRemovalCandidates(removalResult);

    const pages: ProcessedPage[] = [];
    if (useLineDetection) {
        for (const rawPage of rawData.pages) {
            const filteredPage = MarginFilter.filterPageWithSmartRemoval(
                rawPage,
                opts.margins,
                opts.marginZone,
                removalResult,
            );
            const columnResult = detectColumns(filteredPage);
            logColumnDetection(rawPage.pageIndex, columnResult);
            const lineResult: PageLineResult = detectLinesOnPage(filteredPage, columnResult.columns);
            logLineDetection(lineResult);

            const extractedLines: ExtractedLine[] = [];
            for (const colResult of lineResult.columnResults) {
                for (const line of colResult.lines) {
                    extractedLines.push({
                        text: line.text,
                        bbox: line.bbox,
                        fontSize: line.fontSize,
                        columnIndex: colResult.columnIndex,
                    });
                }
            }
            const content = extractedLines.map((l) => l.text).join("\n");
            pages.push({
                index: rawPage.pageIndex,
                label: rawPage.label,
                width: rawPage.width,
                height: rawPage.height,
                blocks: [],
                content,
                columns: columnResult.columns.map((col) => ({
                    l: col.x,
                    t: col.y,
                    r: col.x + col.w,
                    b: col.y + col.h,
                })),
                lines: extractedLines,
            } as ProcessedPage);
        }
    } else {
        const pageExtractor = new PageExtractor({ styleProfile });
        for (const rawPage of rawData.pages) {
            const filteredPage = MarginFilter.filterPageWithSmartRemoval(
                rawPage,
                opts.margins,
                opts.marginZone,
                removalResult,
            );
            const columnResult = detectColumns(filteredPage);
            logColumnDetection(rawPage.pageIndex, columnResult);
            pages.push(pageExtractor.extractPageWithColumns(filteredPage, columnResult, true));
        }
    }

    const fullText = pages.map((p) => p.content).join("\n\n");
    const analysis: DocumentAnalysis = {
        pageCount: rawData.pageCount,
        hasTextLayer: true,
        styleProfile,
        marginAnalysis,
    };

    const finalSettings = { ...opts, useLineDetection };
    const baseResult = {
        pages,
        analysis,
        fullText,
        pageLabels: Object.keys(pageLabels).length > 0 ? pageLabels : undefined,
        metadata: {
            extractedAt: new Date().toISOString(),
            version: "2.0.0",
            settings: finalSettings,
        },
    };

    return baseResult as ExtractionResult | LineExtractionResult;
}

/**
 * Legacy lenient pre-amble shared by `opExtract` / `opExtractByLines`. Runs
 * page-count + label collection + OCR check, then resolves indices using the
 * lenient `opts.pages?.length ? filter : undefined → resolvePageIndices`
 * semantics (empty filter → all pages). Preserved for callers that have not
 * been migrated to the strict resolver — dev tools, itemValidationManager,
 * getAttachmentFileStatus.
 */
function runExtractCommon(
    doc: DocumentLike,
    settings: ExtractionSettings | undefined,
    useLineDetection: boolean,
): ExtractionResult | LineExtractionResult {
    const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...(settings || {}) };

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

    const pageIndices = opts.pages?.length
        ? opts.pages.filter((i: number) => i >= 0 && i < pageCount)
        : undefined;
    const indices = resolvePageIndices(pageCount, pageIndices);

    return runExtractFromIndices(doc, opts as any, indices, pageCount, pageLabels, useLineDetection);
}

export async function opExtract(
    args: { pdfData: Uint8Array | ArrayBuffer; settings?: ExtractionSettings },
): Promise<OpReply<ExtractionResult | LineExtractionResult>> {
    const useLineDetection = !!args.settings?.useLineDetection;
    const doc = await acquireDoc(args.pdfData);
    try {
        const result = runExtractCommon(doc, args.settings, useLineDetection);
        return { result };
    } finally {
        releaseDoc(doc);
    }
}

export async function opExtractByLines(
    args: { pdfData: Uint8Array | ArrayBuffer; settings?: ExtractionSettings },
): Promise<OpReply<LineExtractionResult>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const result = runExtractCommon(doc, args.settings, true) as LineExtractionResult;
        return { result };
    } finally {
        releaseDoc(doc);
    }
}

/**
 * Strict, fused extract op for the agent handlers.
 *
 * Combines what the pages handler used to fetch as separate round-trips
 * (`getPageCountAndLabels` + `getPageCount` + `extract`) into a single
 * doc-open. Uses the strict resolvers — explicit-but-all-invalid page
 * inputs throw PAGE_OUT_OF_RANGE with `{ pageCount }` in the payload so
 * handlers can populate `total_pages` in error responses.
 *
 * Rejects useLineDetection — line extraction must go through opExtractByLines.
 */
export async function opExtractWithMeta(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        settings?: ExtractionSettings;
        pageIndices?: number[];
        pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
    },
): Promise<OpReply<ExtractionResult>> {
    if (args.settings?.useLineDetection) {
        throw workerError(
            ERROR_CODES.WASM_ERROR,
            "opExtractWithMeta does not support useLineDetection — call opExtractByLines instead",
        );
    }
    const doc = await acquireDoc(args.pdfData);
    try {
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

        const indices = args.pageRange
            ? resolvePageRangeOrThrow(pageCount, args.pageRange)
            : resolveExplicitPageIndicesOrThrow(pageCount, args.pageIndices);

        const result = runExtractFromIndices(
            doc,
            opts as any,
            indices,
            pageCount,
            pageLabels,
            false,
        ) as ExtractionResult;
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

export async function opHasTextLayer(
    args: { pdfData: Uint8Array | ArrayBuffer },
): Promise<OpReply<boolean>> {
    const doc = await acquireDoc(args.pdfData);
    try {
        const provider = rawPageProviderFromDoc(doc);
        const analyzer = new DocumentAnalyzer(provider);
        return { result: analyzer.hasTextLayer() };
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
        // Parity with main-thread `PDFExtractor.search`
        // (`src/services/pdf/index.ts:813-816`): when `opts.pages` has length
        // but every entry is out-of-range, the main-thread filter produces
        // `[]` which `MuPDFService.searchPages` then treats as "all pages"
        // via its own `?.length` falsy-fallback. Reproduce that two-stage
        // behavior here so a stale `opts.pages` doesn't silently turn into
        // a no-result search on the worker path.
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

export async function opExtractSentenceBBoxes(
    args: {
        pdfData: Uint8Array | ArrayBuffer;
        pageIndex: number;
        options?: PageSentenceBBoxOptions;
    },
): Promise<OpReply<PageSentenceBBoxResult>> {
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
        const detailed = extractRawPageDetailedFromDoc(doc, args.pageIndex, false);
        const result = extractPageSentenceBBoxes(detailed, args.options);
        return { result };
    } finally {
        releaseDoc(doc);
    }
}
