/**
 * PDF Extraction Service
 *
 * Main entry point for PDF text extraction.
 * Orchestrates the extraction pipeline:
 *   1. Open document with MuPDFService
 *   2. Analyze document structure with DocumentAnalyzer
 *   3. Build style profile with StyleAnalyzer
 *   4. Extract pages with PageExtractor
 *   5. Combine results
 */

import { MuPDFService, disposeMuPDF } from "./MuPDFService";
import { DocumentAnalyzer } from "./DocumentAnalyzer";
import { StyleAnalyzer } from "./StyleAnalyzer";
import { PageExtractor } from "./PageExtractor";
import {
    ExtractionSettings,
    ExtractionResult,
    ProcessedPage,
    ExtractionError,
    ExtractionErrorCode,
    DEFAULT_EXTRACTION_SETTINGS,
} from "./types";

// Re-export types for convenience
export * from "./types";
export { MuPDFService, disposeMuPDF } from "./MuPDFService";
export { DocumentAnalyzer } from "./DocumentAnalyzer";
export { StyleAnalyzer } from "./StyleAnalyzer";
export { PageExtractor } from "./PageExtractor";

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
    private analyzer: DocumentAnalyzer | null = null;
    private styleAnalyzer: StyleAnalyzer;
    private pageExtractor: PageExtractor;

    constructor() {
        this.mupdf = new MuPDFService();
        this.styleAnalyzer = new StyleAnalyzer();
        this.pageExtractor = new PageExtractor();
    }

    /**
     * Extract text from a PDF file.
     *
     * @param pdfData - The PDF file as Uint8Array or ArrayBuffer
     * @param settings - Extraction settings
     * @returns Extraction result with pages, analysis, and full text
     */
    async extract(
        pdfData: Uint8Array | ArrayBuffer,
        settings: ExtractionSettings = {}
    ): Promise<ExtractionResult> {
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS, ...settings };

        try {
            // 1. Open the document
            await this.mupdf.open(pdfData);
            this.analyzer = new DocumentAnalyzer(this.mupdf);

            // 2. Analyze the document
            const analysis = this.analyzer.analyze(opts.checkTextLayer);

            if (opts.checkTextLayer && !analysis.hasTextLayer) {
                throw new ExtractionError(
                    ExtractionErrorCode.NO_TEXT_LAYER,
                    "Document has no text layer and may require OCR"
                );
            }

            // 3. Determine pages to extract
            const pageCount = analysis.pageCount;
            const pageIndices = opts.pages?.length
                ? opts.pages.filter(i => i >= 0 && i < pageCount)
                : Array.from({ length: pageCount }, (_, i) => i);

            // 4. First pass: collect raw pages for style analysis
            const rawPages = this.mupdf.extractRawPages(pageIndices);
            this.styleAnalyzer.reset();
            this.styleAnalyzer.addPages(rawPages);
            const styleProfile = this.styleAnalyzer.buildProfile();

            // Update analysis with computed style profile
            analysis.styleProfile = styleProfile;

            // 5. Configure page extractor
            if (opts.removeRepeatedElements) {
                this.pageExtractor.setRepeatedElements(analysis.repeatedElements);
            }
            this.pageExtractor.setStyleProfile(styleProfile);

            // 6. Process each page
            const pages: ProcessedPage[] = [];
            for (let i = 0; i < rawPages.length; i++) {
                const pageIndex = pageIndices[i];
                const bounds = this.mupdf.getPageBounds(pageIndex);
                const label = this.mupdf.getPageLabel(pageIndex);

                const processed = this.pageExtractor.extractPage(
                    rawPages[i],
                    pageIndex,
                    bounds.width,
                    bounds.height,
                    label
                );
                pages.push(processed);
            }

            // 7. Combine full text
            const fullText = pages.map(p => p.content).join("\n\n");

            return {
                pages,
                analysis,
                fullText,
                metadata: {
                    extractedAt: new Date().toISOString(),
                    version: "1.0.0",
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
     * Check if a PDF has a text layer.
     * Useful for determining if OCR is needed before full extraction.
     */
    async hasTextLayer(pdfData: Uint8Array | ArrayBuffer): Promise<boolean> {
        try {
            await this.mupdf.open(pdfData);
            const analyzer = new DocumentAnalyzer(this.mupdf);
            return !analyzer.hasNoTextLayer();
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

