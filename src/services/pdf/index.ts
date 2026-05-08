/**
 * PDF Extraction Service
 *
 * High-level facade over the MuPDF worker. Every `PDFExtractor` method
 * delegates to `getMuPDFWorkerClient()` so the heavy WASM work runs off the
 * Zotero UI thread
 */

import { getMuPDFWorkerClient } from "./MuPDFWorkerClient";
import {
    ExtractionSettings,
    ExtractionResult,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFMetadata,
    PDFSearchOptions,
    PDFSearchResult,
} from "./types";
import type { PageSentenceBBoxResult } from "./ParagraphSentenceMapper";
import type {
    ExtractSentenceBBoxesArgs,
    SentenceSplitterConfig,
} from "./sentenceTypes";

// Re-export types and classes for convenience
export * from "./types";
export { configurePDF, isConfigured } from "./config";
export type {
    PDFConfig,
    PDFLogSink,
    PDFWorkerClientSlot,
    PDFWorkerUrls,
} from "./config";
export {
    MuPDFWorkerClient,
    getMuPDFWorkerClient,
    disposeMuPDFWorker,
} from "./MuPDFWorkerClient";
export { prewarmMuPDFWorker } from "./prewarm";
export { DocumentAnalyzer } from "./DocumentAnalyzer";
export { StyleAnalyzer } from "./StyleAnalyzer";
export {
    MarginFilter,
    getEffectiveRepeatThreshold,
    type RepeatThresholdInput,
} from "./MarginFilter";
export { PageExtractor } from "./PageExtractor";
export { detectColumns, logColumnDetection } from "./ColumnDetector";
export type {
    Rect,
    ColumnDetectionResult,
    ColumnDetectionOptions,
} from "./ColumnDetector";
// Standalone figure-text detector. Not wired into the extraction
// pipeline today — exported for future NonStandardContentRegion work.
export { detectFigureTextColumns } from "./FigureTextFilter";
export type {
    FigureTextDetectionOptions,
    FigureTextDetectionResult,
    FigureTextReason,
} from "./FigureTextFilter";
export {
    detectLinesInColumn,
    detectLinesOnPage,
    logLineDetection,
    lineBBoxToRect,
} from "./LineDetector";
export type {
    LineBBox,
    DetectedSpan,
    PageLine,
    ColumnLineResult,
    PageLineResult,
    LineDetectionOptions,
} from "./LineDetector";
export {
    detectParagraphs,
    logParagraphDetection,
} from "./ParagraphDetector";
export type {
    ContentItem,
    PageParagraphResult,
    ParagraphDetectionSettings,
    ItemCounters,
} from "./ParagraphDetector";
export { SearchScorer } from "./SearchScorer";
export {
    simpleRegexSentenceSplit,
    flattenPageText,
    sentenceToBoxes,
    extractSentenceBBoxes,
    buildFeasibilityReport,
} from "./SentenceMapper";
export type {
    SentenceRange,
    SentenceSplitter,
    PageText,
    FeasibilityReport,
} from "./SentenceMapper";
export {
    buildDetailedLineLookup,
    buildParagraphText,
    extractPageSentenceBBoxes,
    buildParagraphFeasibilityReport,
} from "./ParagraphSentenceMapper";
export type {
    ParagraphText,
    ParagraphWithSentences,
    PageSentenceBBoxResult,
    PageSentenceBBoxOptions,
    ParagraphFeasibilityReport,
} from "./ParagraphSentenceMapper";
export {
    normalizeLanguageCode,
    buildByteOffsetTable,
    byteRangesToCharRanges,
} from "./SentencexSplitter";
export type { SentencexBoundary } from "./SentencexSplitter";
export {
    resolveAnalysisPages,
    DEFAULT_ANALYSIS_WINDOW_CAP,
} from "./AnalysisWindow";
export { buildPageAnalysisContext } from "./PageAnalysisContext";
export type {
    PageAnalysisContext,
    PageAnalysisContextInput,
} from "./PageAnalysisContext";
export { detectFilteredParagraphs } from "./FilteredParagraphPipeline";
export {
    bridgeDetailedPageFonts,
    pagesForFilterWithBridgedFonts,
} from "./RawFontBridge";
export type {
    FilteredParagraphContext,
    FilteredParagraphResult,
} from "./FilteredParagraphPipeline";
export type {
    SentenceSplitterConfig,
    ExtractSentenceBBoxesArgs,
    WorkerSentenceBBoxOptions,
    SentenceBBoxTrace,
    SentenceBBoxTraceResult,
} from "./sentenceTypes";

/**
 * PDFExtractor - High-level API for extracting text from PDFs.
 *
 * Every method delegates to the shared MuPDF worker (see
 * `getMuPDFWorkerClient()`) so the heavy WASM work runs off the Zotero UI
 * thread. This class is a thin worker facade.
 *
 * Usage:
 * ```typescript
 * const extractor = new PDFExtractor();
 * const result = await extractor.extract(pdfData, {
 *   pageRange: { startIndex: 0, endIndex: 2 },
 * });
 * console.log(result.fullText);
 * ```
 */
export class PDFExtractor {
    /**
     * Strict, fused extract for handlers that have deferred range validation
     * to the worker. Returns an `ExtractionResult` with `analysis.pageCount`
     * and `pageLabels` populated.
     *
     * Args:
     *  - `pageIndices` (mutually exclusive with `pageRange`): explicit
     *    0-based indices. Empty/undefined → all pages. Non-empty but all
     *    invalid → `ExtractionError(PAGE_OUT_OF_RANGE)`.
     *  - `pageRange`: `{ startIndex, endIndex?, maxPages? }` resolved inside
     *    the worker (avoids a main-thread page-count round-trip for
     *    open-ended end_page).
     *
     * `settings.useLineDetection` is honored — when true, each
     * `ProcessedPage.lines` is populated with bbox + fontSize + columnIndex
     * metadata and `page.content` becomes the line texts joined with `\n`.
     * `blocks` is left empty in that mode.
     */
    async extract(
        pdfData: Uint8Array | ArrayBuffer,
        args: {
            settings?: ExtractionSettings;
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
            /**
             * Cross-page analysis window for margin smart-removal and
             * the document-wide style profile. `0` (default) analyzes
             * only the requested target pages; `N>0` adds ±N neighbors
             * around each target; `Infinity` covers the whole doc.
             */
            analysisWindow?: number;
        } = {}
    ): Promise<ExtractionResult> {
        return getMuPDFWorkerClient().extract(pdfData, args);
    }

    /**
     * Perform detailed OCR detection analysis without full extraction.
     *
     * This method analyzes the document to determine if it needs OCR,
     * providing detailed information about why OCR might be needed.
     *
     * Checks performed:
     * - Text presence and sufficiency
     * - Text quality (whitespace ratio, alphanumeric ratio, invalid chars)
     * - Large image coverage (scanned page detection)
     * - Bounding box validation (overflow, overlapping lines)
     *
     * @param pdfData - PDF file data
     * @param options - Detection options
     * @returns Detailed OCR analysis result
     */
    async analyzeOCRNeeds(
        pdfData: Uint8Array | ArrayBuffer,
        args: OCRDetectionOptions = {}
    ): Promise<OCRDetectionResult> {
        return getMuPDFWorkerClient().analyzeOCRNeeds(pdfData, args);
    }

    /**
     * Get page count without full extraction.
     */
    async getPageCount(pdfData: Uint8Array | ArrayBuffer): Promise<number> {
        return getMuPDFWorkerClient().getPageCount(pdfData);
    }

    /**
     * Get document-level metadata in a single doc-open.
     *
     * Returns page count, page labels, and cheap info-dict fields
     * (title, author, format, etc.). Page-label collection requires a
     * per-page load; the info-dict reads are essentially free. Use
     * `getPageCount` when you only need the count and want to skip the
     * per-page label pass.
     */
    async getMetadata(
        pdfData: Uint8Array | ArrayBuffer
    ): Promise<PDFMetadata> {
        return getMuPDFWorkerClient().getMetadata(pdfData);
    }

    /**
     * Extract sentence-level bounding boxes for a single page.
     *
     * One worker round-trip — the worker owns analysis-window loading,
     * detailed page extraction, font bridging, filtered paragraph
     * detection, splitter resolution, and sentence mapping.
     *
     * Splitter resolution is described by a serializable
     * `SentenceSplitterConfig`: `{ type: "sentencex", language? }` (default)
     * or `{ type: "simple" }`. The worker resolves the actual splitter
     * function internally and degrades to the regex splitter on sentencex
     * init failure.
     *
     * **Language precedence.** When both `args.splitter` and `args.language`
     * are provided, the explicit `splitter` config wins. `args.language`
     * is only consulted when `args.splitter` is omitted entirely (in
     * which case the facade defaults to
     * `{ type: "sentencex", language: args.language }`).
     *
     * **Graceful degradation.** A paragraph that fails the precise mapping
     * path (unmapped, text/chars invariant violation, or empty-split)
     * contributes a single fallback sentence covering the whole paragraph
     * bbox, and is counted in `result.unmappedParagraphs` or
     * `result.degradedParagraphs`. The function never throws on correctness
     * traps; the whole-page answer is always usable.
     *
     * @example
     * ```typescript
     * const extractor = new PDFExtractor();
     * const result = await extractor.extractSentenceBBoxes(pdfData, {
     *   pageIndex: 3,
     *   splitter: { type: "sentencex", language: "en" },
     * });
     * for (const sentence of result.sentences) {
     *   console.log(sentence.text, sentence.bboxes);
     * }
     * ```
     */
    async extractSentenceBBoxes(
        pdfData: Uint8Array | ArrayBuffer,
        args: ExtractSentenceBBoxesArgs,
    ): Promise<PageSentenceBBoxResult> {
        const { pageIndex, splitter, language, paragraphSettings, analysisWindow } = args;
        const splitterConfig: SentenceSplitterConfig =
            splitter ?? { type: "sentencex", language };
        // Forward only the named production fields. Spreading `...rest` would
        // let an `any`-typed or request-derived `args` object leak `debug: true`
        // through to the worker call, silently turning this method's
        // `Promise<PageSentenceBBoxResult>` into a trace envelope at runtime.
        return getMuPDFWorkerClient().extractSentenceBBoxes(
            pdfData,
            pageIndex,
            { splitterConfig, paragraphSettings, analysisWindow },
        );
    }

    /**
     * Strict, fused render-pages variant for the agent images handler.
     *
     * Returns `{ pageCount, pageLabels, pages }` from a single worker
     * round-trip.
     *
     * Args mirror `extract`. All-pages requests should pass
     * `pageIndices: undefined` (or omit args entirely), NOT a pre-enumerated
     * list — that requires knowing pageCount upfront, which is what we're
     * trying to avoid.
     *
     * For single-page renders, pass `pageIndices: [n]` and read `pages[0]`.
     */
    async renderPages(
        pdfData: Uint8Array | ArrayBuffer,
        args: {
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
            options?: PageImageOptions;
        } = {}
    ): Promise<{ pageCount: number; pageLabels: Record<number, string>; pages: PageImageResult[] }> {
        return getMuPDFWorkerClient().renderPages(pdfData, args);
    }

    /**
     * Search for text within a PDF document.
     *
     * Search Behavior:
     * - Simple phrase search (grep-like) - matches literal text
     * - Case-insensitive matching (handled by MuPDF)
     * - No boolean operators (AND/OR) - for multiple terms, perform separate searches
     * - Returns whole pages ranked by relevance score (highest first)
     * - Each hit includes QuadPoint coordinates for highlighting
     *
     * Scoring Methodology:
     * - Each hit is weighted by text role (heading=3.0, body=1.0, caption=0.7, footnote=0.3)
     * - Page score = sum of weighted hits, normalized by sqrt(text_length)
     * - This prioritizes pages where matches appear in significant content
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param query - Text to search for (literal phrase match)
     * @param args - Search options plus pre-flight controls. `maxPageCount`
     *               short-circuits the worker when the document exceeds the
     *               limit, returning a flagged result
     *               (`exceedsPageCountLimit: true`) instead of running the
     *               search.
     * @returns PDFSearchResult with ranked pages and hit positions
     *
     * @example
     * ```typescript
     * const extractor = new PDFExtractor();
     * const result = await extractor.search(pdfData, "machine learning");
     * console.log(`Found ${result.totalMatches} matches in ${result.pagesWithMatches} pages`);
     *
     * // Iterate through ranked pages (highest score first)
     * for (const page of result.pages) {
     *   console.log(`Page ${page.pageIndex + 1}: score=${page.score.toFixed(2)}, matches=${page.matchCount}`);
     * }
     * ```
     */
    async search(
        pdfData: Uint8Array | ArrayBuffer,
        query: string,
        args: PDFSearchOptions & { maxPageCount?: number } = {}
    ): Promise<PDFSearchResult> {
        const { maxPageCount, ...options } = args;
        // search + score within one worker round-trip.
        return getMuPDFWorkerClient().search(pdfData, query, options, { maxPageCount });
    }
}

