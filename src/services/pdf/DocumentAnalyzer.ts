/**
 * Document Analyzer
 *
 * Performs document-wide analysis including:
 * - Text layer detection (OCR check)
 * - Text quality analysis
 * - Bounding box validation
 * - Image coverage detection
 */

import type { MuPDFService } from "./MuPDFService";
import type {
    RawPageData,
    RawBlock,
    RawBBox,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageOCRAnalysis,
    OCRIssueReason,
} from "./types";
import { DEFAULT_OCR_DETECTION_OPTIONS, bboxToTuple } from "./types";

/** Legacy options interface for backward compatibility */
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

// ============================================================================
// Text Quality Analysis
// ============================================================================

/**
 * Analyze text quality to detect garbled or poorly extracted text.
 * Returns issues found with the text content.
 */
function analyzeTextQuality(
    text: string,
    opts: Required<OCRDetectionOptions>
): OCRIssueReason[] {
    const issues: OCRIssueReason[] = [];

    if (!text || text.length === 0) {
        issues.push("insufficient_text");
        return issues;
    }

    const totalChars = text.length;
    const strippedText = text.replace(/\s/g, "");
    const contentChars = strippedText.length;

    // Check whitespace ratio (too much spacing suggests garbled text)
    const whitespaceCount = totalChars - contentChars;
    const whitespaceRatio = whitespaceCount / totalChars;
    if (whitespaceRatio > opts.maxWhitespaceRatio) {
        issues.push("high_whitespace_ratio");
    }

    // Check newline ratio (excessive newlines suggest extraction issues)
    const newlineMatches = text.match(/\n/g);
    const newlineCount = newlineMatches ? newlineMatches.length : 0;
    const nonNewlineCount = totalChars - newlineCount;
    if (nonNewlineCount > 0) {
        const newlineRatio = newlineCount / totalChars;
        if (newlineRatio > opts.maxNewlineRatio) {
            issues.push("high_newline_ratio");
        }
    }

    // Check alphanumeric ratio (low ratio suggests garbled/symbol-heavy text)
    const alphanumMatches = strippedText.match(/[a-zA-Z0-9]/g);
    const alphanumCount = alphanumMatches ? alphanumMatches.length : 0;
    if (contentChars > 0) {
        const alphanumRatio = alphanumCount / contentChars;
        if (alphanumRatio < opts.minAlphanumericRatio) {
            issues.push("low_alphanumeric_ratio");
        }
    }

    // Check for replacement/invalid characters
    // Only flag if: (1) invalid ratio is high AND (2) valid text is insufficient
    // This allows pages with lots of valid text to pass even if they have some garbled sections
    const invalidChars = ["\uFFFD", "�", "\u0000"];
    let invalidCount = 0;
    for (const char of text) {
        if (invalidChars.includes(char)) {
            invalidCount++;
        }
    }

    if (invalidCount > 0 && contentChars > 0) {
        const invalidRatio = invalidCount / contentChars;
        const validChars = contentChars - invalidCount;

        // Only flag if both conditions are met:
        // 1. High ratio of invalid characters (above threshold, default 30%)
        // 2. Not enough valid characters to be useful (below threshold, default 1000)
        if (invalidRatio > opts.maxInvalidCharRatio && validChars < opts.minValidCharsToAccept) {
            issues.push("invalid_characters");
        }
    }

    return issues;
}

// ============================================================================
// Bounding Box Validation
// ============================================================================

/**
 * Calculate area of a bounding box from tuple [x0, y0, x1, y1]
 */
function calculateBBoxArea(bbox: [number, number, number, number]): number {
    const width = bbox[2] - bbox[0];
    const height = bbox[3] - bbox[1];
    return Math.max(0, width) * Math.max(0, height);
}

/**
 * Calculate intersection area between two bounding boxes (tuple format)
 */
function calculateIntersectionArea(
    bbox1: [number, number, number, number],
    bbox2: [number, number, number, number]
): number {
    const x0 = Math.max(bbox1[0], bbox2[0]);
    const y0 = Math.max(bbox1[1], bbox2[1]);
    const x1 = Math.min(bbox1[2], bbox2[2]);
    const y1 = Math.min(bbox1[3], bbox2[3]);

    if (x1 <= x0 || y1 <= y0) {
        return 0;
    }

    return (x1 - x0) * (y1 - y0);
}

/**
 * Validate bounding boxes on a page for extraction quality issues.
 * Checks for:
 * - Lines overflowing page boundaries
 * - Excessive overlapping between text lines
 */
function validateBoundingBoxes(
    lineBBoxes: RawBBox[],
    pageWidth: number,
    pageHeight: number,
    opts: Required<OCRDetectionOptions>
): OCRIssueReason[] {
    const issues: OCRIssueReason[] = [];

    if (lineBBoxes.length === 0) {
        return issues;
    }

    // Page bounds with margin tolerance
    const margin = opts.boundaryMargin;
    const pageBounds: [number, number, number, number] = [
        -margin,
        -margin,
        pageWidth + margin,
        pageHeight + margin,
    ];

    // Convert all line bboxes to tuple format
    const lineTuples = lineBBoxes.map(bboxToTuple);

    // Check for boundary overflow
    let overflowCount = 0;
    for (const lineBBox of lineTuples) {
        if (
            lineBBox[0] < pageBounds[0] ||
            lineBBox[1] < pageBounds[1] ||
            lineBBox[2] > pageBounds[2] ||
            lineBBox[3] > pageBounds[3]
        ) {
            overflowCount++;
        }
    }
    // If more than 10% of lines overflow, flag it
    if (overflowCount > lineTuples.length * 0.1) {
        issues.push("bbox_overflow");
    }

    // Check for excessive line overlaps (suggests misformatted extraction)
    let excessiveOverlapCount = 0;
    for (let i = 0; i < lineTuples.length; i++) {
        const bbox1 = lineTuples[i];
        const area1 = calculateBBoxArea(bbox1);

        if (area1 === 0) continue;

        let overlapCount = 0;
        for (let j = 0; j < lineTuples.length; j++) {
            if (i === j) continue;

            const intersectionArea = calculateIntersectionArea(bbox1, lineTuples[j]);
            const overlapRatio = intersectionArea / area1;

            if (overlapRatio > opts.maxLineOverlapRatio) {
                overlapCount++;
            }
        }

        // More than 2 significant overlaps for a single line is problematic
        if (overlapCount > 2) {
            excessiveOverlapCount++;
        }
    }

    // If more than 5% of lines have excessive overlaps
    if (excessiveOverlapCount > lineTuples.length * 0.05) {
        issues.push("excessive_line_overlap");
    }

    return issues;
}

// ============================================================================
// Image Coverage Detection
// ============================================================================

/**
 * Check if a page is dominated by large images (likely a scan).
 */
function checkImageCoverage(
    imageBlocks: RawBlock[],
    pageWidth: number,
    pageHeight: number,
    opts: Required<OCRDetectionOptions>
): boolean {
    const pageArea = pageWidth * pageHeight;
    if (pageArea === 0) return false;

    for (const block of imageBlocks) {
        if (block.type === "image" && block.bbox) {
            const imageArea = block.bbox.w * block.bbox.h;
            const coverageRatio = imageArea / pageArea;

            if (coverageRatio >= opts.imageCoverageThreshold) {
                return true;
            }
        }
    }

    return false;
}

// ============================================================================
// Page-Level Analysis
// ============================================================================

/**
 * Analyze a single page for OCR-related issues.
 *
 * Key design decisions:
 * - Large image coverage alone is NOT sufficient to flag a page as needing OCR.
 *   A scanned document that was previously OCR'd will have both large images AND
 *   a valid text layer. We only flag large_image_coverage when combined with
 *   insufficient or missing text.
 * - Bounding box checks (overflow, overlap) are optional and disabled by default.
 *   They're useful for word-level positioning accuracy but not for page-level
 *   text extraction.
 */
function analyzePage(
    rawPage: RawPageData,
    opts: Required<OCRDetectionOptions>
): PageOCRAnalysis {
    const issues: OCRIssueReason[] = [];

    const textBlocks = rawPage.blocks.filter((b) => b.type === "text");
    const imageBlocks = rawPage.blocks.filter((b) => b.type === "image");
    const hasImages = imageBlocks.length > 0;
    const hasLargeImage = checkImageCoverage(imageBlocks, rawPage.width, rawPage.height, opts);

    // Check 1: No text blocks at all
    if (textBlocks.length === 0) {
        issues.push("no_text_blocks");
        // Only flag large_image_coverage if there's actually a large image AND no text
        // This indicates a scanned page without OCR
        if (hasLargeImage) {
            issues.push("large_image_coverage");
        }
        return {
            pageIndex: rawPage.pageIndex,
            hasIssues: true,
            issues,
            textLength: 0,
            hasImages,
        };
    }

    // Collect all text and line bounding boxes
    let pageText = "";
    const lineBBoxes: RawBBox[] = [];

    for (const block of textBlocks) {
        if (block.lines) {
            for (const line of block.lines) {
                if (line.text) {
                    pageText += line.text + "\n";
                }
                if (line.bbox) {
                    lineBBoxes.push(line.bbox);
                }
            }
        }
    }

    const textLength = pageText.replace(/\s+/g, "").length;

    // Check 2: Insufficient text combined with large image
    // This catches scanned pages that weren't OCR'd properly
    // Note: A page with large images but sufficient good text is likely already OCR'd
    if (textLength < opts.minTextPerPage && hasLargeImage) {
        issues.push("insufficient_text");
        issues.push("large_image_coverage");
    }

    // Check 3: Text quality analysis (applies regardless of images)
    if (textLength > 0) {
        const textQualityIssues = analyzeTextQuality(pageText, opts);
        issues.push(...textQualityIssues);
    }

    // Check 4: Bounding box validation (optional - for word-level accuracy)
    // Disabled by default since most users need page-level text extraction
    if (opts.checkBoundingBoxes && lineBBoxes.length > 0) {
        const bboxIssues = validateBoundingBoxes(
            lineBBoxes,
            rawPage.width,
            rawPage.height,
            opts
        );
        issues.push(...bboxIssues);
    }

    return {
        pageIndex: rawPage.pageIndex,
        hasIssues: issues.length > 0,
        issues,
        textLength,
        hasImages,
    };
}

// ============================================================================
// Document Analyzer Class
// ============================================================================

/**
 * Document Analyzer class for document-wide analysis.
 */
export class DocumentAnalyzer {
    constructor(private mupdf: MuPDFService) {}

    /**
     * Perform detailed OCR detection analysis.
     * Samples pages and analyzes text quality, bounding boxes, and image coverage.
     *
     * @param options - Detection options
     * @returns Detailed analysis result
     */
    analyzeOCRNeeds(options: OCRDetectionOptions = {}): OCRDetectionResult {
        const opts = { ...DEFAULT_OCR_DETECTION_OPTIONS, ...options };
        const pageCount = this.mupdf.getPageCount();

        // Skip first page if document is long enough (often has publisher text)
        const startPage = pageCount > 3 ? 1 : 0;
        const availablePages = pageCount - startPage;

        // Determine initial sample size
        const initialSampleSize = Math.min(availablePages, opts.sampleSize);

        // Analyze initial sample
        const pageAnalyses: PageOCRAnalysis[] = [];
        const issueBreakdown: Record<OCRIssueReason, number> = {
            no_text_blocks: 0,
            insufficient_text: 0,
            high_whitespace_ratio: 0,
            high_newline_ratio: 0,
            low_alphanumeric_ratio: 0,
            invalid_characters: 0,
            large_image_coverage: 0,
            bbox_overflow: 0,
            excessive_line_overlap: 0,
        };

        for (let i = startPage; i < startPage + initialSampleSize; i++) {
            const rawPage = this.mupdf.extractRawPage(i, { includeImages: true });
            const analysis = analyzePage(rawPage, opts);
            pageAnalyses.push(analysis);

            for (const issue of analysis.issues) {
                issueBreakdown[issue]++;
            }
        }

        // Calculate initial issue ratio
        const issuesCount = pageAnalyses.filter((p) => p.hasIssues).length;
        let issueRatio = initialSampleSize > 0 ? issuesCount / initialSampleSize : 0;

        // Expand sample if we're in the "uncertain zone"
        // - Below lower threshold (e.g., <10%): Clearly OK, no expansion needed
        // - Between thresholds (e.g., 10-80%): Uncertain, expand to confirm
        // - Above upper threshold (e.g., >80%): Clearly bad, no expansion needed
        const isInUncertainZone =
            issueRatio >= opts.expandLowerThreshold &&
            issueRatio < opts.expandUpperThreshold;

        if (isInUncertainZone && availablePages > initialSampleSize) {
            const expandedSampleSize = Math.min(availablePages, opts.expandedSampleSize);

                for (let i = startPage + initialSampleSize; i < startPage + expandedSampleSize; i++) {
                const rawPage = this.mupdf.extractRawPage(i, { includeImages: true });
                const analysis = analyzePage(rawPage, opts);
                pageAnalyses.push(analysis);

                for (const issue of analysis.issues) {
                    issueBreakdown[issue]++;
                }
            }

            // Recalculate ratio with expanded sample
            const totalIssues = pageAnalyses.filter((p) => p.hasIssues).length;
            issueRatio = pageAnalyses.length > 0 ? totalIssues / pageAnalyses.length : 0;
        }

        // Determine if OCR is needed
        const needsOCR = issueRatio >= opts.confirmationThreshold;

        // Determine primary reason
        let primaryReason = "text_extraction_acceptable";
        if (needsOCR) {
            // Find the most common issue
            const sortedIssues = Object.entries(issueBreakdown)
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1]);

            if (sortedIssues.length > 0) {
                const topIssue = sortedIssues[0][0] as OCRIssueReason;
                // Check if this looks like a scanned document without OCR
                // (large_image_coverage is now only flagged with text problems)
                const hasLargeImages = issueBreakdown.large_image_coverage > 0;
                const hasTextProblems = issueBreakdown.no_text_blocks > 0 ||
                    issueBreakdown.insufficient_text > 0;

                if (hasLargeImages && hasTextProblems) {
                    primaryReason = "scanned_without_ocr";
                } else {
                    switch (topIssue) {
                        case "no_text_blocks":
                        case "insufficient_text":
                            primaryReason = "missing_text_content";
                            break;
                        case "large_image_coverage":
                            // This shouldn't happen anymore since we combine with text issues
                            primaryReason = "scanned_without_ocr";
                            break;
                        case "high_whitespace_ratio":
                        case "high_newline_ratio":
                        case "low_alphanumeric_ratio":
                        case "invalid_characters":
                            primaryReason = "poor_text_quality";
                            break;
                        case "bbox_overflow":
                        case "excessive_line_overlap":
                            primaryReason = "extraction_formatting_issues";
                            break;
                    }
                }
            } else {
                primaryReason = "quality_threshold_exceeded";
            }
        }

        return {
            needsOCR,
            primaryReason,
            issueRatio,
            issueBreakdown,
            pageAnalyses,
            totalPages: pageCount,
            sampledPages: pageAnalyses.length,
        };
    }

    /**
     * Check if a PDF document lacks a text layer (likely needs OCR).
     * Samples pages and uses multiple heuristics to detect scan-like documents.
     *
     * This is the main entry point for OCR detection.
     *
     * @param options - Detection options (supports both legacy and new options)
     * @returns true if document likely needs OCR
     */
    hasNoTextLayer(options: TextLayerCheckOptions | OCRDetectionOptions = {}): boolean {
        // Map legacy options to new format
        const mappedOptions: OCRDetectionOptions = {
            minTextPerPage: options.minTextPerPage,
            sampleSize: (options as TextLayerCheckOptions).sampleLimit ??
                (options as OCRDetectionOptions).sampleSize,
            expandedSampleSize: (options as TextLayerCheckOptions).expandSampleLimit ??
                (options as OCRDetectionOptions).expandedSampleSize,
            // Legacy scanThreshold maps to expandUpperThreshold (old behavior)
            expandUpperThreshold: (options as TextLayerCheckOptions).scanThreshold ??
                (options as OCRDetectionOptions).expandUpperThreshold,
            expandLowerThreshold: (options as OCRDetectionOptions).expandLowerThreshold,
            confirmationThreshold: (options as TextLayerCheckOptions).confirmationThreshold ??
                (options as OCRDetectionOptions).confirmationThreshold,
        };

        // Pass through new-format options
        if ("maxWhitespaceRatio" in options) {
            Object.assign(mappedOptions, {
                maxWhitespaceRatio: options.maxWhitespaceRatio,
                maxNewlineRatio: options.maxNewlineRatio,
                minAlphanumericRatio: options.minAlphanumericRatio,
                maxInvalidCharRatio: options.maxInvalidCharRatio,
                minValidCharsToAccept: options.minValidCharsToAccept,
                imageCoverageThreshold: options.imageCoverageThreshold,
                maxLineOverlapRatio: options.maxLineOverlapRatio,
                boundaryMargin: options.boundaryMargin,
                checkBoundingBoxes: options.checkBoundingBoxes,
            });
        }

        const result = this.analyzeOCRNeeds(mappedOptions);
        return result.needsOCR;
    }

    /**
     * Get the page count of the document.
     */
    getPageCount(): number {
        return this.mupdf.getPageCount();
    }

    /**
     * Quick check: Does the document have a text layer?
     *
     * @param options - Detection options
     * @returns true if document has usable text layer
     */
    hasTextLayer(options: TextLayerCheckOptions | OCRDetectionOptions = {}): boolean {
        return !this.hasNoTextLayer(options);
    }

    /**
     * Get detailed OCR detection result.
     * Useful for debugging or displaying detailed information about why
     * a document needs OCR.
     *
     * @param options - Detection options
     * @returns Detailed analysis result
     */
    getDetailedOCRAnalysis(options: OCRDetectionOptions = {}): OCRDetectionResult {
        return this.analyzeOCRNeeds(options);
    }
}
