/**
 * PDF Extraction Service
 *
 * Main entry point for PDF text extraction.
 * Orchestrates the extraction pipeline:
 *   1. Open document with MuPDFService
 *   2. Extract raw structured text (single pass)
 *   3. Analyze document (text layer, styles, margins)
 *   4. Process pages with filtering
 *   5. Combine results
 */

import { MuPDFService, disposeMuPDF } from "./MuPDFService";
import { DocumentAnalyzer } from "./DocumentAnalyzer";
import { StyleAnalyzer } from "./StyleAnalyzer";
import { MarginFilter } from "./MarginFilter";
import { PageExtractor } from "./PageExtractor";
import { detectColumns, logColumnDetection } from "./ColumnDetector";
import { detectLinesOnPage, logLineDetection } from "./LineDetector";
import type { PageLineResult } from "./LineDetector";
import {
    ExtractionSettings,
    ExtractionResult,
    LineExtractionResult,
    DocumentAnalysis,
    ProcessedPage,
    RawDocumentData,
    MarginRemovalResult,
    ExtractionError,
    ExtractionErrorCode,
    DEFAULT_EXTRACTION_SETTINGS,
    ExtractedLine,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    DEFAULT_PAGE_IMAGE_OPTIONS,
} from "./types";

// Re-export types and classes for convenience
export * from "./types";
export { MuPDFService, disposeMuPDF } from "./MuPDFService";
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

/**
 * PDFExtractor - High-level API for extracting text from PDFs.
 *
 * Usage:
 * ```typescript
 * const extractor = new PDFExtractor();
 * const result = await extractor.extract(pdfData, { pages: [0, 1, 2] });
 * console.log(result.fullText);
 * ```
 */
export class PDFExtractor {
    private mupdf: MuPDFService;

    constructor() {
        this.mupdf = new MuPDFService();
    }

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

        try {
            // 1. Open the document
            await this.mupdf.open(pdfData);
            const docAnalyzer = new DocumentAnalyzer(this.mupdf);

            // 2. Check text layer if requested
            if (opts.checkTextLayer) {
                const ocrAnalysis = docAnalyzer.getDetailedOCRAnalysis({
                    minTextPerPage: opts.minTextPerPage,
                });

                if (ocrAnalysis.needsOCR) {
                    throw new ExtractionError(
                        ExtractionErrorCode.NO_TEXT_LAYER,
                        `Document may require OCR: ${ocrAnalysis.primaryReason} (${Math.round(ocrAnalysis.issueRatio * 100)}% of sampled pages have issues)`,
                        ocrAnalysis
                    );
                }
            }

            // 3. Determine pages to extract
            const pageCount = docAnalyzer.getPageCount();
            const pageIndices = opts.pages?.length
                ? opts.pages.filter(i => i >= 0 && i < pageCount)
                : undefined; // undefined = all pages

            // 4. EXTRACTION PASS: Get all raw data in one pass
            console.log("[PDFExtractor] Starting extraction pass...");
            const rawData = this.mupdf.extractRawPages(pageIndices);
            console.log(`[PDFExtractor] Extracted ${rawData.pages.length} pages`);

            // 5. DOCUMENT ANALYSIS

            // 5a. Style analysis
            console.log("[PDFExtractor] Analyzing styles...");
            const styleAnalyzer = new StyleAnalyzer();
            const styleProfile = styleAnalyzer.analyze(
                rawData.pages,
                4, // minChars
                0.15, // thresholdPerc
                opts.styleSampleSize
            );
            StyleAnalyzer.logStyleProfile(styleProfile);

            // 5b. Margin analysis (smart filtering - collect elements)
            console.log("[PDFExtractor] Analyzing margins...");
            const marginAnalysis = MarginFilter.collectMarginElements(
                rawData.pages,
                opts.marginZone
            );

            // 5c. Identify repeating elements for smart removal
            console.log("[PDFExtractor] Identifying repeating margin elements...");
            const removalResult = MarginFilter.identifyElementsToRemove(
                marginAnalysis,
                opts.repeatThreshold,
                opts.detectPageSequences
            );
            MarginFilter.logRemovalCandidates(removalResult);

            // 6. PAGE PROCESSING: Process each page with smart filtering and column detection
            console.log("[PDFExtractor] Processing pages with smart margin removal and column detection...");
            const pageExtractor = new PageExtractor({ styleProfile });

            const pages: ProcessedPage[] = rawData.pages.map(rawPage => {
                // Apply smart margin filtering
                const filteredPage = MarginFilter.filterPageWithSmartRemoval(
                    rawPage,
                    opts.margins,
                    opts.marginZone,
                    removalResult
                );

                // Detect columns
                const columnResult = detectColumns(filteredPage);
                logColumnDetection(rawPage.pageIndex, columnResult);

                // Extract page content using column detection for correct reading order
                return pageExtractor.extractPageWithColumns(
                    filteredPage,
                    columnResult,
                    true // include column bboxes in output
                );
            });

            // 7. Combine results
            const fullText = pages.map(p => p.content).join("\n\n");

            const analysis: DocumentAnalysis = {
                pageCount: rawData.pageCount,
                hasTextLayer: true, // We checked earlier
                styleProfile,
                marginAnalysis,
            };

            console.log("[PDFExtractor] Extraction complete!");
            console.log(`[PDFExtractor] Total text length: ${fullText.length} chars`);

            return {
                pages,
                analysis,
                fullText,
                metadata: {
                    extractedAt: new Date().toISOString(),
                    version: "2.0.0",
                    settings: opts,
                },
            };
        } finally {
            this.mupdf.close();
        }
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
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...settings, useLineDetection: true };

        try {
            // 1. Open the document
            await this.mupdf.open(pdfData);
            const docAnalyzer = new DocumentAnalyzer(this.mupdf);

            // 2. Check text layer if requested
            if (opts.checkTextLayer) {
                const ocrAnalysis = docAnalyzer.getDetailedOCRAnalysis({
                    minTextPerPage: opts.minTextPerPage,
                });

                if (ocrAnalysis.needsOCR) {
                    throw new ExtractionError(
                        ExtractionErrorCode.NO_TEXT_LAYER,
                        `Document may require OCR: ${ocrAnalysis.primaryReason} (${Math.round(ocrAnalysis.issueRatio * 100)}% of sampled pages have issues)`,
                        ocrAnalysis
                    );
                }
            }

            // 3. Determine pages to extract
            const pageCount = docAnalyzer.getPageCount();
            const pageIndices = opts.pages?.length
                ? opts.pages.filter(i => i >= 0 && i < pageCount)
                : undefined; // undefined = all pages

            // 4. EXTRACTION PASS: Get all raw data in one pass
            console.log("[PDFExtractor] Starting line-based extraction pass...");
            const rawData = this.mupdf.extractRawPages(pageIndices);
            console.log(`[PDFExtractor] Extracted ${rawData.pages.length} pages`);

            // 5. DOCUMENT ANALYSIS

            // 5a. Style analysis
            console.log("[PDFExtractor] Analyzing styles...");
            const styleAnalyzer = new StyleAnalyzer();
            const styleProfile = styleAnalyzer.analyze(
                rawData.pages,
                4, // minChars
                0.15, // thresholdPerc
                opts.styleSampleSize
            );
            StyleAnalyzer.logStyleProfile(styleProfile);

            // 5b. Margin analysis (smart filtering - collect elements)
            console.log("[PDFExtractor] Analyzing margins...");
            const marginAnalysis = MarginFilter.collectMarginElements(
                rawData.pages,
                opts.marginZone
            );

            // 5c. Identify repeating elements for smart removal
            console.log("[PDFExtractor] Identifying repeating margin elements...");
            const removalResult = MarginFilter.identifyElementsToRemove(
                marginAnalysis,
                opts.repeatThreshold,
                opts.detectPageSequences
            );
            MarginFilter.logRemovalCandidates(removalResult);

            // 6. PAGE PROCESSING: Process each page with line detection
            console.log("[PDFExtractor] Processing pages with line detection...");
            const pages: ProcessedPage[] = [];

            for (const rawPage of rawData.pages) {
                // Apply smart margin filtering
                const filteredPage = MarginFilter.filterPageWithSmartRemoval(
                    rawPage,
                    opts.margins,
                    opts.marginZone,
                    removalResult
                );

                // Detect columns
                const columnResult = detectColumns(filteredPage);
                logColumnDetection(rawPage.pageIndex, columnResult);

                // Detect lines within columns
                const lineResult: PageLineResult = detectLinesOnPage(
                    filteredPage,
                    columnResult.columns
                );
                logLineDetection(lineResult);

                // Convert to ExtractedLine format
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

                // Build page content from lines
                const content = extractedLines.map(line => line.text).join("\n");

                // Create processed page
                const processedPage: ProcessedPage = {
                    index: rawPage.pageIndex,
                    label: rawPage.label,
                    width: rawPage.width,
                    height: rawPage.height,
                    blocks: [], // Not populated for line-based extraction
                    content,
                    columns: columnResult.columns.map(col => ({
                        l: col.x,
                        t: col.y,
                        r: col.x + col.w,
                        b: col.y + col.h,
                    })),
                    lines: extractedLines,
                };

                pages.push(processedPage);
            }

            // 7. Combine results
            const fullText = pages.map(p => p.content).join("\n\n");

            const analysis: DocumentAnalysis = {
                pageCount: rawData.pageCount,
                hasTextLayer: true, // We checked earlier
                styleProfile,
                marginAnalysis,
            };

            console.log("[PDFExtractor] Line-based extraction complete!");
            console.log(`[PDFExtractor] Total text length: ${fullText.length} chars`);

            return {
                pages,
                analysis,
                fullText,
                metadata: {
                    extractedAt: new Date().toISOString(),
                    version: "2.0.0",
                    settings: opts,
                },
            };
        } finally {
            this.mupdf.close();
        }
    }

    /**
     * Check if a PDF has a text layer.
     * Useful for determining if OCR is needed before full extraction.
     */
    async hasTextLayer(pdfData: Uint8Array | ArrayBuffer): Promise<boolean> {
        try {
            await this.mupdf.open(pdfData);
            const analyzer = new DocumentAnalyzer(this.mupdf);
            return analyzer.hasTextLayer();
        } finally {
            this.mupdf.close();
        }
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
        try {
            await this.mupdf.open(pdfData);
            const analyzer = new DocumentAnalyzer(this.mupdf);
            return analyzer.getDetailedOCRAnalysis(options);
        } finally {
            this.mupdf.close();
        }
    }

    /**
     * Get page count without full extraction.
     */
    async getPageCount(pdfData: Uint8Array | ArrayBuffer): Promise<number> {
        try {
            await this.mupdf.open(pdfData);
            return this.mupdf.getPageCount();
        } finally {
            this.mupdf.close();
        }
    }

    /**
     * Get raw document data without processing.
     * Useful for debugging or custom processing.
     */
    async extractRaw(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndices?: number[]
    ): Promise<RawDocumentData> {
        try {
            await this.mupdf.open(pdfData);
            return this.mupdf.extractRawPages(pageIndices);
        } finally {
            this.mupdf.close();
        }
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
        try {
            await this.mupdf.open(pdfData);
            return this.mupdf.renderPageToImage(pageIndex, options);
        } finally {
            this.mupdf.close();
        }
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
        try {
            await this.mupdf.open(pdfData);
            return this.mupdf.renderPagesToImages(pageIndices, options);
        } finally {
            this.mupdf.close();
        }
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
