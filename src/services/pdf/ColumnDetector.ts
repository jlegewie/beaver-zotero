/**
 * Column Detector
 *
 * Detects multi-column layouts in PDF pages and returns text rectangles
 * sorted in natural reading order.
 */

import type { RawPageData, RawBlock, RawLine, RawBBox } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Rectangle with x, y, w, h format */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Column detection result */
export interface ColumnDetectionResult {
    /** Detected column rectangles in reading order */
    columns: Rect[];
    /** Whether the page appears broken (many replacement chars) */
    isBroken: boolean;
    /** Number of columns detected */
    columnCount: number;
}

/** Options for column detection */
export interface ColumnDetectionOptions {
    /** Header margin to exclude (default: 50pt) */
    headerMargin?: number;
    /** Footer margin to exclude (default: 50pt) */
    footerMargin?: number;
    /** Tolerance for edge alignment (default: 3pt) */
    edgeTolerance?: number;
    /** Maximum vertical gap for joining blocks (default: 10pt) */
    maxVerticalGap?: number;
}

const DEFAULT_OPTIONS: Required<ColumnDetectionOptions> = {
    headerMargin: 50,
    footerMargin: 50,
    edgeTolerance: 3,
    maxVerticalGap: 10,
};

// ============================================================================
// Helper Functions
// ============================================================================

/** Union two rectangles */
function unionRect(r1: Rect | null, r2: Rect): Rect {
    if (!r1) return { ...r2 };
    return {
        x: Math.min(r1.x, r2.x),
        y: Math.min(r1.y, r2.y),
        w: Math.max(r1.x + r1.w, r2.x + r2.w) - Math.min(r1.x, r2.x),
        h: Math.max(r1.y + r1.h, r2.y + r2.h) - Math.min(r1.y, r2.y),
    };
}

/** Check if two rectangles intersect */
function rectsIntersect(r1: Rect, r2: Rect): boolean {
    return !(
        r1.x + r1.w <= r2.x ||
        r2.x + r2.w <= r1.x ||
        r1.y + r1.h <= r2.y ||
        r2.y + r2.h <= r1.y
    );
}

/** Check if two rectangles are equal (within tolerance) */
function rectsEqual(r1: Rect, r2: Rect, tolerance: number = 0.01): boolean {
    return (
        Math.abs(r1.x - r2.x) < tolerance &&
        Math.abs(r1.y - r2.y) < tolerance &&
        Math.abs(r1.w - r2.w) < tolerance &&
        Math.abs(r1.h - r2.h) < tolerance
    );
}

/** Convert RawBBox to Rect */
function bboxToRect(bbox: RawBBox): Rect {
    return { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
}

/** Check if font is a symbol font */
function isSymbolFont(fontName: string): boolean {
    const symbolFonts = ["zapfdingbats", "symbol", "wingdings", "webdings"];
    return symbolFonts.some(sf => fontName.toLowerCase().includes(sf));
}

/** Check if text is a plot marker */
function isPlotMarker(text: string): boolean {
    const plotMarkers = [
        "●", "○", "◆", "◇", "■", "□", "▲", "△", "▼", "▽", "★", "☆", "+", "x", "*",
    ];
    return plotMarkers.includes(text.trim());
}

/** Check if text is single repeated non-alphanumeric character */
function isRepeatedNonAlnum(text: string): boolean {
    if (text.length < 2) return false;
    const firstChar = text[0];
    if (/[a-zA-Z0-9]/.test(firstChar)) return false;
    return text.split("").every(c => c === firstChar);
}

// ============================================================================
// Page Broken Check
// ============================================================================

/**
 * Check if a page appears broken (many replacement characters).
 * This indicates font encoding issues.
 */
export function pageIsBroken(
    page: RawPageData,
    sampleLen: number = 2000,
    runLen: number = 16,
    ratio: number = 0.5
): boolean {
    // Build text from all lines
    let text = "";
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            text += line.text + " ";
        }
    }

    const sample = text.slice(0, sampleLen);
    if (!sample) return false;

    // Count replacement characters (U+FFFD)
    const replCount = (sample.match(/\uFFFD/g) || []).length;

    // Ratio check: > 50% replacement chars
    if (replCount / sample.length >= ratio) {
        return true;
    }

    // Streak check: runLen consecutive replacement chars
    let streak = 0;
    for (const ch of sample) {
        streak = ch === "\uFFFD" ? streak + 1 : 0;
        if (streak >= runLen) {
            return true;
        }
    }

    return false;
}

// ============================================================================
// Column Detection
// ============================================================================

/**
 * Detect columns in a page and return sorted rectangles.
 */
export function detectColumns(
    page: RawPageData,
    options: ColumnDetectionOptions = {}
): ColumnDetectionResult {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Check if page is broken
    const isBroken = pageIsBroken(page);
    if (isBroken) {
        console.warn(`[ColumnDetector] Page ${page.pageIndex} appears broken (font encoding issues)`);
    }

    // Phase 1: Extract & filter text blocks
    const filteredBlocks = extractFilteredBlocks(page, opts);

    if (filteredBlocks.length === 0) {
        return { columns: [], isBroken, columnCount: 0 };
    }

    // Phase 2: Merge blocks into columns
    const mergedBlocks = mergeBlocks(filteredBlocks, opts);

    // Phase 3: Join & sort for reading order
    const sortedColumns = joinAndSort(mergedBlocks, opts);

    return {
        columns: sortedColumns,
        isBroken,
        columnCount: sortedColumns.length,
    };
}

/**
 * Phase 1: Extract and filter text blocks.
 */
function extractFilteredBlocks(
    page: RawPageData,
    opts: Required<ColumnDetectionOptions>
): Rect[] {
    const clip = {
        y0: opts.headerMargin,
        y1: page.height - opts.footerMargin,
    };

    const filteredBlocks: Rect[] = [];

    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;

        // Check if block is within clipping area
        const blockRect = bboxToRect(block.bbox);
        if (blockRect.y + blockRect.h < clip.y0 || blockRect.y > clip.y1) {
            continue; // Block is entirely in header/footer
        }

        // Check if this is a plot/symbol block
        if (isPlotSymbolBlock(block)) continue;

        // Check if text is horizontal (check first line's direction if available)
        // Note: MuPDF.js provides wmode (0 = horizontal, 1 = vertical)
        const firstLine = block.lines[0];
        if (firstLine && firstLine.wmode === 1) {
            continue; // Skip vertical text
        }

        // Build block bbox from valid lines only
        let validRect: Rect | null = null;
        for (const line of block.lines) {
            const lineText = line.text || "";

            // Skip whitespace-only lines
            if (/^\s*$/.test(lineText)) continue;

            // Count alphanumeric characters
            const alnumCount = (lineText.match(/[a-zA-Z0-9]/g) || []).length;
            const totalLength = lineText.length;

            // Keep line if: ≥2 alnum chars OR (≥1 alnum AND ≥3 total chars)
            if (alnumCount >= 2 || (alnumCount >= 1 && totalLength >= 3)) {
                const lineRect = bboxToRect(line.bbox);

                // Clip to content area
                if (lineRect.y + lineRect.h >= clip.y0 && lineRect.y <= clip.y1) {
                    validRect = unionRect(validRect, lineRect);
                }
            }
        }

        if (validRect) {
            filteredBlocks.push(validRect);
        }
    }

    // Initial sort by position (top, then left)
    filteredBlocks.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 0.1) return a.y - b.y;
        return a.x - b.x;
    });

    return filteredBlocks;
}

/**
 * Check if a block is a plot/symbol block (should be filtered out).
 */
function isPlotSymbolBlock(block: RawBlock): boolean {
    if (!block.lines) return false;

    // Check if ALL lines/spans match plot criteria
    for (const line of block.lines) {
        const text = line.text || "";
        const font = line.font;

        // Check symbol font
        if (font && isSymbolFont(font.name)) continue;

        // Check plot marker
        if (isPlotMarker(text)) continue;

        // Check small non-alnum text
        if (font && font.size < 8 && text.length <= 3 && !/[a-zA-Z0-9]/.test(text)) {
            continue;
        }

        // Check repeated non-alnum
        if (isRepeatedNonAlnum(text)) continue;

        // This line doesn't match plot criteria
        return false;
    }

    return true;
}

/**
 * Phase 2: Merge adjacent blocks into columns.
 */
function mergeBlocks(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): Rect[] {
    if (blocks.length === 0) return [];

    const mergedBlocks: Rect[] = [{ ...blocks[0] }];

    for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        let merged = false;

        // Try to merge with existing merged blocks
        for (let j = 0; j < mergedBlocks.length; j++) {
            const existingBlock = mergedBlocks[j];

            // Check if blocks have x-overlap
            const xOverlap = !(
                block.x + block.w < existingBlock.x ||
                existingBlock.x + existingBlock.w < block.x
            );
            if (!xOverlap) continue;

            // Try to union the blocks
            const unionBlock = unionRect(existingBlock, block);

            // Check if union intersects other merged blocks
            const intersectsOthers = mergedBlocks.some(
                (other, idx) => idx !== j && rectsIntersect(unionBlock, other)
            );

            if (!intersectsOthers) {
                mergedBlocks[j] = unionBlock;
                merged = true;
                break;
            }
        }

        if (!merged) {
            mergedBlocks.push({ ...block });
        }
    }

    // Remove duplicates
    const unique = mergedBlocks.filter(
        (block, idx) =>
            mergedBlocks.findIndex(b => rectsEqual(b, block, opts.edgeTolerance)) === idx
    );

    // Sort blocks with similar bottom coordinates by x-position
    const cleaned = [...unique];
    let i = 0;
    while (i < cleaned.length) {
        let j = i + 1;
        const bottomY = cleaned[i].y + cleaned[i].h;

        // Find all blocks with similar bottom coordinate
        while (
            j < cleaned.length &&
            Math.abs(cleaned[j].y + cleaned[j].h - bottomY) <= opts.edgeTolerance
        ) {
            j++;
        }

        // Sort this group by x-coordinate
        if (j > i + 1) {
            const group = cleaned.slice(i, j);
            group.sort((a, b) => a.x - b.x);
            cleaned.splice(i, j - i, ...group);
        }

        i = j;
    }

    return cleaned;
}

/**
 * Phase 3: Join rectangles and sort for reading order.
 */
function joinAndSort(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): Rect[] {
    if (blocks.length === 0) return [];

    // Align left/right edges if they differ by ≤ edgeTolerance
    for (let i = 0; i < blocks.length; i++) {
        // Find minimum x among blocks with similar left edge
        let minX = blocks[i].x;
        let maxX = blocks[i].x + blocks[i].w;

        for (const other of blocks) {
            if (Math.abs(other.x - blocks[i].x) <= opts.edgeTolerance) {
                minX = Math.min(minX, other.x);
            }
            if (Math.abs(other.x + other.w - (blocks[i].x + blocks[i].w)) <= opts.edgeTolerance) {
                maxX = Math.max(maxX, other.x + other.w);
            }
        }

        blocks[i].x = minX;
        blocks[i].w = maxX - minX;
    }

    // Join vertically adjacent rectangles
    const joined: Rect[] = [{ ...blocks[0] }];

    for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        const prevBlock = joined[joined.length - 1];

        // Check if vertically adjacent with similar edges
        const sameLeftEdge = Math.abs(block.x - prevBlock.x) <= opts.edgeTolerance;
        const sameRightEdge =
            Math.abs(block.x + block.w - (prevBlock.x + prevBlock.w)) <= opts.edgeTolerance;
        const verticalGap = block.y - (prevBlock.y + prevBlock.h);

        if (sameLeftEdge && sameRightEdge && verticalGap <= opts.maxVerticalGap) {
            // Merge with previous block
            joined[joined.length - 1] = unionRect(prevBlock, block);
        } else {
            joined.push({ ...block });
        }
    }

    // Sort for proper reading order (critical for multi-column)
    const sortedBlocks = joined.map(block => {
        // Find blocks to the left that vertically overlap
        const leftBlocks = joined.filter(other => {
            // Must be to the left
            if (other.x + other.w >= block.x) return false;

            // Must vertically overlap
            const vOverlap = !(
                block.y + block.h < other.y || other.y + other.h < block.y
            );
            if (!vOverlap) return false;

            // Filter out small blocks (subscripts, superscripts)
            const otherArea = other.w * other.h;
            const blockArea = block.w * block.h;
            if (otherArea < blockArea * 0.15) return false;
            if (other.w < 50) return false;

            return true;
        });

        // Sort by rightmost edge to find the closest left block
        leftBlocks.sort((a, b) => b.x + b.w - (a.x + a.w));

        // Compute sort key
        let sortKey: [number, number];
        if (leftBlocks.length > 0) {
            const leftBlock = leftBlocks[0];
            sortKey = [leftBlock.y, block.x]; // Use left block's top
        } else {
            sortKey = [block.y, block.x]; // Use own top
        }

        return { block, sortKey };
    });

    // Sort by computed keys
    sortedBlocks.sort((a, b) => {
        if (Math.abs(a.sortKey[0] - b.sortKey[0]) > 0.1) {
            return a.sortKey[0] - b.sortKey[0];
        }
        return a.sortKey[1] - b.sortKey[1];
    });

    return sortedBlocks.map(item => item.block);
}

/**
 * Log column detection results for debugging.
 */
export function logColumnDetection(
    pageIndex: number,
    result: ColumnDetectionResult
): void {
    console.log(
        `[ColumnDetector] Page ${pageIndex}: ${result.columnCount} column(s) detected` +
            (result.isBroken ? " [BROKEN]" : "")
    );

    if (result.columns.length > 0) {
        for (let i = 0; i < result.columns.length; i++) {
            const col = result.columns[i];
            console.log(
                `    Column ${i + 1}: x=${col.x.toFixed(0)}, y=${col.y.toFixed(0)}, ` +
                    `w=${col.w.toFixed(0)}, h=${col.h.toFixed(0)}`
            );
        }
    }
}

