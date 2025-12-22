/**
 * Page Extractor
 *
 * Processes raw page data into clean, structured text.
 * Handles:
 * - Column-aware text extraction (reading order)
 * - Line joining and hyphenation
 * - Block classification
 * - Margin-based filtering
 * - Paragraph reconstruction
 */

import type {
    RawPageData,
    RawBlock,
    RawLine,
    RawBBox,
    ProcessedPage,
    ProcessedBlock,
    ProcessedLine,
    StyleProfile,
    TextStyle,
    MarginSettings,
    ColumnBBox,
} from "./types";
import { styleToKey } from "./types";
import { StyleAnalyzer } from "./StyleAnalyzer";
import { MarginFilter } from "./MarginFilter";
import type { Rect, ColumnDetectionResult } from "./ColumnDetector";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate the overlap ratio between a block and a column.
 * Returns the fraction of the block's area that falls within the column.
 */
function calculateOverlapRatio(blockBBox: RawBBox, column: Rect): number {
    // Calculate intersection
    const xOverlapStart = Math.max(blockBBox.x, column.x);
    const xOverlapEnd = Math.min(blockBBox.x + blockBBox.w, column.x + column.w);
    const yOverlapStart = Math.max(blockBBox.y, column.y);
    const yOverlapEnd = Math.min(blockBBox.y + blockBBox.h, column.y + column.h);

    // No overlap if any dimension is negative
    if (xOverlapEnd <= xOverlapStart || yOverlapEnd <= yOverlapStart) {
        return 0;
    }

    const overlapArea = (xOverlapEnd - xOverlapStart) * (yOverlapEnd - yOverlapStart);
    const blockArea = blockBBox.w * blockBBox.h;

    return blockArea > 0 ? overlapArea / blockArea : 0;
}

/**
 * Check if a block belongs to a column.
 * Uses overlap ratio - block must have at least minOverlap of its area in the column.
 * Default 0.5 (50%) is a good balance between precision and tolerance.
 */
function blockBelongsToColumn(
    blockBBox: RawBBox,
    column: Rect,
    minOverlap: number = 0.5
): boolean {
    return calculateOverlapRatio(blockBBox, column) >= minOverlap;
}

/**
 * Convert Rect to ColumnBBox format.
 */
function rectToColumnBBox(rect: Rect): ColumnBBox {
    return {
        l: rect.x,
        t: rect.y,
        r: rect.x + rect.w,
        b: rect.y + rect.h,
    };
}

/**
 * Clean text by normalizing whitespace and removing control characters.
 */
function cleanText(text: string): string {
    return text
        .replace(/\s+/g, " ")
        .replace(/[\u0000-\u001F]/g, "")
        .trim();
}

// ============================================================================
// Types and Classes
// ============================================================================

/** Options for page extraction */
export interface PageExtractorOptions {
    /** Style profile for classification */
    styleProfile?: StyleProfile;
    /** Margin settings for filtering */
    margins?: MarginSettings;
}

/**
 * Extract TextStyle from a line's font information.
 */
function extractStyle(line: RawLine): TextStyle {
    const font = line.font;
    if (!font) {
        return { size: 12, font: "unknown", bold: false, italic: false };
    }

    const fontName = font.name || "unknown";
    const fontNameLower = fontName.toLowerCase();

    return {
        size: Math.round(font.size || 12),
        font: fontName,
        bold: font.weight === "bold" || fontNameLower.includes("bold"),
        italic: font.style === "italic" || fontNameLower.includes("italic"),
    };
}

/**
 * Page Extractor class for processing individual pages.
 */
export class PageExtractor {
    private styleProfile: StyleProfile | null;
    private margins: MarginSettings | null;

    constructor(options: PageExtractorOptions = {}) {
        this.styleProfile = options.styleProfile || null;
        this.margins = options.margins || null;
    }

    /**
     * Process a raw page into structured output (without column detection).
     * Use extractPageWithColumns for column-aware extraction.
     */
    extractPage(rawPage: RawPageData): ProcessedPage {
        // Apply margin filtering if configured
        const pageToProcess = this.margins
            ? MarginFilter.filterPageByMargins(rawPage, this.margins)
            : rawPage;

        const blocks = this.processBlocks(pageToProcess.blocks);
        const content = this.buildContent(blocks);

        return {
            index: rawPage.pageIndex,
            label: rawPage.label,
            width: rawPage.width,
            height: rawPage.height,
            blocks,
            content,
        };
    }

    /**
     * Process a raw page with column detection for correct reading order.
     *
     * @param rawPage - The raw page data (already filtered if needed)
     * @param columnResult - Column detection result with columns in reading order
     * @param includeColumns - Whether to include column bboxes in output
     */
    extractPageWithColumns(
        rawPage: RawPageData,
        columnResult: ColumnDetectionResult,
        includeColumns: boolean = true
    ): ProcessedPage {
        const columns = columnResult.columns;
        
        // If no columns detected, fall back to regular extraction
        if (columns.length === 0) {
            return this.extractPage(rawPage);
        }

        // Get all text blocks from the page
        const allBlocks = rawPage.blocks.filter(b => b.type === "text" && b.lines);

        // Track which blocks have been assigned to a column
        const assignedBlocks = new Set<number>();
        const orderedBlocks: ProcessedBlock[] = [];

        // Process each column in reading order
        for (const column of columns) {
            // Find blocks that belong to this column (by center point)
            const blocksInColumn = allBlocks
                .map((block, idx) => ({ block, idx }))
                .filter(({ block, idx }) => {
                    if (assignedBlocks.has(idx)) return false;
                    return blockBelongsToColumn(block.bbox, column);
                });

            // Sort blocks within column by y-position (top to bottom)
            blocksInColumn.sort((a, b) => a.block.bbox.y - b.block.bbox.y);

            // Process each block
            for (const { block, idx } of blocksInColumn) {
                assignedBlocks.add(idx);
                const processedBlock = this.processBlock(block);
                if (processedBlock.text.trim()) {
                    orderedBlocks.push(processedBlock);
                }
            }
        }

        // Log unassigned blocks for debugging (these are typically in header/footer areas
        // outside the column detection region and should be excluded)
        const unassignedCount = allBlocks.length - assignedBlocks.size;
        if (unassignedCount > 0) {
            console.debug(
                `[PageExtractor] Page ${rawPage.pageIndex}: ${unassignedCount} block(s) not in any column (excluded)`
            );
        }

        // Build content from ordered blocks
        const content = this.buildContent(orderedBlocks);

        // Convert columns to output format
        const columnBBoxes: ColumnBBox[] | undefined = includeColumns
            ? columns.map(rectToColumnBBox)
            : undefined;

        return {
            index: rawPage.pageIndex,
            label: rawPage.label,
            width: rawPage.width,
            height: rawPage.height,
            blocks: orderedBlocks,
            content,
            columns: columnBBoxes,
        };
    }

    /**
     * Process raw blocks into structured blocks.
     */
    private processBlocks(rawBlocks: RawBlock[]): ProcessedBlock[] {
        const processed: ProcessedBlock[] = [];

        for (const block of rawBlocks) {
            if (block.type !== "text" || !block.lines) continue;

            const processedBlock = this.processBlock(block);
            if (processedBlock.text.trim()) {
                processed.push(processedBlock);
            }
        }

        return processed;
    }

    /**
     * Process a single block.
     */
    private processBlock(block: RawBlock): ProcessedBlock {
        const lines: ProcessedLine[] = [];
        let blockText = "";

        for (const line of block.lines || []) {
            const text = line.text || "";
            const style = extractStyle(line);

            lines.push({
                text,
                bbox: line.bbox,
                style,
            });

            blockText += text + " ";
        }

        const role = this.classifyBlock(lines);

        return {
            type: "text",
            bbox: block.bbox,
            lines,
            text: blockText.trim(),
            role,
        };
    }

    /**
     * Classify the semantic role of a block.
     */
    private classifyBlock(lines: ProcessedLine[]): ProcessedBlock["role"] {
        if (!this.styleProfile || lines.length === 0) {
            return "body";
        }

        const firstStyle = lines[0].style;
        const bodySize = this.styleProfile.primaryBodyStyle.size;

        if (firstStyle.size > bodySize * 1.2) {
            return "heading";
        }
        if (firstStyle.size < bodySize * 0.85) {
            return "footnote";
        }
        if (firstStyle.size < bodySize * 0.95) {
            return "caption";
        }

        return "body";
    }

    /**
     * Build plain text content from processed blocks.
     */
    private buildContent(blocks: ProcessedBlock[]): string {
        return blocks.map(b => b.text).join("\n\n");
    }

    /**
     * Update the style profile used for classification.
     */
    setStyleProfile(profile: StyleProfile): void {
        this.styleProfile = profile;
    }

    /**
     * Update the margins used for filtering.
     */
    setMargins(margins: MarginSettings): void {
        this.margins = margins;
    }
}
