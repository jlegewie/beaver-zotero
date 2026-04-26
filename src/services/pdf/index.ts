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
    LineExtractionResult,
    RawDocumentData,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFSearchOptions,
    PDFSearchResult,
    DEFAULT_EXTRACTION_SETTINGS,
} from "./types";
import {
    extractPageSentenceBBoxes,
    type PageSentenceBBoxOptions,
    type PageSentenceBBoxResult,
} from "./ParagraphSentenceMapper";

// Re-export types and classes for convenience
export * from "./types";
export { MuPDFService, disposeMuPDF } from "./MuPDFService";
export {
    MuPDFWorkerClient,
    getMuPDFWorkerClient,
    disposeMuPDFWorker,
} from "./MuPDFWorkerClient";
export { prewarmMuPDFWorker } from "./prewarm";
export { DocumentAnalyzer } from "./DocumentAnalyzer";
export type { TextLayerCheckOptions } from "./DocumentAnalyzer";
export { StyleAnalyzer } from "./StyleAnalyzer";
export { MarginFilter } from "./MarginFilter";
export { PageExtractor } from "./PageExtractor";
export { detectColumns, logColumnDetection } from "./ColumnDetector";
export type { Rect, ColumnDetectionResult, ColumnDetectionOptions } from "./ColumnDetector";
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

/**
 * PDFExtractor - High-level API for extracting text from PDFs.
 *
 * Every method delegates to the shared MuPDF worker (see
 * `getMuPDFWorkerClient()`). This class is a thin worker facade — for
 * synchronous main-thread access (e.g. dev tooling like
 * `extractionVisualizer.ts`), use `MuPDFService` directly.
 *
 * Usage:
 * ```typescript
 * const extractor = new PDFExtractor();
 * const result = await extractor.extract(pdfData, { pages: [0, 1, 2] });
 * console.log(result.fullText);
 * ```
 */
export class PDFExtractor {
    /**
     * Extract text from a PDF file.
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param settings - Extraction settings (set useLineDetection=true for line-level extraction)
     * @returns Extraction result with pages, analysis, and full text
     */
    async extract(
        pdfData: Uint8Array | ArrayBuffer,
        settings: ExtractionSettings = {}
    ): Promise<ExtractionResult> {
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...settings };

        // If line detection is requested, delegate to extractByLines
        if (opts.useLineDetection) {
            return this.extractByLines(pdfData, settings);
        }

        return getMuPDFWorkerClient().extract(pdfData, settings);
    }

    /**
     * Simple text extraction (convenience method).
     * Returns just the plain text without detailed analysis.
     */
    async extractText(
        pdfData: Uint8Array | ArrayBuffer,
        settings: ExtractionSettings = {}
    ): Promise<string> {
        const result = await this.extract(pdfData, settings);
        return result.fullText;
    }

    /**
     * Extract high-quality content by page using line detection.
     *
     * This method provides superior text extraction by:
     * - Detecting text lines within columns
     * - Preserving proper reading order
     * - Including line-level metadata (bbox, font size, column)
     * - Maintaining structural information
     *
     * Use this when you need:
     * - Precise text positioning
     * - Line-by-line processing
     * - High-fidelity text extraction for RAG/indexing
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param settings - Extraction settings
     * @returns Line-based extraction result with detailed page content
     */
    async extractByLines(
        pdfData: Uint8Array | ArrayBuffer,
        settings: ExtractionSettings = {}
    ): Promise<LineExtractionResult> {
        return getMuPDFWorkerClient().extractByLines(pdfData, {
            ...settings,
            useLineDetection: true,
        });
    }

    /**
     * Check if a PDF has a text layer.
     * Useful for determining if OCR is needed before full extraction.
     */
    async hasTextLayer(pdfData: Uint8Array | ArrayBuffer): Promise<boolean> {
        return getMuPDFWorkerClient().hasTextLayer(pdfData);
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
        options: OCRDetectionOptions = {}
    ): Promise<OCRDetectionResult> {
        return getMuPDFWorkerClient().analyzeOCRNeeds(pdfData, options);
    }

    /**
     * Get page count without full extraction.
     */
    async getPageCount(pdfData: Uint8Array | ArrayBuffer): Promise<number> {
        return getMuPDFWorkerClient().getPageCount(pdfData);
    }

    /**
     * Get page count and all page labels in a single metadata-only pass.
     */
    async getPageCountAndLabels(
        pdfData: Uint8Array | ArrayBuffer
    ): Promise<{ count: number; labels: Record<number, string> }> {
        return getMuPDFWorkerClient().getPageCountAndLabels(pdfData);
    }

    /**
     * Get raw document data without processing.
     * Useful for debugging or custom processing.
     */
    async extractRaw(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndices?: number[]
    ): Promise<RawDocumentData> {
        return getMuPDFWorkerClient().extractRawPages(pdfData, pageIndices);
    }

    /**
     * Extract sentence-level bounding boxes for a single page.
     *
     * Runs the paragraph-scoped sentence mapper pipeline:
     *   1. Character-level walk via `MuPDFService.extractRawPageDetailed`.
     *   2. Column + line + paragraph detection (existing detectors reused).
     *   3. Per-paragraph sentence split (default: simple regex; callers can
     *      inject their own via `options.splitter`).
     *   4. Each sentence range resolved to one bbox per line-fragment.
     *
     * **Graceful degradation.** A paragraph that fails the precise mapping
     * path (unmapped, text/chars invariant violation, or empty-split)
     * contributes a single fallback sentence covering the whole paragraph
     * bbox, and is counted in `result.unmappedParagraphs` or
     * `result.degradedParagraphs`. The function never throws on correctness
     * traps; the whole-page answer is always usable.
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param pageIndex - 0-based page index
     * @param options - Pipeline options (splitter, paragraph detector settings)
     * @returns Sentences grouped by paragraph, plus a flat sentence list and
     *          degradation counters.
     *
     * @example
     * ```typescript
     * const extractor = new PDFExtractor();
     * const result = await extractor.extractSentenceBBoxes(pdfData, 0);
     * for (const sentence of result.sentences) {
     *   console.log(sentence.text, sentence.bboxes);
     * }
     * ```
     */
    async extractSentenceBBoxes(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options: PageSentenceBBoxOptions = {}
    ): Promise<PageSentenceBBoxResult> {
        const client = getMuPDFWorkerClient();
        if (options.splitter) {
            // Custom splitter is a function — not structurally cloneable
            // across the worker boundary. Fall back to the PR #2 split
            // routing: detailed page in the worker, mapper main-thread.
            // Preserves the documented `options.splitter` API.
            const detailed = await client.extractRawPageDetailed(pdfData, pageIndex);
            return extractPageSentenceBBoxes(detailed, options);
        }
        // Default splitter — full mapper runs in the worker (single
        // round-trip). Worker validates pageIndex and throws
        // PAGE_OUT_OF_RANGE.
        return client.extractSentenceBBoxes(pdfData, pageIndex, options);
    }

    /**
     * Render a single page to an image.
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param pageIndex - Page index (0-based)
     * @param options - Rendering options (scale, dpi, format, etc.)
     * @returns PageImageResult with image data and metadata
     *
     * @example
     * ```typescript
     * const extractor = new PDFExtractor();
     * // Render at 150 DPI as PNG
     * const result = await extractor.renderPageToImage(pdfData, 0, { dpi: 150 });
     * console.log(`Image: ${result.width}x${result.height} @ ${result.dpi} DPI`);
     * ```
     */
    async renderPageToImage(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options: PageImageOptions = {}
    ): Promise<PageImageResult> {
        return getMuPDFWorkerClient().renderPageToImage(pdfData, pageIndex, options);
    }

    /**
     * Render multiple pages to images.
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param pageIndices - Pages to render (0-based). If undefined, renders all.
     * @param options - Rendering options (scale, dpi, format, etc.)
     * @returns Array of PageImageResult
     *
     * @example
     * ```typescript
     * const extractor = new PDFExtractor();
     * // Render first 3 pages at 2x scale as JPEG
     * const results = await extractor.renderPagesToImages(pdfData, [0, 1, 2], {
     *   scale: 2.0,
     *   format: "jpeg",
     *   jpegQuality: 90
     * });
     * ```
     */
    async renderPagesToImages(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndices?: number[],
        options: PageImageOptions = {}
    ): Promise<PageImageResult[]> {
        return getMuPDFWorkerClient().renderPagesToImages(pdfData, pageIndices, options);
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
     * @param options - Search options including scoring configuration
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
        options: PDFSearchOptions = {}
    ): Promise<PDFSearchResult> {
        // search + score within one worker round-trip.
        return getMuPDFWorkerClient().search(pdfData, query, options);
    }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Extract text from a Zotero attachment item.
 *
 * @param item - Zotero attachment item
 * @param settings - Extraction settings
 * @returns Extraction result or null if file not found
 */
export async function extractFromZoteroItem(
    item: Zotero.Item,
    settings: ExtractionSettings = {}
): Promise<ExtractionResult | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path);
    const extractor = new PDFExtractor();
    return extractor.extract(pdfData, settings);
}

/**
 * Extract plain text from a Zotero attachment item.
 * Simple convenience function for basic use cases.
 *
 * @param item - Zotero attachment item
 * @returns Plain text or null if file not found
 */
export async function extractTextFromZoteroItem(
    item: Zotero.Item
): Promise<string | null> {
    const result = await extractFromZoteroItem(item);
    return result?.fullText ?? null;
}

/**
 * Extract high-quality content by lines from a Zotero attachment item.
 *
 * This provides the best quality extraction with line-level granularity,
 * proper reading order, and structural metadata for each line.
 *
 * @param item - Zotero attachment item
 * @param settings - Extraction settings
 * @returns Line-based extraction result or null if file not found
 */
export async function extractByLinesFromZoteroItem(
    item: Zotero.Item,
    settings: ExtractionSettings = {}
): Promise<LineExtractionResult | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path);
    const extractor = new PDFExtractor();
    return extractor.extractByLines(pdfData, settings);
}

/**
 * Render a page from a Zotero attachment item to an image.
 *
 * @param item - Zotero attachment item
 * @param pageIndex - Page index (0-based). Default: 0
 * @param options - Rendering options (scale, dpi, format, etc.)
 * @returns PageImageResult or null if file not found
 *
 * @example
 * ```typescript
 * // Render first page at 150 DPI
 * const result = await renderPageToImageFromZoteroItem(item, 0, { dpi: 150 });
 * if (result) {
 *   // result.data is a Uint8Array of PNG/JPEG bytes
 *   console.log(`Rendered: ${result.width}x${result.height}`);
 * }
 * ```
 */
export async function renderPageToImageFromZoteroItem(
    item: Zotero.Item,
    pageIndex: number = 0,
    options: PageImageOptions = {}
): Promise<PageImageResult | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path);
    const extractor = new PDFExtractor();
    return extractor.renderPageToImage(pdfData, pageIndex, options);
}

/**
 * Render multiple pages from a Zotero attachment item to images.
 *
 * @param item - Zotero attachment item
 * @param pageIndices - Pages to render (0-based). If undefined, renders all.
 * @param options - Rendering options (scale, dpi, format, etc.)
 * @returns Array of PageImageResult or null if file not found
 *
 * @example
 * ```typescript
 * // Render all pages as thumbnails (low resolution)
 * const results = await renderPagesToImagesFromZoteroItem(item, undefined, {
 *   scale: 0.25,
 *   format: "jpeg",
 *   jpegQuality: 75
 * });
 * ```
 */
export async function renderPagesToImagesFromZoteroItem(
    item: Zotero.Item,
    pageIndices?: number[],
    options: PageImageOptions = {}
): Promise<PageImageResult[] | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path);
    const extractor = new PDFExtractor();
    return extractor.renderPagesToImages(pdfData, pageIndices, options);
}

/**
 * Search for text within a PDF from a Zotero attachment item.
 *
 * Search Behavior:
 * - Simple phrase search (grep-like) - matches literal text
 * - Case-insensitive matching
 * - No boolean operators (AND/OR) - for multiple terms, perform separate searches
 * - Returns whole pages ranked by match count (most matches first)
 * - Each hit includes QuadPoint coordinates for highlighting
 *
 * @param item - Zotero attachment item
 * @param query - Text to search for (literal phrase match)
 * @param options - Search options
 * @returns PDFSearchResult or null if file not found
 *
 * @example
 * ```typescript
 * const result = await searchFromZoteroItem(item, "machine learning");
 * if (result) {
 *   console.log(`Found ${result.totalMatches} matches in ${result.pagesWithMatches} pages`);
 *
 *   // Get top 3 pages with most matches
 *   const topPages = result.pages.slice(0, 3);
 *   for (const page of topPages) {
 *     console.log(`Page ${page.pageIndex + 1}: ${page.matchCount} matches`);
 *   }
 * }
 * ```
 */
export async function searchFromZoteroItem(
    item: Zotero.Item,
    query: string,
    options: PDFSearchOptions = {}
): Promise<PDFSearchResult | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path);
    const extractor = new PDFExtractor();
    return extractor.search(pdfData, query, options);
}

/**
 * Extract sentence-level bounding boxes for a single page of a Zotero
 * attachment item.
 *
 * Convenience wrapper around `PDFExtractor.extractSentenceBBoxes` that
 * reads the PDF file from disk. Returns `null` when the file is not
 * available locally. Graceful degradation applies — see the method docs
 * for details on `unmappedParagraphs` / `degradedParagraphs`.
 *
 * @param item - Zotero attachment item (must be a PDF)
 * @param pageIndex - 0-based page index
 * @param options - Pipeline options forwarded to `extractSentenceBBoxes`
 * @returns Sentences grouped by paragraph + flat sentence list, or `null`
 *          if the file cannot be read.
 *
 * @example
 * ```typescript
 * const result = await extractSentenceBBoxesFromZoteroItem(item, 0);
 * if (result) {
 *   for (const p of result.paragraphs) {
 *     console.log(`${p.item.type}: ${p.sentences.length} sentences`);
 *   }
 * }
 * ```
 */
export async function extractSentenceBBoxesFromZoteroItem(
    item: Zotero.Item,
    pageIndex: number,
    options: PageSentenceBBoxOptions = {}
): Promise<PageSentenceBBoxResult | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path);
    const extractor = new PDFExtractor();
    return extractor.extractSentenceBBoxes(pdfData, pageIndex, options);
}
