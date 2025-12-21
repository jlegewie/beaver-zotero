/**
 * Document Analyzer
 *
 * Performs document-wide analysis including:
 * - Text layer detection (OCR check)
 * - Header/footer detection
 * - Cross-page pattern recognition
 */

import type { MuPDFService } from "./MuPDFService";
import type { DocumentAnalysis, RepeatedElement, StyleProfile, RawBlock } from "./types";

/** Options for text layer detection */
export interface TextLayerCheckOptions {
    /** Minimum text per page to consider it has a text layer */
    minTextPerPage?: number;
    /** Initial number of pages to sample */
    sampleLimit?: number;
    /** Expanded sample size for confirmation */
    expandSampleLimit?: number;
    /** Threshold to trigger expanded sampling */
    scanThreshold?: number;
    /** Final threshold to confirm no text layer */
    confirmationThreshold?: number;
}

const DEFAULT_TEXT_LAYER_OPTIONS: Required<TextLayerCheckOptions> = {
    minTextPerPage: 100,
    sampleLimit: 6,
    expandSampleLimit: 20,
    scanThreshold: 0.8,
    confirmationThreshold: 0.9,
};

/**
 * Document Analyzer class for document-wide analysis.
 */
export class DocumentAnalyzer {
    constructor(private mupdf: MuPDFService) {}

    /**
     * Check if a PDF document lacks a text layer (likely needs OCR).
     * Samples pages to find the percentage that look like scans.
     */
    hasNoTextLayer(options: TextLayerCheckOptions = {}): boolean {
        const opts = { ...DEFAULT_TEXT_LAYER_OPTIONS, ...options };
        const pageCount = this.mupdf.getPageCount();

        // Skip first page if document is long enough (often has publisher text)
        const startPage = pageCount > 3 ? 1 : 0;

        const isScanLikePage = (pageIdx: number): boolean => {
            const rawPage = this.mupdf.extractRawPage(pageIdx);
            let textLength = 0;
            let hasImages = false;

            for (const block of rawPage.blocks) {
                if (block.type === "text") {
                    for (const line of block.lines || []) {
                        textLength += (line.text || "").length;
                    }
                } else if (block.type === "image") {
                    hasImages = true;
                }
            }

            return textLength < opts.minTextPerPage && hasImages;
        };

        // Initial sample
        const initialSampleSize = Math.min(pageCount - startPage, opts.sampleLimit);
        let scanLikeCount = 0;

        for (let i = startPage; i < startPage + initialSampleSize; i++) {
            if (isScanLikePage(i)) {
                scanLikeCount++;
            }
        }

        let scanPercentage = initialSampleSize > 0 ? scanLikeCount / initialSampleSize : 0;

        // Expand sample if threshold is met
        if (scanPercentage >= opts.scanThreshold && pageCount > initialSampleSize) {
            const expandedSampleSize = Math.min(pageCount - startPage, opts.expandSampleLimit);

            if (expandedSampleSize > initialSampleSize) {
                for (let i = startPage + initialSampleSize; i < startPage + expandedSampleSize; i++) {
                    if (isScanLikePage(i)) {
                        scanLikeCount++;
                    }
                }
                scanPercentage = scanLikeCount / expandedSampleSize;
            }
        }

        return scanPercentage >= opts.confirmationThreshold;
    }

    /**
     * Detect repeated elements (headers/footers) across pages.
     * TODO: Implement cross-page pattern matching
     */
    detectRepeatedElements(): RepeatedElement[] {
        // Placeholder - will implement header/footer detection
        return [];
    }

    /**
     * Build a style profile from the document.
     * TODO: Implement font frequency analysis
     */
    buildStyleProfile(): StyleProfile {
        // Placeholder - will implement style analysis
        return {
            bodyFontSize: 12,
            headingFontSizes: [],
            primaryFont: "unknown",
            fonts: new Map(),
        };
    }

    /**
     * Perform full document analysis.
     */
    analyze(checkTextLayer = true): DocumentAnalysis {
        const pageCount = this.mupdf.getPageCount();
        const hasTextLayer = checkTextLayer ? !this.hasNoTextLayer() : true;

        return {
            pageCount,
            hasTextLayer,
            repeatedElements: this.detectRepeatedElements(),
            styleProfile: this.buildStyleProfile(),
        };
    }
}

