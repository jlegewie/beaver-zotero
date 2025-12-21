/**
 * Margin Filter
 *
 * Handles margin-based filtering of text content:
 * 1. Simple filtering: Exclude content outside margin thresholds
 * 2. Smart filtering: Collect elements in margin zones for analysis
 */

import type {
    RawPageData,
    RawLine,
    RawBBox,
    MarginSettings,
    MarginPosition,
    MarginElement,
    MarginAnalysis,
} from "./types";

/**
 * Check if a bounding box is ENTIRELY within a specific margin zone.
 * The element must be fully contained in the margin area.
 *
 * For margins:
 * - Left: entire element (including right edge) must be within left margin
 * - Right: entire element (including left edge) must be within right margin
 * - Top: entire element (including bottom edge) must be within top margin
 * - Bottom: entire element (including top edge) must be within bottom margin
 *
 * @param bbox - Element bounding box
 * @param pageWidth - Page width in points
 * @param pageHeight - Page height in points
 * @param margins - Margin thresholds
 * @param position - Which margin to check (or undefined for any)
 * @returns true if element is entirely within the specified margin zone
 */
function isEntirelyInMarginZone(
    bbox: RawBBox,
    pageWidth: number,
    pageHeight: number,
    margins: MarginSettings,
    position?: MarginPosition
): boolean {
    const x0 = bbox.x;
    const y0 = bbox.y;
    const x1 = bbox.x + bbox.w;
    const y1 = bbox.y + bbox.h;

    // Check if element is ENTIRELY within each margin zone
    // For top: bottom edge (y1) must be within top margin
    const inTop = y1 <= margins.top;
    // For bottom: top edge (y0) must be within bottom margin zone
    const inBottom = y0 >= pageHeight - margins.bottom;
    // For left: right edge (x1) must be within left margin
    const inLeft = x1 <= margins.left;
    // For right: left edge (x0) must be within right margin zone
    const inRight = x0 >= pageWidth - margins.right;

    if (position) {
        switch (position) {
            case "top": return inTop;
            case "bottom": return inBottom;
            case "left": return inLeft;
            case "right": return inRight;
        }
    }

    return inTop || inBottom || inLeft || inRight;
}

/**
 * Determine which margin zone an element is ENTIRELY within.
 * Returns the primary position (prioritizes top/bottom over left/right).
 * Element must be fully contained in the margin zone.
 */
function getMarginPosition(
    bbox: RawBBox,
    pageWidth: number,
    pageHeight: number,
    margins: MarginSettings
): MarginPosition | null {
    const y0 = bbox.y;
    const y1 = bbox.y + bbox.h;
    const x0 = bbox.x;
    const x1 = bbox.x + bbox.w;

    // Prioritize top/bottom (more common for headers/footers)
    // Element must be ENTIRELY within the margin zone
    if (y1 <= margins.top) return "top";
    if (y0 >= pageHeight - margins.bottom) return "bottom";
    if (x1 <= margins.left) return "left";
    if (x0 >= pageWidth - margins.right) return "right";

    return null;
}

/**
 * MarginFilter class for handling margin-based content filtering.
 */
export class MarginFilter {
    /**
     * Simple filter: Check if a line is inside the content area (not entirely in margins).
     *
     * @param line - The line to check
     * @param pageWidth - Page width in points
     * @param pageHeight - Page height in points
     * @param margins - Margin thresholds
     * @returns true if line is inside content area (should be kept)
     */
    static isInsideContentArea(
        line: RawLine,
        pageWidth: number,
        pageHeight: number,
        margins: MarginSettings
    ): boolean {
        return !isEntirelyInMarginZone(line.bbox, pageWidth, pageHeight, margins);
    }

    /**
     * Simple filter: Filter a page's lines to exclude those in margins.
     *
     * @param page - Raw page data
     * @param margins - Margin thresholds
     * @returns Filtered page with lines outside margins removed
     */
    static filterPageByMargins(
        page: RawPageData,
        margins: MarginSettings
    ): RawPageData {
        const filteredBlocks = page.blocks.map(block => {
            if (block.type !== "text" || !block.lines) {
                return block;
            }

            const filteredLines = block.lines.filter(line =>
                this.isInsideContentArea(line, page.width, page.height, margins)
            );

            return {
                ...block,
                lines: filteredLines,
            };
        }).filter(block => {
            // Remove empty text blocks
            if (block.type === "text") {
                return block.lines && block.lines.length > 0;
            }
            return true;
        });

        return {
            ...page,
            blocks: filteredBlocks,
        };
    }

    /**
     * Smart filter: Collect all elements in margin zones for analysis.
     * This is the first step of smart filtering - gather candidates.
     *
     * @param pages - All raw page data
     * @param marginZone - Margin zone thresholds (larger than simple margins)
     * @returns Analysis of elements in margin zones
     */
    static collectMarginElements(
        pages: RawPageData[],
        marginZone: MarginSettings
    ): MarginAnalysis {
        const elements = new Map<MarginPosition, MarginElement[]>([
            ["top", []],
            ["bottom", []],
            ["left", []],
            ["right", []],
        ]);

        for (const page of pages) {
            for (const block of page.blocks) {
                if (block.type !== "text" || !block.lines) continue;

                for (const line of block.lines) {
                    // Skip empty or whitespace-only text
                    const trimmedText = (line.text || "").trim();
                    if (!trimmedText) continue;

                    const position = getMarginPosition(
                        line.bbox,
                        page.width,
                        page.height,
                        marginZone
                    );

                    if (position) {
                        const element: MarginElement = {
                            text: trimmedText,
                            position,
                            bbox: line.bbox,
                            pageIndex: page.pageIndex,
                            line,
                        };

                        elements.get(position)!.push(element);
                    }
                }
            }
        }

        // Calculate counts
        const counts: Record<MarginPosition, number> = {
            top: elements.get("top")!.length,
            bottom: elements.get("bottom")!.length,
            left: elements.get("left")!.length,
            right: elements.get("right")!.length,
        };

        return { elements, counts };
    }

    /**
     * Log margin analysis for debugging.
     * Shows what elements were found in each margin zone.
     */
    static logMarginAnalysis(analysis: MarginAnalysis): void {
        console.log("[MarginFilter] Margin zone analysis:");
        console.log(`  Top zone: ${analysis.counts.top} elements`);
        console.log(`  Bottom zone: ${analysis.counts.bottom} elements`);
        console.log(`  Left zone: ${analysis.counts.left} elements`);
        console.log(`  Right zone: ${analysis.counts.right} elements`);

        // Log sample of elements per zone
        for (const [position, elements] of analysis.elements) {
            if (elements.length > 0) {
                console.log(`\n[MarginFilter] ${position.toUpperCase()} zone elements:`);

                // Group by unique text to show frequency
                const textCounts = new Map<string, number>();
                for (const el of elements) {
                    const text = el.text.trim().slice(0, 50); // Truncate for display
                    textCounts.set(text, (textCounts.get(text) || 0) + 1);
                }

                // Show top 5 most frequent
                const sorted = Array.from(textCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5);

                for (const [text, count] of sorted) {
                    console.log(`    "${text}" (${count} occurrences)`);
                }
            }
        }
    }
}

