/**
 * Column Detector
 *
 * Detects multi-column layouts in PDF pages and returns text rectangles
 * sorted in natural reading order.
 */

import type { BoundingBox, RawPageData, RawBlock, RawLine, TextStyle } from "./types";
import { bboxHeight, bboxWidth } from "./types";
import { pdfLog, isAnalyzerLoggingEnabled } from "./logging";
import { StyleAnalyzer } from "./StyleAnalyzer";

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
    /**
     * Document body styles. When supplied, the header/footer clip spares
     * blocks/lines whose font matches a body style. Relevant for tight-margin
     * layouts with body text within ~20-30pt of the page edge.
     */
    bodyStyles?: TextStyle[];
    /**
     * Bounding boxes of background-shaded display elements (tinted aside
     * boxes, sidebars, callouts) discovered by `collectFilledRects` +
     * `filterToContainerRects`. Each rect is treated as a zone — Phase 2
     * never fuses two text blocks if one is inside this rect and the
     * other is outside. Optional; when empty or absent, background shading
     * is ignored.
     */
    fillBoundaries?: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
    /**
     * Thin page-space rules discovered from stroke_path events. These are
     * treated as hard layout dividers: merge phases do not fuse blocks across
     * them, and reading-order xy-cut prefers a divider-backed cut when it
     * cleanly partitions a bundle.
     */
    dividerLines?: ReadonlyArray<{
        orientation: "horizontal" | "vertical";
        position: number;
        start: number;
        end: number;
        thickness: number;
    }>;
    /** Enable verbose column-detection phase logging (default false). */
    debug?: boolean;
}

const DEFAULT_OPTIONS: Required<ColumnDetectionOptions> = {
    headerMargin: 50,
    footerMargin: 50,
    edgeTolerance: 3,
    maxVerticalGap: 10,
    maxBridgeHeight: 50,
    bridgeVerticalGap: 30,
    bodyStyles: [],
    fillBoundaries: [],
    dividerLines: [],
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

/**
 * Check whether any line in `block` looks like body content (style +
 * substance). Used by `extractFilteredBlocks` to spare blocks whose
 * lines are content even when the block bbox lies entirely within the
 * header/footer clip. Short body-styled tokens (e.g. a body-font page
 * number "17" at the very bottom of a page) are NOT enough to spare a
 * block — see `StyleAnalyzer.looksLikeBodyContent`.
 */
function blockHasBodyContentLine(
    block: RawBlock,
    bodyStyles: TextStyle[]
): boolean {
    if (!block.lines || bodyStyles.length === 0) return false;
    for (const line of block.lines) {
        if (StyleAnalyzer.looksLikeBodyContent(line, bodyStyles)) return true;
    }
    return false;
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

/** Convert a public BoundingBox to the detector's internal Rect shape. */
function bboxToRect(bbox: BoundingBox): Rect {
    return { x: bbox.l, y: bbox.t, w: bboxWidth(bbox), h: bboxHeight(bbox) };
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
    if (/[\p{L}\p{N}]/u.test(firstChar)) return false;
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
/**
 * Per-bridge-merged block flags recording which side(s) of the merged
 * trio came from a SHORT block (bridge or short neighbor). These flags
 * define where in the resulting bigMerge a section heading was absorbed:
 *
 *   - `headingAtTop`: above was short → the top of the merged rect
 *     is a heading boundary; further merges with blocks ABOVE the merged
 *     rect would cross the heading.
 *   - `headingAtBottom`: below was short → the bottom is a heading
 *     boundary; further merges with blocks BELOW would cross it.
 *
 * Used by Phase 4.5 to keep strict / same-column-paragraphs merges from
 * extending a bridge-expanded block past what was a section break (e.g.
 * UCZSE63I p28 — body block bridge-expanded past "References" heading
 * mustn't grab the references list below).
 */
export interface BridgeFlags {
    headingAtTop: boolean;
    headingAtBottom: boolean;
}

function mergeBridgeElements(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): { blocks: Rect[]; bridgeFlags: Map<Rect, BridgeFlags> } {
    if (blocks.length < 3) {
        return { blocks, bridgeFlags: new Map() };
    }

    // Iterate until no more merges can be done
    // This handles cases with multiple consecutive bridge elements
    let current = [...blocks];
    const bridgeFlags = new Map<Rect, BridgeFlags>();
    let changed = true;
    let iterations = 0;
    const maxIterations = 20; // Safety limit

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        const result = mergeBridgeElementsOnce(current, opts, opts.debug);

        if (result.blocks.length < current.length) {
            changed = true;
            current = result.blocks;
            for (const entry of result.newlyExpanded) {
                bridgeFlags.set(entry.rect, entry.flags);
            }
            if (opts.debug) {
                pdfLog(`[Bridge] Iteration ${iterations}: merged ${current.length + 2} -> ${result.blocks.length} blocks`, 3);
            }
        }
    }

    return { blocks: current, bridgeFlags };
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
): { blocks: Rect[]; newlyExpanded: Array<{ rect: Rect; flags: BridgeFlags }> } {
    if (blocks.length < 3) return { blocks, newlyExpanded: [] };

    // Sort by vertical position
    const sorted = [...blocks].sort((a, b) => a.y - b.y);

    // First pass: identify all merge operations
    // Each merge is: { bridgeIdx, aboveIdx, belowIdx, mergedRect }
    interface MergeOp {
        bridgeIdx: number;
        aboveIdx: number;
        belowIdx: number;
        mergedRect: Rect;
        flags: BridgeFlags;
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
                pdfLog(`[Bridge] Checking block ${i} (h=${block.h.toFixed(0)}): ` +
                    `above=${neighborAbove}, below=${neighborBelow}`, 3);
            }

            if (neighborAbove !== null && neighborBelow !== null) {
                const above = sorted[neighborAbove];
                const below = sorted[neighborBelow];

                // Fill-zone guard. The bridge merger fuses three blocks
                // (above + bridge + below) into one column rect; that
                // operation crosses display-element boundaries when the
                // three don't share the same zone.
                if (opts.fillBoundaries.length > 0) {
                    const aboveZone = fillZoneFor(above, opts.fillBoundaries);
                    const bridgeZone = fillZoneFor(block, opts.fillBoundaries);
                    const belowZone = fillZoneFor(below, opts.fillBoundaries);
                    if (aboveZone !== bridgeZone || bridgeZone !== belowZone) {
                        if (debug) {
                            pdfLog(
                                `  zones differ (above=${aboveZone}, bridge=${bridgeZone}, below=${belowZone}) — skipping bridge`,
                                3,
                            );
                        }
                        continue;
                    }
                }

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
                    pdfLog(`  overlapWithAbove=${overlapWithAbove}, overlapWithBelow=${overlapWithBelow}`, 3);
                    pdfLog(`  containedInWider=${containedInWider} (wider=${above.w >= below.w ? 'above' : 'below'})`, 3);
                    pdfLog(`  block: x=${block.x.toFixed(0)}-${(block.x + block.w).toFixed(0)}, w=${block.w.toFixed(0)}`, 3);
                    pdfLog(`  above: x=${above.x.toFixed(0)}-${(above.x + above.w).toFixed(0)}, w=${above.w.toFixed(0)}`, 3);
                    pdfLog(`  below: x=${below.x.toFixed(0)}-${(below.x + below.w).toFixed(0)}, w=${below.w.toFixed(0)}`, 3);
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
                        pdfLog(`  sameLeftEdge=${sameLeftEdge}, sameRightEdge=${sameRightEdge}, neighborsOverlap=${neighborsOverlap}`, 3);
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
                            pdfLog(`  intersectsOthers=${intersectsOthers}`, 3);
                        }

                        if (!intersectsOthers) {
                            // Flag the merged trio's heading boundaries:
                            // a side is a "heading boundary" when the
                            // outer block on that side is BOTH short
                            // (h ≤ maxBridgeHeight) AND much narrower than
                            // the opposite side. The width gate
                            // distinguishes a real section heading (narrow,
                            // e.g. "References" w=79 on a 425-wide page)
                            // from a paragraph-end ragged tail (still
                            // close to column width). Without it, ordinary
                            // body+tail bridge merges would mark the
                            // bigMerge as having an absorbed heading and
                            // block legitimate same-column merges in
                            // Phase 4.5 (e.g. CZAA39JT p0).
                            const headingAtTop =
                                above.h <= opts.maxBridgeHeight &&
                                above.w * 2 < below.w;
                            const headingAtBottom =
                                below.h <= opts.maxBridgeHeight &&
                                below.w * 2 < above.w;
                            const flags: BridgeFlags = { headingAtTop, headingAtBottom };
                            // Record this merge operation
                            mergeOps.push({
                                bridgeIdx: i,
                                aboveIdx: neighborAbove,
                                belowIdx: neighborBelow,
                                mergedRect,
                                flags,
                            });

                            // Mark all three indices as part of a merge
                            alreadyInMerge.add(i);
                            alreadyInMerge.add(neighborAbove);
                            alreadyInMerge.add(neighborBelow);

                            if (debug) {
                                pdfLog(`  ✓ WILL MERGE: blocks ${neighborAbove}, ${i}, ${neighborBelow}`, 3);
                            }
                        }
                    }
                }
            }
        }
    }

    // Second pass: build the result
    const result: Rect[] = [];
    const newlyExpanded: Array<{ rect: Rect; flags: BridgeFlags }> = [];

    // Add all blocks that weren't merged
    for (let i = 0; i < sorted.length; i++) {
        if (!alreadyInMerge.has(i)) {
            result.push(sorted[i]);
        }
    }

    // Add all merged rects
    for (const op of mergeOps) {
        result.push(op.mergedRect);
        newlyExpanded.push({ rect: op.mergedRect, flags: op.flags });
    }

    if (debug && mergeOps.length > 0) {
        pdfLog(`[Bridge] Pass complete: ${sorted.length} blocks -> ${result.length} blocks (${mergeOps.length} merges)`, 3);
    }

    return { blocks: result, newlyExpanded };
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
    const opts: Required<ColumnDetectionOptions> = {
        ...DEFAULT_OPTIONS,
        ...options,
    };
    // Callers (e.g. FilteredParagraphPipeline) may forward an undefined
    // `fillBoundaries` prop verbatim, which would clobber the default
    // empty array. Re-apply the default after the spread so the no-zone
    // code path stays the default behavior.
    if (!opts.fillBoundaries) opts.fillBoundaries = [];
    if (!opts.dividerLines) opts.dividerLines = [];

    // Check if page is broken
    const isBroken = pageIsBroken(page);
    if (isBroken) {
        pdfLog(`[ColumnDetector] Page ${page.pageIndex} appears broken (font encoding issues)`, 2);
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
        pdfLog(`[ColumnDetector] Page ${page.pageIndex}: After Phase 3 (join): ${joinedBlocks.length} blocks`, 3);
        for (const b of joinedBlocks) {
            pdfLog(`    x=${b.x.toFixed(0)}-${(b.x + b.w).toFixed(0)}, y=${b.y.toFixed(0)}, h=${b.h.toFixed(0)}`, 3);
        }
    }

    // Phase 4: Merge bridge elements (headings contained within column fragments)
    const { blocks: bridgeMerged, bridgeFlags } = mergeBridgeElements(joinedBlocks, opts);

    if (opts.debug && bridgeMerged.length !== joinedBlocks.length) {
        pdfLog(`[ColumnDetector] Page ${page.pageIndex}: After Phase 4 (bridge): ${bridgeMerged.length} blocks`, 3);
        for (const b of bridgeMerged) {
            const flags = bridgeFlags.get(b);
            const flagStr = flags ? ` [top=${flags.headingAtTop} bot=${flags.headingAtBottom}]` : '';
            pdfLog(`    x=${b.x.toFixed(0)}-${(b.x + b.w).toFixed(0)}, y=${b.y.toFixed(0)}, h=${b.h.toFixed(0)}${flagStr}`, 3);
        }
    }

    // Phase 4.5: Re-run join with relaxed tail-merge enabled. Catches two
    // patterns that survive Phases 1-4 on ragged-right (left-aligned) text:
    //   (a) paragraph fragments separated only by an absorbed bridge whose
    //       removal would now leave them with a small gap and matching edges
    //   (b) trailing ragged lines (paragraph endings) below a host column,
    //       which fail Phase-2's width-ratio gate and have no neighbor below
    //       for bridge merging to fire.
    //
    // `bridgeFlags` is threaded through so iterative strict /
    // same-column-paragraphs merges can't extend a bridge-expanded block in
    // the direction where its bridge merge absorbed a heading (e.g.
    // UCZSE63I p28: body bridge-merged past "References" heading at its
    // bottom mustn't grab the references list below).
    const rejoined = joinAndSort(bridgeMerged, opts, /* relaxed */ true, bridgeFlags);

    if (opts.debug && rejoined.length !== bridgeMerged.length) {
        pdfLog(`[ColumnDetector] Page ${page.pageIndex}: After Phase 4.5 (rejoin): ${rejoined.length} blocks`, 3);
        for (const b of rejoined) {
            pdfLog(`    x=${b.x.toFixed(0)}-${(b.x + b.w).toFixed(0)}, y=${b.y.toFixed(0)}, h=${b.h.toFixed(0)}`, 3);
        }
    }

    // Phase 5: Final reading order sort. When fill-zone boundaries are
    // supplied, route through a zone-aware sort that treats each fill
    // zone as a single virtual block in the outer ordering and only
    // recurses inside it for the inner ordering. This prevents a clean
    // vertical gutter that exists ONLY because of the colored aside
    // box from splitting the surrounding body text in half during
    // reading-order traversal (DDS69CQI p36: top-body wraps L→R *above*
    // the big box; xyCut otherwise reads top-L → box-left → page-number
    // → top-R → box-right because of the gutter inside the box).
    const sortedColumns =
        opts.fillBoundaries.length > 0 || opts.dividerLines.length > 0
            ? sortForReadingOrderWithZones(rejoined, opts)
            : sortForReadingOrder(rejoined, opts);

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
    const bodyStyles = opts.bodyStyles;
    const hasBodyStyles = bodyStyles.length > 0;

    const filteredBlocks: Rect[] = [];

    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;

        // Header/footer clip. skipped when the block has body-styled lines.
        const blockRect = bboxToRect(block.bbox);
        const blockOutsideClip =
            blockRect.y + blockRect.h < clip.y0 || blockRect.y > clip.y1;
        const blockHasBodyLine =
            hasBodyStyles && blockHasBodyContentLine(block, bodyStyles);
        if (blockOutsideClip && !blockHasBodyLine) {
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

            // Count alphanumeric characters (any script via Unicode properties)
            const alnumCount = (lineText.match(/[\p{L}\p{N}]/gu) || []).length;
            const totalLength = lineText.length;

            // Keep line if: ≥2 alnum chars OR (≥1 alnum AND ≥3 total chars)
            if (alnumCount >= 2 || (alnumCount >= 1 && totalLength >= 3)) {
                const lineRect = bboxToRect(line.bbox);

                // Clip to content area. Body-content lines are spared from the clip.
                const lineInsideClip =
                    lineRect.y + lineRect.h >= clip.y0 && lineRect.y <= clip.y1;
                const lineIsBodyContent =
                    hasBodyStyles && StyleAnalyzer.looksLikeBodyContent(line, bodyStyles);
                if (lineInsideClip || lineIsBodyContent) {
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

        // Check symbol font — only when the text doesn't carry
        // substantial body content. MuPDF's JSON walk tags each line
        // with the font of its first run, so a bulleted heading like
        // "● Expert Systems: An expert system…" shows up here with
        // font.name = "Symbol" even though almost all the text is
        // regular body content. Gating on alnum count prevents the
        // whole heading block from being dropped as a plot marker.
        if (font && isSymbolFont(font.name)) {
            const alnumCount = (text.match(/[\p{L}\p{N}]/gu) || []).length;
            if (alnumCount < 3) continue;
        }

        // Check plot marker
        if (isPlotMarker(text)) continue;

        // Check small non-alnum text (Unicode-aware, so small non-Latin
        // snippets are not treated as plot symbols)
        if (font && font.size < 8 && text.length <= 3 && !/[\p{L}\p{N}]/u.test(text)) {
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
    // Allow merging if smaller block is fully within larger block's x-range.
    // Apply edge tolerance — MuPDF emits per-line widths that vary by a small
    // fraction of a point even within the same column, so strict inequality
    // here would treat a 0.01pt overshoot the same as a real column gutter.
    const block1ContainsBlock2 =
        block1.x <= block2.x + tolerance &&
        (block1.x + block1.w) >= (block2.x + block2.w) - tolerance;
    const block2ContainsBlock1 =
        block2.x <= block1.x + tolerance &&
        (block2.x + block2.w) >= (block1.x + block1.w) - tolerance;

    // Only merge if widths are similar (within 20% of each other)
    const widthRatio = Math.min(block1.w, block2.w) / Math.max(block1.w, block2.w);
    if ((block1ContainsBlock2 || block2ContainsBlock1) && widthRatio > 0.8) {
        return true;
    }

    return false;
}

/**
 * Tolerance (pt) when deciding whether a text-block rect is "inside" a
 * fill-boundary rect. Text bboxes routinely overshoot the visible fill
 * by a small amount (text descenders extend below the colored band, or
 * the fill is sized slightly tighter than its content). Without slop a
 * single overshooting pixel would put the block on the "wrong side" of
 * the boundary.
 */
const FILL_CONTAINMENT_SLOP = 3;
const DIVIDER_SLOP = 2;

/**
 * Identifier for the fill-zone a text block sits inside. Used as an
 * equality key in `mergeBlocks` — two blocks can only fuse when their
 * zone IDs match (both outside all fills, or both inside the same fill
 * rect).
 *
 * `null` ≡ "outside every fill boundary". Multiple fill rects are
 * resolved by the SMALLEST containing fill (innermost wins), so a
 * nested-callout layout produces deterministic zones.
 */
function fillZoneFor(
    rect: Rect,
    fillBoundaries: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): number | null {
    let bestIdx: number | null = null;
    let bestArea = Infinity;
    for (let i = 0; i < fillBoundaries.length; i++) {
        const f = fillBoundaries[i];
        const inside =
            rect.x >= f.x - FILL_CONTAINMENT_SLOP &&
            rect.y >= f.y - FILL_CONTAINMENT_SLOP &&
            rect.x + rect.w <= f.x + f.w + FILL_CONTAINMENT_SLOP &&
            rect.y + rect.h <= f.y + f.h + FILL_CONTAINMENT_SLOP;
        if (!inside) continue;
        const area = f.w * f.h;
        if (area < bestArea) {
            bestArea = area;
            bestIdx = i;
        }
    }
    return bestIdx;
}

function rangesOverlap(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
): boolean {
    return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function crossesDivider(
    a: Rect,
    b: Rect,
    dividers: Required<ColumnDetectionOptions>["dividerLines"],
    slop = DIVIDER_SLOP,
): boolean {
    if (dividers.length === 0) return false;

    for (const divider of dividers) {
        if (divider.orientation === "horizontal") {
            const lo = Math.min(a.y + a.h, b.y + b.h) - slop;
            const hi = Math.max(a.y, b.y) + slop;
            if (!(divider.position > lo && divider.position < hi)) continue;
            const dStart = divider.start - slop;
            const dEnd = divider.end + slop;
            if (
                rangesOverlap(dStart, dEnd, a.x, a.x + a.w) &&
                rangesOverlap(dStart, dEnd, b.x, b.x + b.w)
            ) {
                return true;
            }
        } else {
            const lo = Math.min(a.x + a.w, b.x + b.w) - slop;
            const hi = Math.max(a.x, b.x) + slop;
            if (!(divider.position > lo && divider.position < hi)) continue;
            const dStart = divider.start - slop;
            const dEnd = divider.end + slop;
            if (
                rangesOverlap(dStart, dEnd, a.y, a.y + a.h) &&
                rangesOverlap(dStart, dEnd, b.y, b.y + b.h)
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Phase 2: Merge adjacent blocks into columns.
 * Uses stricter criteria to prevent full-width blocks from merging with columns.
 *
 * Fill-zone guard (when `opts.fillBoundaries` is non-empty): every text
 * block is tagged with the index of the innermost fill rect that
 * contains it (or `null` for "outside all fills"). A merge is rejected
 * if the candidate's zone disagrees with the existing merged rect's
 * zone — text inside a tinted aside box never fuses with body text
 * outside it. The default-empty `fillBoundaries` array means PDFs
 * without colored containers are unaffected.
 */
function mergeBlocks(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): Rect[] {
    if (blocks.length === 0) return [];

    // Pre-compute the fill zone for each input block + a parallel array
    // for the growing merged set. Each merged rect inherits the zone of
    // the first block that seeded it; subsequent merges only join
    // blocks with the same zone (no re-derivation from the unioned
    // bbox — a union of two inside-fill blocks would unwittingly start
    // to span the fill itself and could mis-classify).
    const useZones = opts.fillBoundaries.length > 0;
    const blockZones = useZones
        ? blocks.map((b) => fillZoneFor(b, opts.fillBoundaries))
        : null;

    const mergedBlocks: Rect[] = [{ ...blocks[0] }];
    const mergedZones: (number | null)[] | null = useZones
        ? [blockZones![0]]
        : null;

    for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        const blockZone = blockZones ? blockZones[i] : null;
        let merged = false;

        // Try to merge with existing merged blocks
        for (let j = 0; j < mergedBlocks.length; j++) {
            const existingBlock = mergedBlocks[j];

            // Fill-zone guard — see comment on `mergeBlocks`.
            if (mergedZones && mergedZones[j] !== blockZone) {
                continue;
            }
            if (crossesDivider(block, existingBlock, opts.dividerLines)) {
                continue;
            }

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
            if (mergedZones) mergedZones.push(blockZone);
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
 * Heading-shape width threshold for the standalone-heading guard in
 * `canJoinAsShortAdjacent`. A short block whose width is at or below this
 * fraction of the host column counts as "heading-like enough" to be
 * checked against opposite-side section context. Picked broader than the
 * bridge merger's `2× narrower` heuristic so it catches multi-word
 * headings ("2. Methods", "Results and discussion", "Supplementary
 * methods") while still excluding ordinary indented first lines, which
 * sit at ~0.9 of the column width.
 */
const HEADING_LIKE_WIDTH_RATIO = 0.65;

/**
 * Body-shape width threshold for the away-side block in the standalone-
 * heading guard. Requires the away-side block to be at least this fraction
 * of the host's width before counting it as "another body block in the
 * same column" — which is what completes the section-heading sandwich
 * pattern. Keeps the guard from firing when the away-side block is itself
 * a short heading (e.g., a tail before the next section's heading).
 */
const BODY_SHAPE_WIDTH_RATIO = 0.7;

/**
 * Short-block-merge predicate.
 *
 * Absorbs a short narrow block (paragraph-end ragged tail OR paragraph-start
 * indented head) into an adjacent wider host column. Fires when:
 *   - the smaller-by-width block is horizontally CONTAINED in the wider one
 *     (paragraph indents and ragged tails are always contained, regardless
 *     of left-edge alignment);
 *   - the small block's height is ≤ maxBridgeHeight (= the same "short"
 *     threshold the bridge merger already uses), which excludes tall
 *     sidebars/abstracts (see ColumnDetector.test.ts case #6);
 *   - they sit immediately above OR below each other within a gap budget
 *     that scales with the small block's own height (so single-line lines
 *     get caught regardless of font size / leading).
 *
 * Standalone-heading guard: if `small` is above `large` AND `small` is
 * heading-shaped (≤ HEADING_LIKE_WIDTH_RATIO × `large.w`) AND the closest
 * block above `small` in `large`'s column is body-shaped (≥
 * BODY_SHAPE_WIDTH_RATIO × `large.w`) AND separated by a section-sized
 * gap (> `bridgeVerticalGap`), `small` is the heading at the start of a
 * new section sandwiched between two body blocks; reject the merge so the
 * heading stays its own column rect. The guard is asymmetric: the
 * heading-below-body mirror is geometrically unusual (headings precede
 * their content) and not represented in any current fixture; extend
 * symmetrically only when a real case demands it.
 */
function canJoinAsShortAdjacent(
    b1: Rect,
    b2: Rect,
    opts: Required<ColumnDetectionOptions>,
    allBlocks?: Rect[]
): boolean {
    const [small, large] = b1.w <= b2.w ? [b1, b2] : [b2, b1];
    if (!isHorizontallyContained(small, large, opts.edgeTolerance)) return false;
    if (small.h > opts.maxBridgeHeight) return false;
    const gapBudget = Math.max(opts.maxVerticalGap, 1.5 * small.h);
    const gapBelow = small.y - (large.y + large.h);
    const gapAbove = large.y - (small.y + small.h);
    if (gapBelow >= 0 && gapBelow <= gapBudget) return true;
    if (gapAbove >= 0 && gapAbove <= gapBudget) {
        if (allBlocks && looksLikeStandaloneHeadingAbove(small, large, allBlocks, opts)) {
            return false;
        }
        return true;
    }
    return false;
}

/**
 * Returns true when `small` sits above `large` and looks like a
 * standalone section heading: heading-shaped width, with a body-shaped
 * block in `large`'s column above `small` separated by a section-sized
 * gap. See `canJoinAsShortAdjacent` for the full rationale.
 */
function looksLikeStandaloneHeadingAbove(
    small: Rect,
    large: Rect,
    allBlocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): boolean {
    if (small.w > HEADING_LIKE_WIDTH_RATIO * large.w) return false;
    // Section headings sit flush with the column's left edge (same x as
    // the host body); indented paragraph first-lines are offset from the
    // column. Without this gate, the guard would reject legitimate
    // indented short heads when the prior block above is body-shaped and
    // separated by a section-sized gap (e.g. a section that begins
    // directly with an indented first paragraph after a title).
    const sameLeftEdgeAsHost =
        Math.abs(small.x - large.x) <= opts.edgeTolerance;
    if (!sameLeftEdgeAsHost) return false;

    const minBodyWidth = BODY_SHAPE_WIDTH_RATIO * large.w;
    let closestBottom = -Infinity;
    let closestIsBody = false;
    for (const block of allBlocks) {
        if (block === small || block === large) continue;
        const blockBottom = block.y + block.h;
        if (blockBottom > small.y) continue; // must be strictly above small
        if (blockBottom <= closestBottom) continue;
        if (!isInColumnOf(block, large, opts)) continue;
        closestBottom = blockBottom;
        closestIsBody = block.w >= minBodyWidth;
    }
    if (closestBottom === -Infinity) return false;
    if (!closestIsBody) return false;

    const gap = small.y - closestBottom;
    return gap > opts.bridgeVerticalGap;
}

/**
 * Same-column-as test for the standalone-heading guard. A block is in
 * `host`'s column if it shares a left or right edge within
 * `edgeTolerance`, OR has ≥ 70% horizontal overlap with the host. The
 * denominator is the host (not the candidate), so a narrow heading does
 * not give a loose neighborhood when scanning for body-shaped neighbors.
 */
function isInColumnOf(
    block: Rect,
    host: Rect,
    opts: Required<ColumnDetectionOptions>
): boolean {
    const sameLeft = Math.abs(block.x - host.x) <= opts.edgeTolerance;
    const sameRight =
        Math.abs(block.x + block.w - (host.x + host.w)) <= opts.edgeTolerance;
    if (sameLeft || sameRight) return true;
    return hasSignificantXOverlap(block, host, 0.7);
}

/**
 * Same-column-paragraphs predicate.
 *
 * Merges two TALL blocks (both h > maxBridgeHeight) that look like adjacent
 * paragraphs in the same column: same left edge, similar widths, small
 * vertical gap. Complementary to canJoinAsShortAdjacent (which handles the
 * short-block case): the "both tall" gate keeps this from firing on
 * heading-vs-body or abstract-vs-body shapes (those have one short side).
 *
 * The `widthRatio ≥ 0.85` gate further protects multi-column layouts where
 * a sidebar/abstract sits at the same x as a body column (e.g. QKFDM868).
 *
 * The gap budget is bumped slightly above the strict same-edge join's
 * maxVerticalGap because paragraph spacing in body text is often a hair
 * over 10pt (~12pt with 16pt line height).
 */
function canJoinAsSameColumnParagraphs(
    b1: Rect,
    b2: Rect,
    opts: Required<ColumnDetectionOptions>
): boolean {
    if (b1.h <= opts.maxBridgeHeight || b2.h <= opts.maxBridgeHeight) return false;
    if (Math.abs(b1.x - b2.x) > opts.edgeTolerance) return false;
    const widthRatio = Math.min(b1.w, b2.w) / Math.max(b1.w, b2.w);
    if (widthRatio < 0.85) return false;
    const gapBelow = b2.y - (b1.y + b1.h);
    const gapAbove = b1.y - (b2.y + b2.h);
    const gap = gapBelow >= 0 ? gapBelow : (gapAbove >= 0 ? gapAbove : -1);
    return gap >= 0 && gap <= opts.maxVerticalGap * 1.5;
}

/**
 * Phase 3: Join rectangles and normalize edges.
 * Does NOT do final reading order sorting - that's done in Phase 5.
 *
 * When `relaxed=true`, the iterative second pass also accepts tail merges
 * via canJoinAsShortAdjacent / canJoinAsSameColumnParagraphs. Used for the
 * post-bridge re-join so paragraph fragments separated only by an absorbed
 * bridge get reunited and trailing ragged-right tails get absorbed.
 *
 * `bridgeFlags` (Phase 4.5 only) records, for each block the bridge merger
 * produced, which side of the merged rect was a SHORT (heading-shape)
 * block. Strict same-edge merges and `canJoinAsSameColumnParagraphs` are
 * blocked when the merge would extend a bridge-expanded block in the
 * direction of an absorbed heading — that fuses the next section in (e.g.
 * UCZSE63I p28: body block bridge-merged past a "References" heading at
 * its bottom would otherwise grab the references list below). Merges in
 * the OPPOSITE direction stay enabled, so e.g. a chapter title absorbed
 * at the top of a body block doesn't block the body from joining the
 * next body paragraph below.
 */
function joinAndSort(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>,
    relaxed: boolean = false,
    bridgeFlags?: Map<Rect, BridgeFlags>
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

    // Helpers for bridge-expanded direction tracking. Phase 4 marks a
    // merged rect with `headingAtTop` / `headingAtBottom` when its bridge
    // merge absorbed a SHORT (heading-shape) block on that side.
    const flagsOf = (r: Rect): BridgeFlags =>
        bridgeFlags?.get(r) ?? { headingAtTop: false, headingAtBottom: false };

    // Fill-zone guard. Symmetric with the Phase-2 mergeBlocks check —
    // never fuse two rects whose innermost containing fill rect
    // differs. Without this, Phase 3/4.5's same-edge / relaxed merges
    // can re-cross the boundary that Phase 2 was careful to preserve.
    const useFillZones = opts.fillBoundaries.length > 0;
    const crossesFillZone = (a: Rect, b: Rect): boolean => {
        if (!useFillZones) return false;
        return (
            fillZoneFor(a, opts.fillBoundaries) !==
            fillZoneFor(b, opts.fillBoundaries)
        );
    };
    const crossesLayoutDivider = (a: Rect, b: Rect): boolean =>
        crossesDivider(a, b, opts.dividerLines);

    /**
     * Should we block a merge between `upper` (lower y) and `lower`
     * (greater y) because of a bridge-absorbed heading at the boundary
     * between them? Returns true if either:
     *   - upper has `headingAtBottom` (its bottom is a section break)
     *   - lower has `headingAtTop` (its top is a section break)
     */
    const crossesBridgeBoundary = (upper: Rect, lower: Rect): boolean => {
        if (!bridgeFlags) return false;
        return flagsOf(upper).headingAtBottom || flagsOf(lower).headingAtTop;
    };

    /**
     * After merging two blocks vertically, propagate the OUTER bridge
     * flags onto the union: the union's top side is the upper block's
     * top, its bottom side is the lower block's bottom. The boundary
     * between them disappears in the union, so any flag on that internal
     * side is irrelevant for future merges.
     */
    const propagateFlags = (upper: Rect, lower: Rect, child: Rect): void => {
        if (!bridgeFlags) return;
        const upperFlags = flagsOf(upper);
        const lowerFlags = flagsOf(lower);
        const childFlags: BridgeFlags = {
            headingAtTop: upperFlags.headingAtTop,
            headingAtBottom: lowerFlags.headingAtBottom,
        };
        if (childFlags.headingAtTop || childFlags.headingAtBottom) {
            bridgeFlags.set(child, childFlags);
        }
    };

    // Join vertically adjacent rectangles with similar edges
    // This is more thorough - try to join with ANY existing block, not just previous
    const joined: Rect[] = [];

    for (const block of blocks) {
        let mergedWithExisting = false;

        for (let j = 0; j < joined.length; j++) {
            const existingBlock = joined[j];

            if (crossesFillZone(block, existingBlock)) continue;
            if (crossesLayoutDivider(block, existingBlock)) continue;

            // Check if blocks have similar left and right edges
            const sameLeftEdge = Math.abs(block.x - existingBlock.x) <= opts.edgeTolerance;
            const sameRightEdge =
                Math.abs(block.x + block.w - (existingBlock.x + existingBlock.w)) <= opts.edgeTolerance;

            if (!sameLeftEdge || !sameRightEdge) continue;

            // Check vertical adjacency (block is below existing, with small gap)
            const gapBelow = block.y - (existingBlock.y + existingBlock.h);
            const gapAbove = existingBlock.y - (block.y + block.h);

            const blockBelow = gapBelow >= 0 && gapBelow <= opts.maxVerticalGap;
            const blockAbove = gapAbove >= 0 && gapAbove <= opts.maxVerticalGap;

            if (!blockBelow && !blockAbove) continue;

            // In the post-bridge pass, skip strict merges that would extend
            // a bridge-expanded block past an absorbed heading boundary —
            // see comment on `joinAndSort`. Direction-aware so e.g. a body
            // block whose top absorbed a chapter heading can still merge
            // with the next body paragraph below it (CZAA39JT p0), but a
            // body block whose bottom absorbed a "References" heading
            // can't grab the references list below (UCZSE63I p28).
            if (relaxed) {
                const upper = blockBelow ? existingBlock : block;
                const lower = blockBelow ? block : existingBlock;
                if (crossesBridgeBoundary(upper, lower)) continue;
            }

            const upper = blockBelow ? existingBlock : block;
            const lower = blockBelow ? block : existingBlock;
            const merged = unionRect(existingBlock, block);
            propagateFlags(upper, lower, merged);
            joined[j] = merged;
            mergedWithExisting = true;
            break;
        }

        if (!mergedWithExisting) {
            // Preserve the original reference when it carries bridge flags
            // so the tracking map keeps working; otherwise copy as before.
            if (bridgeFlags?.has(block)) {
                joined.push(block);
            } else {
                joined.push({ ...block });
            }
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

                if (crossesFillZone(block1, block2)) continue;
                if (crossesLayoutDivider(block1, block2)) continue;

                // Strict same-edge merge (always enabled).
                const sameLeftEdge = Math.abs(block1.x - block2.x) <= opts.edgeTolerance;
                const sameRightEdge =
                    Math.abs(block1.x + block1.w - (block2.x + block2.w)) <= opts.edgeTolerance;
                const gapBelow = block2.y - (block1.y + block1.h);
                const gapAbove = block1.y - (block2.y + block2.h);
                const adjacentStrict =
                    (gapBelow >= 0 && gapBelow <= opts.maxVerticalGap) ||
                    (gapAbove >= 0 && gapAbove <= opts.maxVerticalGap);
                let strictMerge = sameLeftEdge && sameRightEdge && adjacentStrict;

                // Identify upper / lower for boundary check (only meaningful
                // when blocks are vertically adjacent).
                const block1IsUpper = gapBelow >= 0;
                const upper = block1IsUpper ? block1 : block2;
                const lower = block1IsUpper ? block2 : block1;

                // In the post-bridge pass, skip strict / same-column-paragraphs
                // merges that would cross a bridge-expanded heading boundary.
                if (relaxed && adjacentStrict && crossesBridgeBoundary(upper, lower)) {
                    strictMerge = false;
                }

                // Relaxed merges (only enabled in the post-bridge re-run):
                //  - canJoinAsShortAdjacent: short narrow tails / indented
                //    paragraph-start heads, contained in adjacent wider
                //    host. Allowed across bridge-expanded blocks because
                //    absorbing a small tail doesn't cross another section.
                //  - canJoinAsSameColumnParagraphs: two tall same-column
                //    paragraph blocks separated by a small gap. Skipped
                //    when the gap crosses a bridge-expanded heading
                //    boundary (UCZSE63I p28: body-after-heading mustn't
                //    grab the next-section first block).
                const sameColumnAllowed =
                    canJoinAsSameColumnParagraphs(block1, block2, opts) &&
                    !(relaxed && crossesBridgeBoundary(upper, lower));
                const relaxedMerge =
                    relaxed &&
                    (canJoinAsShortAdjacent(block1, block2, opts, joined) ||
                     sameColumnAllowed);

                if (!strictMerge && !relaxedMerge) continue;

                // Safety guard for relaxed merges: the union must not swallow
                // any non-participating block. Strict same-edge merges sit on
                // top of each other and can't extend laterally, so they don't
                // need this check, but relaxed merges grow the host vertically
                // and could otherwise cover a sibling rect.
                const unionBlock = unionRect(block1, block2);
                if (relaxedMerge && !strictMerge) {
                    const intersectsOthers = joined.some(
                        (other, idx) =>
                            idx !== i &&
                            idx !== j &&
                            rectsIntersect(unionBlock, other)
                    );
                    if (intersectsOthers) continue;
                }

                propagateFlags(upper, lower, unionBlock);
                joined[i] = unionBlock;
                joined.splice(j, 1);
                changed = true;
                break;
            }
            if (changed) break;
        }
    }

    return joined;
}

// Column gutters in journals are typically >= 10pt; smaller cuts are noise.
const MIN_V_CUT_GAP = 8;
// Cuts smaller than this within a merged column are paragraph-spacing noise.
const MIN_H_CUT_GAP = 8;

// Hard ceiling on xy-cut recursion depth.
const MAX_XYCUT_DEPTH = 400;

/**
 * Phase 5: Sort blocks for proper reading order (critical for multi-column).
 *
 * Vertical-first recursive XY-cut: a clean vertical whitespace cut wins
 * over any horizontal cut, so columns drive the reading order whenever
 * the layout permits. A horizontal cut is only taken when a wide spanning
 * element (title, caption, full-width figure) blocks vertical
 * partitioning. With neither axis cuttable, fall back to (y, x) sort.
 */
function sortForReadingOrder(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>
): Rect[] {
    if (blocks.length <= 1) return blocks.slice();
    return xyCut(blocks, opts);
}

function xyCut(
    blocks: Rect[],
    opts?: Required<ColumnDetectionOptions>,
    depth = 0,
): Rect[] {
    if (blocks.length <= 1) return blocks.slice();

    // Depth guard: a pathological page can recurse O(n) deep and blow the
    // worker JS stack ("too much recursion"). Past the ceiling, give up on
    // further partitioning and fall back to a plain reading-order sort.
    if (depth >= MAX_XYCUT_DEPTH) {
        return [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
    }

    if (opts && opts.dividerLines.length > 0) {
        const dividerCut = findDividerCut(blocks, opts);
        if (dividerCut) {
            return [
                ...xyCut(dividerCut.first, opts, depth + 1),
                ...xyCut(dividerCut.second, opts, depth + 1),
            ];
        }
    }

    const vCut = findCleanCut(blocks, "x", MIN_V_CUT_GAP);
    if (vCut) {
        return [
            ...xyCut(vCut.first, opts, depth + 1),
            ...xyCut(vCut.second, opts, depth + 1),
        ];
    }

    const hCut = findCleanCut(blocks, "y", MIN_H_CUT_GAP);
    if (hCut) {
        return [
            ...xyCut(hCut.first, opts, depth + 1),
            ...xyCut(hCut.second, opts, depth + 1),
        ];
    }

    return [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
}

function findDividerCut(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>,
): { axis: "x" | "y"; position: number; first: Rect[]; second: Rect[] } | null {
    if (blocks.length <= 1 || opts.dividerLines.length === 0) return null;

    const bundle = blocks.reduce<Rect | null>((acc, block) => unionRect(acc, block), null);
    if (!bundle) return null;
    const minX = bundle.x;
    const maxX = bundle.x + bundle.w;
    const minY = bundle.y;
    const maxY = bundle.y + bundle.h;

    type Candidate = {
        axis: "x" | "y";
        position: number;
        coverage: number;
        first: Rect[];
        second: Rect[];
    };
    const candidates: Candidate[] = [];

    for (const divider of opts.dividerLines) {
        if (divider.orientation === "horizontal") {
            if (
                divider.position <= minY + DIVIDER_SLOP ||
                divider.position >= maxY - DIVIDER_SLOP
            ) {
                continue;
            }
            const crossExtent = maxX - minX;
            if (crossExtent <= 0) continue;
            const covered =
                Math.min(maxX, divider.end) - Math.max(minX, divider.start);
            const coverage = Math.max(0, covered) / crossExtent;
            if (coverage < 0.8) continue;
            const first: Rect[] = [];
            const second: Rect[] = [];
            let straddles = false;
            for (const block of blocks) {
                if (block.y + block.h <= divider.position + DIVIDER_SLOP) {
                    first.push(block);
                } else if (block.y >= divider.position - DIVIDER_SLOP) {
                    second.push(block);
                } else {
                    straddles = true;
                    break;
                }
            }
            if (!straddles && first.length > 0 && second.length > 0) {
                candidates.push({
                    axis: "y",
                    position: divider.position,
                    coverage,
                    first,
                    second,
                });
            }
        } else {
            if (
                divider.position <= minX + DIVIDER_SLOP ||
                divider.position >= maxX - DIVIDER_SLOP
            ) {
                continue;
            }
            const crossExtent = maxY - minY;
            if (crossExtent <= 0) continue;
            const covered =
                Math.min(maxY, divider.end) - Math.max(minY, divider.start);
            const coverage = Math.max(0, covered) / crossExtent;
            if (coverage < 0.8) continue;
            const first: Rect[] = [];
            const second: Rect[] = [];
            let straddles = false;
            for (const block of blocks) {
                if (block.x + block.w <= divider.position + DIVIDER_SLOP) {
                    first.push(block);
                } else if (block.x >= divider.position - DIVIDER_SLOP) {
                    second.push(block);
                } else {
                    straddles = true;
                    break;
                }
            }
            if (!straddles && first.length > 0 && second.length > 0) {
                candidates.push({
                    axis: "x",
                    position: divider.position,
                    coverage,
                    first,
                    second,
                });
            }
        }
    }

    if (candidates.length === 0) return null;
    const midFor = (candidate: Candidate) =>
        candidate.axis === "y" ? (minY + maxY) / 2 : (minX + maxX) / 2;
    candidates.sort((a, b) => {
        const coverageDelta = b.coverage - a.coverage;
        if (Math.abs(coverageDelta) > 1e-9) return coverageDelta;
        const aMid = Math.abs(a.position - midFor(a));
        const bMid = Math.abs(b.position - midFor(b));
        if (Math.abs(aMid - bMid) > 1e-9) return aMid - bMid;
        return a.position - b.position;
    });

    const best = candidates[0];
    return {
        axis: best.axis,
        position: best.position,
        first: best.first,
        second: best.second,
    };
}

/**
 * Zone-aware reading-order sort. Each fill zone (background-shaded
 * display element) is treated as ONE virtual block in the outer xy-cut
 * traversal; the cut therefore never slices a zone in half just because
 * the colored container has a clean inner column gutter. Inside each
 * zone we run xy-cut on its members, so the zone's own multi-column
 * layout still flows correctly.
 */
function sortForReadingOrderWithZones(
    blocks: Rect[],
    opts: Required<ColumnDetectionOptions>,
): Rect[] {
    if (blocks.length <= 1) return blocks.slice();
    if (opts.fillBoundaries.length === 0) return xyCut(blocks, opts);

    // Group each block by its innermost fill zone (or "outside" =
    // index -1). Same zone-id semantics as Phase 2's mergeBlocks guard,
    // so a block can't end up on the wrong side of a zone boundary in
    // one phase but the right side in the other.
    const zoneIdOf = new Map<Rect, number | null>();
    for (const b of blocks) {
        zoneIdOf.set(b, fillZoneFor(b, opts.fillBoundaries));
    }
    const zoneToMembers = new Map<number, Rect[]>();
    const outsideMembers: Rect[] = [];
    for (const b of blocks) {
        const z = zoneIdOf.get(b)!;
        if (z === null) {
            outsideMembers.push(b);
        } else {
            const arr = zoneToMembers.get(z);
            if (arr) arr.push(b);
            else zoneToMembers.set(z, [b]);
        }
    }

    // Build virtual super-rects: one per non-empty zone, plus every
    // outside block as a single-member virtual. The zone's super-rect
    // is the union of its members (not the raw fill bbox) so the outer
    // xy-cut only sees the *text-occupied* footprint — the fill might
    // extend beyond its content, which would otherwise pull spurious
    // overlaps with neighboring outside blocks.
    interface VirtualEntry { rect: Rect; members: Rect[] }
    const virtuals: VirtualEntry[] = [];
    for (const block of outsideMembers) {
        virtuals.push({ rect: block, members: [block] });
    }
    for (const [, members] of zoneToMembers) {
        if (members.length === 0) continue;
        let unioned: Rect | null = null;
        for (const m of members) unioned = unionRect(unioned, m);
        if (unioned) virtuals.push({ rect: unioned, members });
    }

    if (virtuals.length <= 1) {
        const only = virtuals[0];
        if (!only) return [];
        return only.members.length === 1 ? only.members.slice() : xyCut(only.members, opts);
    }

    // Outer xy-cut on the super-rects, then expand each virtual back to
    // its members (recursively xy-cut for multi-member zones).
    const virtualRects = virtuals.map((v) => v.rect);
    const lookup = new Map<Rect, VirtualEntry>();
    for (const v of virtuals) lookup.set(v.rect, v);
    const outerOrder = xyCut(virtualRects, opts);
    const result: Rect[] = [];
    for (const v of outerOrder) {
        const entry = lookup.get(v);
        if (!entry) continue;
        if (entry.members.length === 1) {
            result.push(entry.members[0]);
        } else {
            // Inside-zone reading order — plain xy-cut. The zone's own
            // multi-column gutter is now legitimate to slice on (no
            // outside content can cross it because we're already
            // committed to this zone's bbox).
            result.push(...xyCut(entry.members, opts));
        }
    }
    return result;
}

function findCleanCut(
    blocks: Rect[],
    axis: "x" | "y",
    minGap: number
): { gap: number; first: Rect[]; second: Rect[] } | null {
    const start = (b: Rect) => (axis === "x" ? b.x : b.y);
    const end = (b: Rect) => (axis === "x" ? b.x + b.w : b.y + b.h);

    const sorted = [...blocks].sort((a, b) => start(a) - start(b));

    let bestGap = 0;
    let bestIdx = -1;
    let maxEnd = end(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
        const gap = start(sorted[i]) - maxEnd;
        if (gap > bestGap) {
            bestGap = gap;
            bestIdx = i;
        }
        if (end(sorted[i]) > maxEnd) maxEnd = end(sorted[i]);
    }

    if (bestIdx < 0 || bestGap < minGap) return null;
    return {
        gap: bestGap,
        first: sorted.slice(0, bestIdx),
        second: sorted.slice(bestIdx),
    };
}

/**
 * Log column detection results for debugging.
 * Only logs when {@link ExtractionSettings.analyzerLogging} is enabled.
 */
export function logColumnDetection(
    pageIndex: number,
    result: ColumnDetectionResult
): void {
    if (!isAnalyzerLoggingEnabled()) return;

    pdfLog(
        `[ColumnDetector] Page ${pageIndex}: ${result.columnCount} column(s) detected` +
            (result.isBroken ? " [BROKEN]" : ""),
        3,
    );

    if (result.columns.length > 0) {
        for (let i = 0; i < result.columns.length; i++) {
            const col = result.columns[i];
            pdfLog(
                `    Column ${i + 1}: x=${col.x.toFixed(0)}, y=${col.y.toFixed(0)}, ` +
                    `w=${col.w.toFixed(0)}, h=${col.h.toFixed(0)}`,
                3,
            );
        }
    }
}
