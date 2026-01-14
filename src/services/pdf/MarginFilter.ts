/**
 * Margin Filter
 *
 * Handles margin-based filtering of text content:
 * 1. Simple filtering: Exclude content entirely within margin thresholds
 * 2. Smart filtering: Identify and remove repeating elements in margin zones
 */

import type {
    RawPageData,
    RawLine,
    RawBBox,
    MarginSettings,
    MarginPosition,
    MarginElement,
    MarginAnalysis,
    RemovalCandidate,
    MarginRemovalResult,
} from "./types";

// ============================================================================
// Page Number Detection Patterns
// ============================================================================

/** Patterns for detecting page numbers */
const PAGE_NUMBER_PATTERNS = [
    /^\d+$/,                          // Pure digits: "1", "42", "100"
    /^page\s*\d+$/i,                  // "Page 1", "page42"
    /^p\.?\s*\d+$/i,                  // "P. 1", "p1"
    /^\d+\s*(of|\/|-)\s*\d+$/i,       // "1 of 10", "5/20", "3-15"
    /^[ivxlcdm]+$/i,                  // Roman numerals: "iv", "XII"
];

/** Check if text matches a page number pattern */
function isPageNumberPattern(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return PAGE_NUMBER_PATTERNS.some(pattern => pattern.test(normalized));
}

/** Parse numeric value from page-like text (returns null if not parseable) */
function parsePageNumber(text: string): number | null {
    const normalized = text.trim().toLowerCase();
    
    // Pure digits
    if (/^\d+$/.test(normalized)) {
        return parseInt(normalized, 10);
    }
    
    // "Page X" or "P. X" patterns
    const match = normalized.match(/(?:page|p\.?)\s*(\d+)/i);
    if (match) {
        return parseInt(match[1], 10);
    }
    
    // Roman numerals (simplified - just common ones)
    const romanMap: Record<string, number> = {
        i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
        xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
    };
    if (romanMap[normalized] !== undefined) {
        return romanMap[normalized];
    }
    
    return null;
}

/** Check if numbers form a strictly increasing sequence */
function isIncreasingSequence(numbers: number[]): boolean {
    if (numbers.length < 2) return false;
    for (let i = 1; i < numbers.length; i++) {
        if (numbers[i] <= numbers[i - 1]) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// Margin Zone Detection
// ============================================================================

/**
 * Check if a bounding box is ENTIRELY within a specific margin zone.
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

    const inTop = y1 <= margins.top;
    const inBottom = y0 >= pageHeight - margins.bottom;
    const inLeft = x1 <= margins.left;
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

    if (y1 <= margins.top) return "top";
    if (y0 >= pageHeight - margins.bottom) return "bottom";
    if (x1 <= margins.left) return "left";
    if (x0 >= pageWidth - margins.right) return "right";

    return null;
}

/** Normalize text for comparison */
function normalizeText(text: string): string {
    return text.trim().toLowerCase();
}

// ============================================================================
// MarginFilter Class
// ============================================================================

/**
 * MarginFilter class for handling margin-based content filtering.
 */
export class MarginFilter {
    /**
     * Simple filter: Check if a line is inside the content area.
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
     * Simple filter: Filter a page's lines to exclude those entirely in margins.
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
                    const trimmedText = (line.text || "").trim();
                    if (!trimmedText) continue;

                    const position = getMarginPosition(
                        line.bbox,
                        page.width,
                        page.height,
                        marginZone
                    );

                    if (position) {
                        elements.get(position)!.push({
                            text: trimmedText,
                            position,
                            bbox: line.bbox,
                            pageIndex: page.pageIndex,
                            line,
                        });
                    }
                }
            }
        }

        const counts: Record<MarginPosition, number> = {
            top: elements.get("top")!.length,
            bottom: elements.get("bottom")!.length,
            left: elements.get("left")!.length,
            right: elements.get("right")!.length,
        };

        return { elements, counts };
    }

    /**
     * Identify elements to remove based on frequency and page number detection.
     *
     * @param analysis - Margin analysis results
     * @param requiredCount - Minimum pages for text to be considered repeating
     * @param detectPageSequences - Whether to detect page number sequences
     * @returns Removal result with candidates and lookup structures
     */
    static identifyElementsToRemove(
        analysis: MarginAnalysis,
        requiredCount: number = 3,
        detectPageSequences: boolean = true
    ): MarginRemovalResult {
        const candidates: RemovalCandidate[] = [];
        const textsToRemove = new Set<string>();
        const removalsByPage = new Map<number, Set<string>>();

        // Process each margin position
        for (const [position, elements] of analysis.elements) {
            // Group by normalized text
            const textGroups = new Map<string, { original: string; pageIndices: Set<number> }>();

            for (const el of elements) {
                const normalized = normalizeText(el.text);
                const existing = textGroups.get(normalized);

                if (existing) {
                    existing.pageIndices.add(el.pageIndex);
                } else {
                    textGroups.set(normalized, {
                        original: el.text,
                        pageIndices: new Set([el.pageIndex]),
                    });
                }
            }

            // Identify repeating elements (frequency >= requiredCount)
            for (const [normalized, { original, pageIndices }] of textGroups) {
                if (pageIndices.size >= requiredCount) {
                    const pages = Array.from(pageIndices).sort((a, b) => a - b);

                    candidates.push({
                        text: normalized,
                        originalText: original,
                        pageIndices: pages,
                        reason: "repeat",
                        position,
                    });

                    textsToRemove.add(normalized);

                    // Add to per-page lookup
                    for (const pageIdx of pages) {
                        if (!removalsByPage.has(pageIdx)) {
                            removalsByPage.set(pageIdx, new Set());
                        }
                        removalsByPage.get(pageIdx)!.add(normalized);
                    }
                }
            }

            // Detect page number sequences
            if (detectPageSequences) {
                // Collect elements that match page number patterns
                const pageNumberElements: { el: MarginElement; value: number }[] = [];

                for (const el of elements) {
                    if (isPageNumberPattern(el.text)) {
                        const value = parsePageNumber(el.text);
                        if (value !== null) {
                            pageNumberElements.push({ el, value });
                        }
                    }
                }

                if (pageNumberElements.length >= requiredCount) {
                    // Sort by page index
                    pageNumberElements.sort((a, b) => a.el.pageIndex - b.el.pageIndex);

                    // Check if values form an increasing sequence
                    const values = pageNumberElements.map(p => p.value);
                    
                    if (isIncreasingSequence(values)) {
                        // These are page numbers - mark all for removal
                        const pageIndices = pageNumberElements.map(p => p.el.pageIndex);

                        // Group by normalized text to avoid duplicates
                        const seenTexts = new Set<string>();
                        for (const { el } of pageNumberElements) {
                            const normalized = normalizeText(el.text);
                            
                            if (!seenTexts.has(normalized) && !textsToRemove.has(normalized)) {
                                seenTexts.add(normalized);
                                
                                candidates.push({
                                    text: normalized,
                                    originalText: el.text,
                                    pageIndices: [el.pageIndex],
                                    reason: "page_number",
                                    position,
                                });
                            }

                            textsToRemove.add(normalized);

                            if (!removalsByPage.has(el.pageIndex)) {
                                removalsByPage.set(el.pageIndex, new Set());
                            }
                            removalsByPage.get(el.pageIndex)!.add(normalized);
                        }

                        // Log the page number sequence detection (development only)
                        if (process.env.NODE_ENV === "development") {
                            console.log(`[MarginFilter] Detected page number sequence in ${position} zone: ${values.slice(0, 5).join(", ")}...`);
                        }
                    }
                }
            }
        }

        return { candidates, textsToRemove, removalsByPage };
    }

    /**
     * Filter a page using smart removal results.
     * Removes lines that match identified repeating/page-number elements.
     */
    static filterPageWithSmartRemoval(
        page: RawPageData,
        margins: MarginSettings,
        marginZone: MarginSettings,
        removalResult: MarginRemovalResult
    ): RawPageData {
        const pageRemovals = removalResult.removalsByPage.get(page.pageIndex);

        const filteredBlocks = page.blocks.map(block => {
            if (block.type !== "text" || !block.lines) {
                return block;
            }

            const filteredLines = block.lines.filter(line => {
                // Always remove if entirely in simple margins
                if (!this.isInsideContentArea(line, page.width, page.height, margins)) {
                    return false;
                }

                // Check if line is in margin zone and matches removal candidate
                if (pageRemovals && pageRemovals.size > 0) {
                    const position = getMarginPosition(
                        line.bbox,
                        page.width,
                        page.height,
                        marginZone
                    );

                    if (position) {
                        const normalized = normalizeText(line.text || "");
                        if (pageRemovals.has(normalized)) {
                            return false;
                        }
                    }
                }

                return true;
            });

            return {
                ...block,
                lines: filteredLines,
            };
        }).filter(block => {
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
     * Log what elements will be removed.
     * Only logs in development mode.
     */
    static logRemovalCandidates(result: MarginRemovalResult): void {
        if (process.env.NODE_ENV !== "development") return;

        if (result.candidates.length === 0) {
            console.log("[MarginFilter] No margin elements identified for removal");
            return;
        }

        console.log(`[MarginFilter] Identified ${result.candidates.length} elements for removal:`);

        // Group by position for cleaner output
        const byPosition = new Map<MarginPosition, RemovalCandidate[]>();
        for (const candidate of result.candidates) {
            if (!byPosition.has(candidate.position)) {
                byPosition.set(candidate.position, []);
            }
            byPosition.get(candidate.position)!.push(candidate);
        }

        for (const [position, candidates] of byPosition) {
            console.log(`\n  ${position.toUpperCase()} zone:`);

            for (const candidate of candidates) {
                const pages = candidate.pageIndices;
                const pageStr = pages.length > 10
                    ? `pages ${pages.slice(0, 5).join(", ")}... (${pages.length} total)`
                    : `pages ${pages.join(", ")}`;
                
                const reasonTag = candidate.reason === "page_number" ? " [PAGE#]" : "";
                const displayText = candidate.originalText.slice(0, 50);

                console.log(`    "${displayText}"${reasonTag} (${pageStr})`);
            }
        }
    }
}
