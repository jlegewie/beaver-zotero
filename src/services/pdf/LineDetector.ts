/**
 * Line Detector
 *
 * Detects lines of text within columns for sophisticated item extraction.
 * This is the first step in the item detection pipeline:
 *   1. Line Detection (this module)
 *   2. Paragraph Detection (future)
 *   3. Item Classification (future)
 *
 * The algorithm:
 *   1. Extract spans within each column
 *   2. Convert bboxes to BoundingBox objects
 *   3. Sort spans spatially (top to bottom, left to right)
 *   4. Calculate adaptive tolerance based on font size
 *   5. Group spans into lines using vertical proximity
 *   6. Split lines with large horizontal gaps
 *   7. Convert to PageLine objects
 *   8. Merge overlapping lines (handles drop caps, subscripts, etc.)
 */

import type { RawPageData, RawBlock, RawLine, RawBBox } from "./types";
import type { Rect } from "./ColumnDetector";

// ============================================================================
// Types
// ============================================================================

/**
 * Bounding box in l/t/r/b format (more convenient for overlap calculations)
 */
export interface LineBBox {
    /** Left edge */
    l: number;
    /** Top edge */
    t: number;
    /** Right edge */
    r: number;
    /** Bottom edge */
    b: number;
    /** Width */
    width: number;
    /** Height */
    height: number;
}

/**
 * A span of text with consistent styling
 */
export interface DetectedSpan {
    /** Text content */
    text: string;
    /** Original bbox in x/y/w/h format */
    bbox: RawBBox;
    /** Converted bbox in l/t/r/b format */
    lineBBox: LineBBox;
    /** Font size */
    size?: number;
    /** Font name */
    fontName?: string;
    /** Font weight */
    fontWeight?: string;
    /** Font style */
    fontStyle?: string;
}

/**
 * A detected line of text
 */
export interface PageLine {
    /** All spans in this line (sorted left to right) */
    spans: DetectedSpan[];
    /** Individual span bboxes */
    bboxes: LineBBox[];
    /** Merged line bbox (union of all spans) */
    bbox: LineBBox;
    /** Concatenated text content */
    text: string;
    /** Median font size of spans */
    fontSize?: number;
}

/**
 * Result of line detection for a column
 */
export interface ColumnLineResult {
    /** Column rectangle */
    column: Rect;
    /** Column index (0-based) */
    columnIndex: number;
    /** Detected lines in reading order */
    lines: PageLine[];
}

/**
 * Result of line detection for a page
 */
export interface PageLineResult {
    /** Page index (0-based) */
    pageIndex: number;
    /** Page dimensions */
    width: number;
    height: number;
    /** Line detection results per column */
    columnResults: ColumnLineResult[];
    /** All lines across all columns in reading order */
    allLines: PageLine[];
}

/**
 * Options for line detection
 */
export interface LineDetectionOptions {
    /** Base tolerance for grouping spans into lines (default: 3.0) */
    baseTolerance?: number;
    /** Threshold for merging overlapping lines (default: 0.5 = 50%) */
    overlapThreshold?: number;
    /** Gap multiplier for splitting lines (default: 5.0) */
    gapMultiplier?: number;
    /** Minimum overlap ratio for span to belong to column (default: 0.5) */
    minColumnOverlap?: number;
}

const DEFAULT_OPTIONS: Required<LineDetectionOptions> = {
    baseTolerance: 3.0,
    overlapThreshold: 0.5,
    gapMultiplier: 5.0,
    minColumnOverlap: 0.5,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert RawBBox to LineBBox format
 */
function toLineBBox(bbox: RawBBox): LineBBox {
    return {
        l: bbox.x,
        t: bbox.y,
        r: bbox.x + bbox.w,
        b: bbox.y + bbox.h,
        width: bbox.w,
        height: bbox.h,
    };
}

/**
 * Convert LineBBox to Rect format (for compatibility)
 */
export function lineBBoxToRect(bbox: LineBBox): Rect {
    return {
        x: bbox.l,
        y: bbox.t,
        w: bbox.width,
        h: bbox.height,
    };
}

/**
 * Check if a point is inside a rectangle
 */
function isPointInRect(
    point: { x: number; y: number },
    rect: Rect
): boolean {
    return (
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h
    );
}

/**
 * Calculate overlap ratio between a bbox and a column
 */
function calculateColumnOverlap(bbox: RawBBox, column: Rect): number {
    const xOverlapStart = Math.max(bbox.x, column.x);
    const xOverlapEnd = Math.min(bbox.x + bbox.w, column.x + column.w);
    const yOverlapStart = Math.max(bbox.y, column.y);
    const yOverlapEnd = Math.min(bbox.y + bbox.h, column.y + column.h);

    if (xOverlapEnd <= xOverlapStart || yOverlapEnd <= yOverlapStart) {
        return 0;
    }

    const overlapArea = (xOverlapEnd - xOverlapStart) * (yOverlapEnd - yOverlapStart);
    const bboxArea = bbox.w * bbox.h;

    return bboxArea > 0 ? overlapArea / bboxArea : 0;
}

/**
 * Calculate median of an array of numbers
 */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Merge multiple bounding boxes into one
 */
function mergeBoundingBoxes(bboxes: LineBBox[]): LineBBox {
    if (bboxes.length === 0) {
        return { l: 0, t: 0, r: 0, b: 0, width: 0, height: 0 };
    }

    const l = Math.min(...bboxes.map(b => b.l));
    const t = Math.min(...bboxes.map(b => b.t));
    const r = Math.max(...bboxes.map(b => b.r));
    const b = Math.max(...bboxes.map(b => b.b));

    return {
        l,
        t,
        r,
        b,
        width: r - l,
        height: b - t,
    };
}

/**
 * Clean text by normalizing whitespace
 */
function cleanText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

// ============================================================================
// Step 1: Extract Spans Within Column
// ============================================================================

/**
 * Extract all text spans that belong to a column
 */
function extractSpansInColumn(
    page: RawPageData,
    column: Rect,
    minOverlap: number
): DetectedSpan[] {
    const spans: DetectedSpan[] = [];

    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;

        for (const line of block.lines) {
            // Check if line overlaps with column
            if (calculateColumnOverlap(line.bbox, column) < minOverlap) {
                continue;
            }

            const text = cleanText(line.text || "");
            if (!text) continue;

            spans.push({
                text,
                bbox: line.bbox,
                lineBBox: toLineBBox(line.bbox),
                size: line.font?.size,
                fontName: line.font?.name,
                fontWeight: line.font?.weight,
                fontStyle: line.font?.style,
            });
        }
    }

    return spans;
}

// ============================================================================
// Step 3: Sort Spans Spatially
// ============================================================================

/**
 * Sort spans by vertical position, then horizontal
 */
function sortSpansSpatially(spans: DetectedSpan[]): DetectedSpan[] {
    return [...spans].sort((a, b) => {
        const topDiff = a.lineBBox.t - b.lineBBox.t;
        if (Math.abs(topDiff) > 0.1) return topDiff;
        return a.lineBBox.l - b.lineBBox.l;
    });
}

// ============================================================================
// Step 4: Calculate Adaptive Tolerance
// ============================================================================

/**
 * Calculate adaptive tolerance based on median font size
 */
function calculateAdaptiveTolerance(
    spans: DetectedSpan[],
    baseTolerance: number
): number {
    const fontSizes = spans
        .map(s => s.size)
        .filter((size): size is number => size !== undefined && size > 0);

    if (fontSizes.length === 0) {
        return baseTolerance;
    }

    const medianFontSize = median(fontSizes);

    // Use 25% of font size but with reasonable bounds
    return Math.max(
        baseTolerance,
        Math.min(0.25 * medianFontSize, baseTolerance * 2)
    );
}

// ============================================================================
// Step 5: Group Spans Into Lines
// ============================================================================

/**
 * Group spans into lines based on vertical proximity
 */
function groupSpansIntoLines(
    spans: DetectedSpan[],
    tolerance: number
): DetectedSpan[][] {
    const lines: DetectedSpan[][] = [];

    for (const span of spans) {
        let foundLineIdx = -1;
        let bestDistance = Infinity;

        // Find best matching line
        for (let i = 0; i < lines.length; i++) {
            const lineSpans = lines[i];

            // Calculate line's top using median (more robust than single span)
            let lineTop: number;
            if (lineSpans.length === 1) {
                lineTop = lineSpans[0].lineBBox.t;
            } else {
                const tops = lineSpans.map(s => s.lineBBox.t);
                lineTop = median(tops);
            }

            const distance = Math.abs(span.lineBBox.t - lineTop);

            if (distance <= tolerance && distance < bestDistance) {
                foundLineIdx = i;
                bestDistance = distance;
            }
        }

        if (foundLineIdx !== -1) {
            lines[foundLineIdx].push(span);
        } else {
            lines.push([span]);
        }
    }

    return lines;
}

// ============================================================================
// Step 6: Split Lines with Large Horizontal Gaps
// ============================================================================

/**
 * Split lines that have extremely large horizontal gaps
 */
function splitLinesWithLargeGaps(
    lines: DetectedSpan[][],
    gapMultiplier: number
): DetectedSpan[][] {
    const refinedLines: DetectedSpan[][] = [];

    for (const lineSpans of lines) {
        // Only check lines with more than 3 spans
        if (lineSpans.length <= 3) {
            refinedLines.push(lineSpans);
            continue;
        }

        // Sort horizontally
        const sortedSpans = [...lineSpans].sort(
            (a, b) => a.lineBBox.l - b.lineBBox.l
        );

        // Find max gap
        let maxGap = 0;
        let maxGapIdx = -1;
        for (let i = 0; i < sortedSpans.length - 1; i++) {
            const gap = sortedSpans[i + 1].lineBBox.l - sortedSpans[i].lineBBox.r;
            if (gap > maxGap) {
                maxGap = gap;
                maxGapIdx = i + 1;
            }
        }

        // Calculate median font size
        const fontSizes = lineSpans
            .map(s => s.size)
            .filter((s): s is number => s !== undefined);
        const medianFs = fontSizes.length > 0 ? median(fontSizes) : 12.0;

        // Split if gap is > gapMultiplier * median font size
        if (maxGap > gapMultiplier * medianFs && maxGapIdx > 0) {
            refinedLines.push(sortedSpans.slice(0, maxGapIdx));
            refinedLines.push(sortedSpans.slice(maxGapIdx));
        } else {
            refinedLines.push(lineSpans);
        }
    }

    return refinedLines;
}

// ============================================================================
// Step 7: Convert to PageLine Objects
// ============================================================================

/**
 * Convert grouped spans to PageLine objects
 */
function convertToPageLines(refinedLines: DetectedSpan[][]): PageLine[] {
    const pageLines: PageLine[] = [];

    for (const lineSpans of refinedLines) {
        if (lineSpans.length === 0) continue;

        // Sort spans horizontally
        const sortedSpans = [...lineSpans].sort(
            (a, b) => a.lineBBox.l - b.lineBBox.l
        );

        // Get all bboxes
        const bboxes = sortedSpans.map(s => s.lineBBox);

        // Merge into single bbox
        const mergedBbox = mergeBoundingBoxes(bboxes);

        // Concatenate text
        const text = sortedSpans.map(s => s.text).join(" ");

        // Calculate median font size
        const fontSizes = sortedSpans
            .map(s => s.size)
            .filter((s): s is number => s !== undefined);
        const fontSize = fontSizes.length > 0 ? median(fontSizes) : undefined;

        pageLines.push({
            spans: sortedSpans,
            bboxes,
            bbox: mergedBbox,
            text,
            fontSize,
        });
    }

    return pageLines;
}

// ============================================================================
// Step 8: Merge Overlapping Lines
// ============================================================================

/**
 * Merge lines that have significant vertical overlap
 * (handles drop caps, subscripts, superscripts, etc.)
 */
function mergeOverlappingLines(
    lines: PageLine[],
    overlapThreshold: number
): PageLine[] {
    // Sort vertically
    let pageLines = [...lines].sort((a, b) => a.bbox.t - b.bbox.t);

    // Iteratively merge until no more merges occur
    while (true) {
        let mergedInPass = false;
        const mergedIndices = new Set<number>();
        const joinedLines: PageLine[] = [];

        for (let i = 0; i < pageLines.length; i++) {
            if (mergedIndices.has(i)) continue;

            const currentLine = { ...pageLines[i] };

            for (let j = i + 1; j < pageLines.length; j++) {
                if (mergedIndices.has(j)) continue;

                const otherLine = pageLines[j];

                // Calculate vertical overlap
                const overlapTop = Math.max(currentLine.bbox.t, otherLine.bbox.t);
                const overlapBottom = Math.min(currentLine.bbox.b, otherLine.bbox.b);
                const verticalOverlap = Math.max(0, overlapBottom - overlapTop);

                const minHeight = Math.min(
                    currentLine.bbox.height,
                    otherLine.bbox.height
                );
                const overlapProportion =
                    minHeight > 0 ? verticalOverlap / minHeight : 0;

                if (overlapProportion > overlapThreshold) {
                    // Merge other into current
                    currentLine.spans = [...currentLine.spans, ...otherLine.spans];
                    currentLine.spans.sort((a, b) => a.lineBBox.l - b.lineBBox.l);
                    currentLine.bboxes = currentLine.spans.map(s => s.lineBBox);
                    currentLine.bbox = mergeBoundingBoxes(currentLine.bboxes);
                    currentLine.text = currentLine.spans.map(s => s.text).join(" ");

                    // Recalculate font size
                    const fontSizes = currentLine.spans
                        .map(s => s.size)
                        .filter((s): s is number => s !== undefined);
                    currentLine.fontSize =
                        fontSizes.length > 0 ? median(fontSizes) : undefined;

                    mergedIndices.add(j);
                    mergedInPass = true;
                }
            }

            joinedLines.push(currentLine);
        }

        pageLines = joinedLines;
        if (!mergedInPass) break;
    }

    return pageLines;
}

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Detect lines within a single column
 */
export function detectLinesInColumn(
    page: RawPageData,
    column: Rect,
    columnIndex: number,
    options: LineDetectionOptions = {}
): ColumnLineResult {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Step 1: Extract spans in column
    let spans = extractSpansInColumn(page, column, opts.minColumnOverlap);

    if (spans.length === 0) {
        return {
            column,
            columnIndex,
            lines: [],
        };
    }

    // Step 3: Sort spatially (Step 2 is integrated into Step 1)
    spans = sortSpansSpatially(spans);

    // Step 4: Calculate adaptive tolerance
    const tolerance = calculateAdaptiveTolerance(spans, opts.baseTolerance);

    // Step 5: Group into lines
    let lines = groupSpansIntoLines(spans, tolerance);

    // Step 6: Split lines with large gaps
    lines = splitLinesWithLargeGaps(lines, opts.gapMultiplier);

    // Step 7: Convert to PageLine objects
    let pageLines = convertToPageLines(lines);

    // Step 8: Merge overlapping lines
    pageLines = mergeOverlappingLines(pageLines, opts.overlapThreshold);

    return {
        column,
        columnIndex,
        lines: pageLines,
    };
}

/**
 * Detect lines for all columns on a page
 */
export function detectLinesOnPage(
    page: RawPageData,
    columns: Rect[],
    options: LineDetectionOptions = {}
): PageLineResult {
    const columnResults: ColumnLineResult[] = [];
    const allLines: PageLine[] = [];

    for (let i = 0; i < columns.length; i++) {
        const result = detectLinesInColumn(page, columns[i], i, options);
        columnResults.push(result);
        allLines.push(...result.lines);
    }

    return {
        pageIndex: page.pageIndex,
        width: page.width,
        height: page.height,
        columnResults,
        allLines,
    };
}

/**
 * Log line detection results for debugging.
 * Only logs in development mode.
 */
export function logLineDetection(result: PageLineResult): void {
    if (process.env.NODE_ENV !== "development") return;

    console.log(
        `[LineDetector] Page ${result.pageIndex}: ${result.allLines.length} lines detected ` +
            `across ${result.columnResults.length} column(s)`
    );

    for (const colResult of result.columnResults) {
        console.log(
            `    Column ${colResult.columnIndex + 1}: ${colResult.lines.length} lines`
        );

        // Log first few lines as preview
        const previewCount = Math.min(3, colResult.lines.length);
        for (let i = 0; i < previewCount; i++) {
            const line = colResult.lines[i];
            const textPreview =
                line.text.length > 60
                    ? line.text.slice(0, 60) + "..."
                    : line.text;
            console.log(
                `      Line ${i + 1}: "${textPreview}" ` +
                    `(y=${line.bbox.t.toFixed(0)}, h=${line.bbox.height.toFixed(1)})`
            );
        }

        if (colResult.lines.length > previewCount) {
            console.log(`      ... and ${colResult.lines.length - previewCount} more lines`);
        }
    }
}

