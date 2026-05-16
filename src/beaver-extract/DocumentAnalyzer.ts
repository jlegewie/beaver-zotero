/**
 * Document Analyzer
 *
 * Performs document-wide analysis including:
 * - Text layer detection (OCR check)
 * - Text quality analysis
 * - Bounding box validation
 * - Image coverage detection
 */

import type {
    BoundingBox,
    RawPageData,
    RawBlock,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageOCRAnalysis,
    OCRIssueReason,
} from "./types";
import { DEFAULT_OCR_DETECTION_OPTIONS, bboxToTuple } from "./types";
import { bboxHeight, bboxWidth } from "./types";
import { isRecoverablePageError } from "./wasmFatal";

/**
 * Minimal interface that DocumentAnalyzer needs — implemented by a
 * worker-side adapter that wraps an open `Document`. Decouples the analyzer
 * from the MuPDF lifecycle so the same code can be reused outside the
 * worker (e.g. against a pre-extracted `RawDocumentData`) without dragging
 * in the MuPDF/WASM stack.
 */
export interface RawPageProvider {
    getPageCount(): number;
    extractRawPage(pageIndex: number, options?: { includeImages?: boolean }): RawPageData;
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

    // Check alphanumeric ratio (low ratio suggests garbled/symbol-heavy text).
    // Unicode-aware: \p{L} matches letters in any script (Latin, Cyrillic,
    // Greek, Arabic, CJK, etc.) and \p{N} matches any number character.
    //
    // Before taking the ratio, collapse runs of 4+ identical non-alphanumeric
    // characters down to one. Long runs of a single punctuation mark are layout
    // artifacts — table-of-contents / index dot leaders, underline rules — not
    // linguistic content; counting every leader dot as a non-alphanumeric
    // character sinks the ratio of perfectly readable pages well below the
    // threshold. Genuinely garbled extraction interleaves many distinct
    // codepoints (replacement characters, controls, per-glyph private-use
    // codepoints) and never forms such runs, so this collapse does not weaken
    // detection of unmapped-glyph pages.
    const leaderCollapsed = strippedText.replace(/([^\p{L}\p{N}])\1{3,}/gu, "$1");
    const alphanumMatches = leaderCollapsed.match(/[\p{L}\p{N}]/gu);
    const alphanumCount = alphanumMatches ? alphanumMatches.length : 0;
    const ratioChars = leaderCollapsed.length;
    if (ratioChars > 0) {
        const alphanumRatio = alphanumCount / ratioChars;
        // Flag only when BOTH hold: the ratio is below threshold AND the page
        // lacks enough real alphanumeric content to stand on its own. The
        // absolute-volume guard mirrors the invalid-character check below and
        // keeps legitimate symbol-dense pages — dense mathematics, equation-
        // heavy papers, formula appendices — out of the garbled bucket.
        if (
            alphanumRatio < opts.minAlphanumericRatio &&
            alphanumCount < opts.minValidCharsToAccept
        ) {
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
    lineBBoxes: BoundingBox[],
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
            const imageArea = bboxWidth(block.bbox) * bboxHeight(block.bbox);
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
    const lineBBoxes: BoundingBox[] = [];

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

/**
 * Pick `count` page indices spread evenly across the range
 * `[startPage, startPage + availablePages)`.
 *
 * Sampling the whole document — rather than a contiguous block from the front —
 * keeps the OCR detector from judging a long scanned book by its front matter
 * alone. Front matter (bookplate, blanks, half-title, title page, copyright,
 * table of contents) genuinely has little or no text even when the OCR'd body
 * does not; sampling only those pages misclassifies the whole book as
 * `scanned_without_ocr`.
 *
 * For documents short enough that `count >= availablePages` every available
 * page is returned, so behavior is unchanged for small documents. The returned
 * indices are strictly increasing with no duplicates (the step is always >= 1).
 */
function spreadPageIndices(
    startPage: number,
    availablePages: number,
    count: number,
): number[] {
    const n = Math.min(count, availablePages);
    if (n <= 0) return [];
    const step = availablePages / n;
    const indices: number[] = [];
    for (let k = 0; k < n; k++) {
        indices.push(startPage + Math.floor(k * step));
    }
    return indices;
}

// ============================================================================
// Document Analyzer Class
// ============================================================================

/**
 * Document Analyzer class for document-wide analysis.
 */
export class DocumentAnalyzer {
    constructor(private mupdf: RawPageProvider) {}

    /**
     * Sample one page for OCR analysis, pushing its `PageOCRAnalysis` onto
     * `pageAnalyses` and folding its issues into `issueBreakdown`.
     *
     * Returns `false` (leaving both collections untouched) when the page is an
     * unresolvable leaf of a malformed page tree — such pages are skipped so
     * one bad leaf does not abort detection. Genuine extraction failures and
     * WASM traps still propagate.
     */
    private tryAnalyzeOcrPage(
        pageIndex: number,
        opts: Required<OCRDetectionOptions>,
        pageAnalyses: PageOCRAnalysis[],
        issueBreakdown: Record<OCRIssueReason, number>,
    ): boolean {
        let rawPage: RawPageData;
        try {
            rawPage = this.mupdf.extractRawPage(pageIndex, { includeImages: true });
        } catch (err) {
            if (!isRecoverablePageError(err)) throw err;
            return false;
        }
        const analysis = analyzePage(rawPage, opts);
        pageAnalyses.push(analysis);
        for (const issue of analysis.issues) {
            issueBreakdown[issue]++;
        }
        return true;
    }

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

        // Build the evenly-spread page grid for the largest sample we might
        // take. The initial sample is a spread subset of this grid and the
        // expansion fills in the remaining grid pages, so the total sample
        // never exceeds `expandedSampleSize`.
        const sampleGrid = spreadPageIndices(
            startPage,
            availablePages,
            Math.min(availablePages, opts.expandedSampleSize),
        );
        const initialSampleSize = Math.min(sampleGrid.length, opts.sampleSize);

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

        // The initial sample is a spread subset of the grid, so front matter
        // cannot dominate the verdict and the expansion stays a strict superset.
        const initialPages = spreadPageIndices(0, sampleGrid.length, initialSampleSize)
            .map((pos) => sampleGrid[pos]);

        // A malformed page tree can fail to resolve a sampled leaf;
        // `tryAnalyzeOcrPage` drops those rather than aborting detection.
        for (const pageIndex of initialPages) {
            this.tryAnalyzeOcrPage(pageIndex, opts, pageAnalyses, issueBreakdown);
        }

        // Calculate initial issue ratio
        const issuesCount = pageAnalyses.filter((p) => p.hasIssues).length;
        let issueRatio = pageAnalyses.length > 0 ? issuesCount / pageAnalyses.length : 0;

        // Expand sample if we're in the "uncertain zone"
        // - Below lower threshold (e.g., <10%): Clearly OK, no expansion needed
        // - Between thresholds (e.g., 10-80%): Uncertain, expand to confirm
        // - Above upper threshold (e.g., >80%): Clearly bad, no expansion needed
        const isInUncertainZone =
            issueRatio >= opts.expandLowerThreshold &&
            issueRatio < opts.expandUpperThreshold;

        if (isInUncertainZone && sampleGrid.length > initialPages.length) {
            // Fill in the remaining grid pages not covered by the initial
            // sample. The total then equals `expandedSampleSize` exactly.
            const alreadySampled = new Set(initialPages);

            for (const pageIndex of sampleGrid) {
                if (alreadySampled.has(pageIndex)) continue;
                this.tryAnalyzeOcrPage(pageIndex, opts, pageAnalyses, issueBreakdown);
            }

            // Recalculate ratio with expanded sample
            const totalIssues = pageAnalyses.filter((p) => p.hasIssues).length;
            issueRatio = pageAnalyses.length > 0 ? totalIssues / pageAnalyses.length : 0;
        }

        // Fallback sweep: if page-tree corruption left the spread sample short
        // of `initialSampleSize` resolvable pages, walk the remaining pages for
        // any resolvable leaf. Without this, an all-skipped sample collapses
        // `issueRatio` to 0 and a scanned/image-only document whose sampled
        // leaves happen to be unresolvable would silently bypass the
        // NO_TEXT_LAYER guard. Only runs for malformed documents — a normal
        // sample already fills, so the loop body is never entered.
        if (pageAnalyses.length < initialSampleSize) {
            const sampled = new Set(pageAnalyses.map((p) => p.pageIndex));
            for (let pageIndex = startPage; pageIndex < pageCount; pageIndex++) {
                if (pageAnalyses.length >= initialSampleSize) break;
                if (sampled.has(pageIndex)) continue;
                this.tryAnalyzeOcrPage(pageIndex, opts, pageAnalyses, issueBreakdown);
            }
            const totalIssues = pageAnalyses.filter((p) => p.hasIssues).length;
            issueRatio = pageAnalyses.length > 0 ? totalIssues / pageAnalyses.length : 0;
        }

        if (pageAnalyses.length === 0) {
            // Not a single page of the document could be resolved — there is
            // nothing to base an OCR verdict on, and extraction itself cannot
            // proceed either. Surface the failure instead of defaulting
            // `issueRatio` to 0 and reporting the text layer as acceptable.
            throw new Error(
                "OCR detection could not resolve any page of the document (malformed page tree)",
            );
        }

        // Keep the per-page analyses in document order for a deterministic
        // result (the expanded sample is interleaved with the initial one).
        pageAnalyses.sort((a, b) => a.pageIndex - b.pageIndex);

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
     * Get the page count of the document.
     */
    getPageCount(): number {
        return this.mupdf.getPageCount();
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
