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

import type { BoundingBox, RawPageData, RawBlock, RawLine, RawStyleRun } from "@beaver/agent-core/extract/types";
import { bboxHeight, bboxWidth, mergeBoxes } from "@beaver/agent-core/extract/types";
import type { Rect } from "./ColumnDetector";
import { pdfLog, isAnalyzerLoggingEnabled } from "./logging";

// ============================================================================
// Types
// ============================================================================

/**
 * A span of text with consistent styling
 */
export interface DetectedSpan {
    /** Text content */
    text: string;
    /** Original source MuPDF-frame bbox */
    bbox: BoundingBox;
    /** Bbox used for line grouping */
    lineBBox: BoundingBox;
    /** Font size */
    size?: number;
    /** Font name */
    fontName?: string;
    /** Font weight */
    fontWeight?: string;
    /** Font style */
    fontStyle?: string;
    /** Per-glyph style runs of the source line, when recorded (see `RawLine.styleRuns`) */
    styleRuns?: RawStyleRun[];
    /**
     * The source line's text ends in whitespace (trimmed from `text`): the
     * PDF set a space after its last word, so a break after it falls between
     * words (see `decideLineJoin`).
     */
    trailingSpace?: true;
}

/**
 * A detected line of text
 */
export interface PageLine {
    /** All spans in this line (sorted left to right) */
    spans: DetectedSpan[];
    /** Individual span bboxes */
    bboxes: BoundingBox[];
    /** Merged line bbox (union of all spans) */
    bbox: BoundingBox;
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
    /**
     * Give each raw line to one column only when column boxes overlap (see
     * `lineColumnOwners`; default: false). Without it a
     * line inside two column boxes is read in both, and its text appears
     * twice. Enabled by the PDF schema preset.
     */
    exclusiveColumns?: boolean;
}

const DEFAULT_OPTIONS: Required<LineDetectionOptions> = {
    baseTolerance: 3.0,
    overlapThreshold: 0.5,
    gapMultiplier: 5.0,
    minColumnOverlap: 0.5,
    exclusiveColumns: false,
};

// ============================================================================
// Helper Functions
// ============================================================================

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
function calculateColumnOverlap(bbox: BoundingBox, column: Rect): number {
    const xOverlapStart = Math.max(bbox.l, column.x);
    const xOverlapEnd = Math.min(bbox.r, column.x + column.w);
    const yOverlapStart = Math.max(bbox.t, column.y);
    const yOverlapEnd = Math.min(bbox.b, column.y + column.h);

    if (xOverlapEnd <= xOverlapStart || yOverlapEnd <= yOverlapStart) {
        return 0;
    }

    const overlapArea = (xOverlapEnd - xOverlapStart) * (yOverlapEnd - yOverlapStart);
    const bboxArea = bboxWidth(bbox) * bboxHeight(bbox);

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
    minOverlap: number,
    owner?: { columnOf: Map<RawLine, number>; columnIndex: number },
): DetectedSpan[] {
    const spans: DetectedSpan[] = [];

    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;

        for (const line of block.lines) {
            // Check if line overlaps with column
            if (calculateColumnOverlap(line.bbox, column) < minOverlap) {
                continue;
            }
            if (owner && owner.columnOf.get(line) !== owner.columnIndex) continue;

            const text = cleanText(line.text || "");
            if (!text) continue;

            spans.push({
                text,
                bbox: line.bbox,
                lineBBox: line.bbox,
                size: line.font?.size,
                fontName: line.font?.name,
                fontWeight: line.font?.weight,
                fontStyle: line.font?.style,
                styleRuns: line.styleRuns,
                ...(/\s$/u.test(line.text) ? { trailingSpace: true as const } : {}),
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
        const mergedBbox = mergeBoxes(bboxes);

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
                    bboxHeight(currentLine.bbox),
                    bboxHeight(otherLine.bbox)
                );
                const overlapProportion =
                    minHeight > 0 ? verticalOverlap / minHeight : 0;

                // Skip merge when one bbox is much taller than the other.
                // This catches drop caps: a 5-line drop cap's tall bbox
                // vertically encompasses every body line below it, and the
                // overlap test alone would absorb them all into one merged
                // "line", scrambling reading order. Sub/superscripts and
                // inline math stay below this ratio and continue to merge.
                const maxHeight = Math.max(
                    bboxHeight(currentLine.bbox),
                    bboxHeight(otherLine.bbox)
                );
                const heightRatio =
                    minHeight > 0 ? maxHeight / minHeight : Infinity;

                if (overlapProportion > overlapThreshold && heightRatio <= 3) {
                    // Merge other into current
                    currentLine.spans = [...currentLine.spans, ...otherLine.spans];
                    currentLine.spans.sort((a, b) => a.lineBBox.l - b.lineBBox.l);
                    currentLine.bboxes = currentLine.spans.map(s => s.lineBBox);
                    currentLine.bbox = mergeBoxes(currentLine.bboxes);
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
    options: LineDetectionOptions = {},
    columnOf?: Map<RawLine, number>,
): ColumnLineResult {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Step 1: Extract spans in column
    let spans = extractSpansInColumn(
        page,
        column,
        opts.minColumnOverlap,
        columnOf ? { columnOf, columnIndex } : undefined,
    );

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
 * Whether the smaller of two overlapping column boxes, `inner`, is a column
 * of its own: text of `outer` that `inner` lacks sits beside `inner`'s lines
 * across a gap (a real column under a box that spans the page, a heading
 * beside the next column).
 *
 * When such text comes within half an em of one of `inner`'s lines, `inner`
 * is a piece cut out of `outer`'s rows (a superscript, the second half of a
 * wrapped title, the middle of rows MuPDF split into pieces). With text
 * beside it on a single row, `inner` is a column only when that text is on
 * one side and at least 1.5 em away: text on both sides makes it the middle
 * of a row, whose justified word spaces can be wider than half an em. With
 * no text beside it, `inner` is a run of `outer`'s rows.
 */
function isColumnBeside(innerLines: RawLine[], outerLines: RawLine[]): boolean {
    const inner = new Set(innerLines);
    const rows: { top: number; height: number; left: boolean; right: boolean; minGapEm: number }[] = [];
    for (const b of outerLines) {
        if (inner.has(b)) continue;
        for (const a of innerLines) {
            const minH = Math.min(bboxHeight(a.bbox), bboxHeight(b.bbox));
            const overlapY = Math.min(a.bbox.b, b.bbox.b) - Math.max(a.bbox.t, b.bbox.t);
            if (!(minH > 0) || overlapY < 0.5 * minH) continue;
            const em = Math.min(a.font?.size || 0.7 * bboxHeight(a.bbox), b.font?.size || 0.7 * bboxHeight(b.bbox));
            const gap = Math.max(b.bbox.l - a.bbox.r, a.bbox.l - b.bbox.r);
            if (gap <= 0.5 * em) return false;
            let row = rows.find((r) => Math.abs(r.top - a.bbox.t) < 0.5 * r.height);
            if (!row) {
                row = { top: a.bbox.t, height: bboxHeight(a.bbox), left: false, right: false, minGapEm: Infinity };
                rows.push(row);
            }
            if (b.bbox.r <= a.bbox.l) row.left = true;
            else row.right = true;
            row.minGapEm = Math.min(row.minGapEm, gap / em);
        }
    }
    if (rows.length >= 2) return true;
    if (rows.length === 0) return false;
    const [row] = rows;
    return row.left !== row.right && row.minGapEm >= 1.5;
}

/**
 * Whether two column boxes overlap or touch. When none do and a line must
 * have at least half its area in a box to be read there, no line lies in two
 * of them (a line meeting two separate boxes also covers the gap between
 * them, so its overlap shares sum below 1), and lines need no owner.
 */
function columnsMeet(columns: Rect[]): boolean {
    for (let i = 0; i < columns.length; i++) {
        for (let j = i + 1; j < columns.length; j++) {
            const a = columns[i];
            const b = columns[j];
            if (Math.min(a.x + a.w, b.x + b.w) >= Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) >= Math.max(a.y, b.y)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * The column each raw line is read in, when column boxes overlap and a line
 * lies in two of them: the smaller box when it is a column of its own (see
 * `isColumnBeside`), the larger box otherwise (it holds the paragraph the
 * smaller one is a piece of).
 */
function lineColumnOwners(
    page: RawPageData,
    columns: Rect[],
    minOverlap: number,
): Map<RawLine, number> {
    const candidates = new Map<RawLine, number[]>();
    const members: RawLine[][] = columns.map(() => []);
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const inColumns: number[] = [];
            for (let i = 0; i < columns.length; i++) {
                if (calculateColumnOverlap(line.bbox, columns[i]) < minOverlap) continue;
                inColumns.push(i);
                members[i].push(line);
            }
            candidates.set(line, inColumns);
        }
    }
    const area = (i: number) => columns[i].w * columns[i].h;
    const preferred = new Map<string, number>();
    const prefer = (i: number, j: number): number => {
        const key = `${i}|${j}`;
        let winner = preferred.get(key);
        if (winner === undefined) {
            const [small, large] = area(j) < area(i) ? [j, i] : [i, j];
            winner = isColumnBeside(members[small], members[large]) ? small : large;
            preferred.set(key, winner);
        }
        return winner;
    };
    const owners = new Map<RawLine, number>();
    for (const [line, inColumns] of candidates) {
        if (inColumns.length === 0) continue;
        let best = inColumns[0];
        for (const i of inColumns.slice(1)) best = prefer(best, i);
        owners.set(line, best);
    }
    return owners;
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
    const minOverlap = options.minColumnOverlap ?? DEFAULT_OPTIONS.minColumnOverlap;
    const columnOf = options.exclusiveColumns && (minOverlap < 0.5 || columnsMeet(columns))
        ? lineColumnOwners(page, columns, minOverlap)
        : undefined;

    for (let i = 0; i < columns.length; i++) {
        const result = detectLinesInColumn(page, columns[i], i, options, columnOf);
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
 * Log line detection results when {@link ExtractionSettings.analyzerLogging} is enabled.
 */
export function logLineDetection(result: PageLineResult): void {
    if (!isAnalyzerLoggingEnabled()) return;

    pdfLog(
        `[LineDetector] Page ${result.pageIndex}: ${result.allLines.length} lines detected ` +
            `across ${result.columnResults.length} column(s)`,
        3,
    );

    for (const colResult of result.columnResults) {
        pdfLog(
            `    Column ${colResult.columnIndex + 1}: ${colResult.lines.length} lines`,
            3,
        );

        // Log first few lines as preview
        const previewCount = Math.min(3, colResult.lines.length);
        for (let i = 0; i < previewCount; i++) {
            const line = colResult.lines[i];
            const textPreview =
                line.text.length > 60
                    ? line.text.slice(0, 60) + "..."
                    : line.text;
            pdfLog(
                `      Line ${i + 1}: "${textPreview}" ` +
                    `(y=${line.bbox.t.toFixed(0)}, h=${bboxHeight(line.bbox).toFixed(1)})`,
                3,
            );
        }

        if (colResult.lines.length > previewCount) {
            pdfLog(`      ... and ${colResult.lines.length - previewCount} more lines`, 3);
        }
    }
}
