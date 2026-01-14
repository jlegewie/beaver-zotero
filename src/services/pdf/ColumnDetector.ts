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
    /** Maximum height for a bridge element (default: 50pt) */
    maxBridgeHeight?: number;
    /** Maximum vertical gap when using bridge merging (default: 30pt) */
    bridgeVerticalGap?: number;
    /** Enable debug logging for column detection */
    debug?: boolean;
}

const DEFAULT_OPTIONS: Required<ColumnDetectionOptions> = {
    headerMargin: 50,
    footerMargin: 50,
    edgeTolerance: 3,
    maxVerticalGap: 10,
    maxBridgeHeight: 50,
    bridgeVerticalGap: 30,
    debug: false,
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

/** Check if r1 is horizontally contained within r2 (r1 fits inside r2's x-range) */
function isHorizontallyContained(
    inner: Rect,
    outer: Rect,
    tolerance: number
): boolean {
    // Inner's left edge is at or after outer's left edge
    const leftOk = inner.x >= outer.x - tolerance;
    // Inner's right edge is at or before outer's right edge
    const rightOk = inner.x + inner.w <= outer.x + outer.w + tolerance;
    return leftOk && rightOk;
}

/** Check if two rectangles have significant horizontal overlap */
function hasSignificantXOverlap(r1: Rect, r2: Rect, minOverlapRatio: number = 0.5): boolean {
    const overlapLeft = Math.max(r1.x, r2.x);
    const overlapRight = Math.min(r1.x + r1.w, r2.x + r2.w);
    const overlapWidth = Math.max(0, overlapRight - overlapLeft);

    // Check if overlap is significant relative to the narrower block
    const minWidth = Math.min(r1.w, r2.w);
    return overlapWidth >= minWidth * minOverlapRatio;
}

/** Check if two blocks are in the same column (share a common edge) */
function areInSameColumn(r1: Rect, r2: Rect, tolerance: number): boolean {
    // Same left edge
    const sameLeft = Math.abs(r1.x - r2.x) <= tolerance;
    // Same right edge
    const sameRight = Math.abs((r1.x + r1.w) - (r2.x + r2.w)) <= tolerance;
    // Both conditions for strict column match
    return sameLeft || sameRight;
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

/**
 * Merge bridge elements into adjacent column fragments.
 *
 * A "bridge" is a short-height element (like a section heading) that is
 * horizontally contained within both the block above and below it. When
 * the blocks above and below have similar edges (same column), we can
 * merge all three into one column rectangle.
 *
 * This handles cases like:
 *   [Full-width paragraph text]
 *   [  DATA AND METHODS  ]     <- narrower heading (bridge)
 *   [Full-width paragraph text]
 *
 * The heading doesn't span the full column width, but it's contained within
 * the paragraphs above and below, so they should all be one column.
 */
function mergeBridgeElements(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): Rect[] {
    if (blocks.length < 3) return blocks;

    // Iterate until no more merges can be done
    // This handles cases with multiple consecutive bridge elements
    let current = [...blocks];
    let changed = true;
    let iterations = 0;
    const maxIterations = 20; // Safety limit

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        const result = mergeBridgeElementsOnce(current, opts, opts.debug);

        if (result.length < current.length) {
            changed = true;
            current = result;
            if (opts.debug) {
                console.log(`[Bridge] Iteration ${iterations}: merged ${current.length + 2} -> ${result.length} blocks`);
            }
        }
    }

    return current;
}

/**
 * Single pass of bridge element merging.
 *
 * Uses a two-pass approach:
 * 1. First pass: identify all bridges and record merge operations
 * 2. Second pass: build the result, applying merges
 */
function mergeBridgeElementsOnce(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>,
    debug: boolean = false
): Rect[] {
    if (blocks.length < 3) return blocks;

    // Sort by vertical position
    const sorted = [...blocks].sort((a, b) => a.y - b.y);

    // First pass: identify all merge operations
    // Each merge is: { bridgeIdx, aboveIdx, belowIdx, mergedRect }
    interface MergeOp {
        bridgeIdx: number;
        aboveIdx: number;
        belowIdx: number;
        mergedRect: Rect;
    }
    const mergeOps: MergeOp[] = [];
    const alreadyInMerge = new Set<number>(); // Indices already part of a merge

    for (let i = 0; i < sorted.length; i++) {
        // Skip if this block is already part of another merge
        if (alreadyInMerge.has(i)) continue;

        const block = sorted[i];

        // Check if this block could be a bridge (limited height)
        if (block.h <= opts.maxBridgeHeight) {
            // Find potential neighbors above and below (excluding already-merged blocks)
            const neighborAbove = findClosestBlockAbove(sorted, i, opts, alreadyInMerge);
            const neighborBelow = findClosestBlockBelow(sorted, i, opts, alreadyInMerge);

            if (debug) {
                console.log(`[Bridge] Checking block ${i} (h=${block.h.toFixed(0)}): ` +
                    `above=${neighborAbove}, below=${neighborBelow}`);
            }

            if (neighborAbove !== null && neighborBelow !== null) {
                const above = sorted[neighborAbove];
                const below = sorted[neighborBelow];

                // Check if bridge has significant x-overlap with both neighbors
                const overlapWithAbove = hasSignificantXOverlap(block, above, 0.5);
                const overlapWithBelow = hasSignificantXOverlap(block, below, 0.5);

                // Also check if bridge is contained within the WIDER neighbor
                const widerNeighbor = above.w >= below.w ? above : below;
                const containedInWider = isHorizontallyContained(
                    block,
                    widerNeighbor,
                    opts.edgeTolerance
                );

                if (debug) {
                    console.log(`  overlapWithAbove=${overlapWithAbove}, overlapWithBelow=${overlapWithBelow}`);
                    console.log(`  containedInWider=${containedInWider} (wider=${above.w >= below.w ? 'above' : 'below'})`);
                    console.log(`  block: x=${block.x.toFixed(0)}-${(block.x + block.w).toFixed(0)}, w=${block.w.toFixed(0)}`);
                    console.log(`  above: x=${above.x.toFixed(0)}-${(above.x + above.w).toFixed(0)}, w=${above.w.toFixed(0)}`);
                    console.log(`  below: x=${below.x.toFixed(0)}-${(below.x + below.w).toFixed(0)}, w=${below.w.toFixed(0)}`);
                }

                // Merge if bridge overlaps with neighbors OR is contained in wider
                if ((overlapWithAbove && overlapWithBelow) || containedInWider) {
                    // Check that neighbors are in the same column
                    const sameLeftEdge =
                        Math.abs(above.x - below.x) <= opts.edgeTolerance;
                    const sameRightEdge =
                        Math.abs(above.x + above.w - (below.x + below.w)) <=
                        opts.edgeTolerance;
                    const neighborsOverlap = hasSignificantXOverlap(above, below, 0.7);

                    if (debug) {
                        console.log(`  sameLeftEdge=${sameLeftEdge}, sameRightEdge=${sameRightEdge}, neighborsOverlap=${neighborsOverlap}`);
                    }

                    if (sameLeftEdge || (sameRightEdge && neighborsOverlap)) {
                        // Create merged rect
                        const mergedRect = unionRect(
                            unionRect(above, block),
                            below
                        );

                        // Check that merged doesn't intersect other blocks
                        const intersectsOthers = sorted.some((other, idx) => {
                            if (idx === i || idx === neighborAbove || idx === neighborBelow)
                                return false;
                            if (alreadyInMerge.has(idx)) return false;
                            return rectsIntersect(mergedRect, other);
                        });

                        if (debug) {
                            console.log(`  intersectsOthers=${intersectsOthers}`);
                        }

                        if (!intersectsOthers) {
                            // Record this merge operation
                            mergeOps.push({
                                bridgeIdx: i,
                                aboveIdx: neighborAbove,
                                belowIdx: neighborBelow,
                                mergedRect,
                            });

                            // Mark all three indices as part of a merge
                            alreadyInMerge.add(i);
                            alreadyInMerge.add(neighborAbove);
                            alreadyInMerge.add(neighborBelow);

                            if (debug) {
                                console.log(`  ✓ WILL MERGE: blocks ${neighborAbove}, ${i}, ${neighborBelow}`);
                            }
                        }
                    }
                }
            }
        }
    }

    // Second pass: build the result
    const result: Rect[] = [];

    // Add all blocks that weren't merged
    for (let i = 0; i < sorted.length; i++) {
        if (!alreadyInMerge.has(i)) {
            result.push(sorted[i]);
        }
    }

    // Add all merged rects
    for (const op of mergeOps) {
        result.push(op.mergedRect);
    }

    if (debug && mergeOps.length > 0) {
        console.log(`[Bridge] Pass complete: ${sorted.length} blocks -> ${result.length} blocks (${mergeOps.length} merges)`);
    }

    return result;
}

/**
 * Find the closest block above the given index that hasn't been merged.
 */
function findClosestBlockAbove(
    sorted: Rect[],
    index: number,
    opts: Required<ColumnDetectionOptions>,
    merged: Set<number>
): number | null {
    const block = sorted[index];

    for (let i = index - 1; i >= 0; i--) {
        if (merged.has(i)) continue;

        const candidate = sorted[i];
        // Candidate must end before block starts
        if (candidate.y + candidate.h > block.y) continue;

        // Gap must be within threshold
        const gap = block.y - (candidate.y + candidate.h);
        if (gap > opts.bridgeVerticalGap) return null;

        return i;
    }

    return null;
}

/**
 * Find the closest block below the given index that hasn't been merged.
 */
function findClosestBlockBelow(
    sorted: Rect[],
    index: number,
    opts: Required<ColumnDetectionOptions>,
    merged: Set<number>
): number | null {
    const block = sorted[index];

    for (let i = index + 1; i < sorted.length; i++) {
        if (merged.has(i)) continue;

        const candidate = sorted[i];
        // Candidate must start after block ends
        if (candidate.y < block.y + block.h) continue;

        // Gap must be within threshold
        const gap = candidate.y - (block.y + block.h);
        if (gap > opts.bridgeVerticalGap) return null;

        return i;
    }

    return null;
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

    // Phase 3: Join rectangles and normalize edges
    const joinedBlocks = joinAndSort(mergedBlocks, opts);

    if (opts.debug) {
        console.log(`[ColumnDetector] Page ${page.pageIndex}: After Phase 3 (join): ${joinedBlocks.length} blocks`);
        for (const b of joinedBlocks) {
            console.log(`    x=${b.x.toFixed(0)}-${(b.x + b.w).toFixed(0)}, y=${b.y.toFixed(0)}, h=${b.h.toFixed(0)}`);
        }
    }

    // Phase 4: Merge bridge elements (headings contained within column fragments)
    const bridgeMerged = mergeBridgeElements(joinedBlocks, opts);

    if (opts.debug && bridgeMerged.length !== joinedBlocks.length) {
        console.log(`[ColumnDetector] Page ${page.pageIndex}: After Phase 4 (bridge): ${bridgeMerged.length} blocks`);
        for (const b of bridgeMerged) {
            console.log(`    x=${b.x.toFixed(0)}-${(b.x + b.w).toFixed(0)}, y=${b.y.toFixed(0)}, h=${b.h.toFixed(0)}`);
        }
    }

    // Phase 5: Final reading order sort
    const sortedColumns = sortForReadingOrder(bridgeMerged, opts);

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
 * Check if two blocks have similar edges (same column structure).
 * This is stricter than just x-overlap - requires similar left AND right edges.
 */
function hasSimilarEdges(
    block1: Rect,
    block2: Rect,
    tolerance: number
): boolean {
    const leftMatch = Math.abs(block1.x - block2.x) <= tolerance;
    const rightMatch = Math.abs((block1.x + block1.w) - (block2.x + block2.w)) <= tolerance;
    return leftMatch && rightMatch;
}

/**
 * Check if two blocks have significant x-overlap AND similar widths.
 * This prevents full-width blocks from merging with column blocks.
 */
function canMergeBlocks(
    block1: Rect,
    block2: Rect,
    tolerance: number
): boolean {
    // First check: do they have x-overlap?
    const xOverlap = !(
        block1.x + block1.w < block2.x ||
        block2.x + block2.w < block1.x
    );
    if (!xOverlap) return false;

    // Second check: do they have similar edges (same column)?
    // This prevents full-width headers from merging with column blocks
    if (hasSimilarEdges(block1, block2, tolerance)) {
        return true;
    }

    // Third check: is one block contained within the other horizontally?
    // Allow merging if smaller block is fully within larger block's x-range
    const block1ContainsBlock2 = 
        block1.x <= block2.x && (block1.x + block1.w) >= (block2.x + block2.w);
    const block2ContainsBlock1 = 
        block2.x <= block1.x && (block2.x + block2.w) >= (block1.x + block1.w);

    // Only merge if widths are similar (within 20% of each other)
    const widthRatio = Math.min(block1.w, block2.w) / Math.max(block1.w, block2.w);
    if ((block1ContainsBlock2 || block2ContainsBlock1) && widthRatio > 0.8) {
        return true;
    }

    return false;
}

/**
 * Phase 2: Merge adjacent blocks into columns.
 * Uses stricter criteria to prevent full-width blocks from merging with columns.
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

            // Check if blocks can be merged (similar edges or contained)
            if (!canMergeBlocks(block, existingBlock, opts.edgeTolerance)) {
                continue;
            }

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
 * Phase 3: Join rectangles and normalize edges.
 * Does NOT do final reading order sorting - that's done in Phase 5.
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

    // Join vertically adjacent rectangles with similar edges
    // This is more thorough - try to join with ANY existing block, not just previous
    const joined: Rect[] = [];

    for (const block of blocks) {
        let mergedWithExisting = false;

        for (let j = 0; j < joined.length; j++) {
            const existingBlock = joined[j];

            // Check if blocks have similar left and right edges
            const sameLeftEdge = Math.abs(block.x - existingBlock.x) <= opts.edgeTolerance;
            const sameRightEdge =
                Math.abs(block.x + block.w - (existingBlock.x + existingBlock.w)) <= opts.edgeTolerance;

            if (!sameLeftEdge || !sameRightEdge) continue;

            // Check vertical adjacency (block is below existing, with small gap)
            const gapBelow = block.y - (existingBlock.y + existingBlock.h);
            const gapAbove = existingBlock.y - (block.y + block.h);

            if (gapBelow >= 0 && gapBelow <= opts.maxVerticalGap) {
                // Block is below existing, merge
                joined[j] = unionRect(existingBlock, block);
                mergedWithExisting = true;
                break;
            } else if (gapAbove >= 0 && gapAbove <= opts.maxVerticalGap) {
                // Block is above existing, merge
                joined[j] = unionRect(existingBlock, block);
                mergedWithExisting = true;
                break;
            }
        }

        if (!mergedWithExisting) {
            joined.push({ ...block });
        }
    }

    // Second pass: try to merge any joined blocks that can now be combined
    // (after first pass, some blocks may have grown and can now be merged)
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < joined.length; i++) {
            for (let j = i + 1; j < joined.length; j++) {
                const block1 = joined[i];
                const block2 = joined[j];

                // Check if blocks have similar edges
                const sameLeftEdge = Math.abs(block1.x - block2.x) <= opts.edgeTolerance;
                const sameRightEdge =
                    Math.abs(block1.x + block1.w - (block2.x + block2.w)) <= opts.edgeTolerance;

                if (!sameLeftEdge || !sameRightEdge) continue;

                // Check if they're vertically adjacent now
                const gapBelow = block2.y - (block1.y + block1.h);
                const gapAbove = block1.y - (block2.y + block2.h);

                if ((gapBelow >= 0 && gapBelow <= opts.maxVerticalGap) ||
                    (gapAbove >= 0 && gapAbove <= opts.maxVerticalGap)) {
                    // Merge blocks
                    joined[i] = unionRect(block1, block2);
                    joined.splice(j, 1);
                    changed = true;
                    break;
                }
            }
            if (changed) break;
        }
    }

    return joined;
}

/**
 * Phase 5: Sort blocks for proper reading order (critical for multi-column).
 */
function sortForReadingOrder(
    blocks: Rect[],
    _opts: Required<ColumnDetectionOptions>
): Rect[] {
    if (blocks.length === 0) return [];

    const sortedBlocks = blocks.map(block => {
        // Find blocks to the left that vertically overlap
        const leftBlocks = blocks.filter(other => {
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
 * Only logs in development mode.
 */
export function logColumnDetection(
    pageIndex: number,
    result: ColumnDetectionResult
): void {
    if (process.env.NODE_ENV !== "development") return;

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

