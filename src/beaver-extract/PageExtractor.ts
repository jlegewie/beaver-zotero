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
    InternalProcessedPage,
    BoundingBox,
    DocItem,
    ItemLine,
    StyleProfile,
    TextStyle,
    MarginSettings,
} from "./types";
import { bboxFromXYWH, bboxHeight, bboxWidth } from "./types";
import { MarginFilter } from "./MarginFilter";
import type { Rect, ColumnDetectionResult } from "./ColumnDetector";
import { pdfLog } from "./logging";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate the overlap ratio between a block and a column.
 * Returns the fraction of the block's area that falls within the column.
 */
function calculateOverlapRatio(blockBBox: BoundingBox, column: Rect): number {
    // Calculate intersection
    const xOverlapStart = Math.max(blockBBox.l, column.x);
    const xOverlapEnd = Math.min(blockBBox.r, column.x + column.w);
    const yOverlapStart = Math.max(blockBBox.t, column.y);
    const yOverlapEnd = Math.min(blockBBox.b, column.y + column.h);

    // No overlap if any dimension is negative
    if (xOverlapEnd <= xOverlapStart || yOverlapEnd <= yOverlapStart) {
        return 0;
    }

    const overlapArea = (xOverlapEnd - xOverlapStart) * (yOverlapEnd - yOverlapStart);
    const blockArea = bboxWidth(blockBBox) * bboxHeight(blockBBox);

    return blockArea > 0 ? overlapArea / blockArea : 0;
}

/**
 * Check if a block belongs to a column.
 * Uses overlap ratio - block must have at least minOverlap of its area in the column.
 * Default 0.5 (50%) is a good balance between precision and tolerance.
 */
function blockBelongsToColumn(
    blockBBox: BoundingBox,
    column: Rect,
    minOverlap: number = 0.5
): boolean {
    return calculateOverlapRatio(blockBBox, column) >= minOverlap;
}

/**
 * Clean text by normalizing whitespace and removing control characters.
 */
function cleanText(text: string): string {
    return text
        .replace(/\s+/g, " ")
        // eslint-disable-next-line no-control-regex
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

interface ProcessedLine {
    text: string;
    bbox: BoundingBox;
    style: TextStyle;
}

interface ProcessedBlock {
    type: "text" | "image";
    bbox: BoundingBox;
    lines: ProcessedLine[];
    text: string;
    columnIndex: number;
    /** Stylistic role detected by the block engine. Reserved DocItem kinds are not emitted from this heuristic. */
    role?: "heading" | "body" | "caption" | "footnote";
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
    extractPage(rawPage: RawPageData): InternalProcessedPage {
        // Apply margin filtering if configured
        const pageToProcess = this.margins
            ? MarginFilter.filterPageByMargins(
                rawPage,
                this.margins,
                this.styleProfile?.bodyStyles,
            )
            : rawPage;

        const blocks = this.processBlocks(pageToProcess.blocks, 0);
        const content = this.buildContent(blocks);
        const items = this.blocksToItems(blocks, rawPage.pageIndex);

        return {
            index: rawPage.pageIndex,
            label: rawPage.label,
            width: rawPage.width,
            height: rawPage.height,
            content,
            columns: [],
            items,
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
    ): InternalProcessedPage {
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
        for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            const column = columns[columnIndex];
            // Find blocks that belong to this column (by center point)
            const blocksInColumn = allBlocks
                .map((block, idx) => ({ block, idx }))
                .filter(({ block, idx }) => {
                    if (assignedBlocks.has(idx)) return false;
                    return blockBelongsToColumn(block.bbox, column);
                });

            // Sort blocks within column by y-position (top to bottom)
            blocksInColumn.sort((a, b) => a.block.bbox.t - b.block.bbox.t);

            // Process each block
            for (const { block, idx } of blocksInColumn) {
                assignedBlocks.add(idx);
                const processedBlock = this.processBlock(block, columnIndex);
                if (processedBlock.text.trim()) {
                    orderedBlocks.push(processedBlock);
                }
            }
        }

        // Log unassigned blocks for debugging (these are typically in header/footer areas
        // outside the column detection region and should be excluded)
        if (process.env.NODE_ENV === "development") {
            const unassignedCount = allBlocks.length - assignedBlocks.size;
            if (unassignedCount > 0) {
                pdfLog(
                    `[PageExtractor] Page ${rawPage.pageIndex}: ${unassignedCount} block(s) not in any column (excluded)`,
                    3,
                );
            }
        }

        // Build content from ordered blocks
        const content = this.buildContent(orderedBlocks);

        // Convert columns to output format
        const columnBBoxes: BoundingBox[] = includeColumns
            ? columns.map((rect) =>
                bboxFromXYWH(rect.x, rect.y, rect.w, rect.h, "top-left"),
            )
            : [];
        const items = this.blocksToItems(orderedBlocks, rawPage.pageIndex);

        return {
            index: rawPage.pageIndex,
            label: rawPage.label,
            width: rawPage.width,
            height: rawPage.height,
            content,
            columns: columnBBoxes,
            items,
        };
    }

    /**
     * Process raw blocks into structured blocks.
     */
    private processBlocks(rawBlocks: readonly RawBlock[], columnIndex: number): ProcessedBlock[] {
        const processed: ProcessedBlock[] = [];

        for (const block of rawBlocks) {
            if (block.type !== "text" || !block.lines) continue;

            const processedBlock = this.processBlock(block, columnIndex);
            if (processedBlock.text.trim()) {
                processed.push(processedBlock);
            }
        }

        return processed;
    }

    /**
     * Process a single block.
     */
    private processBlock(block: RawBlock, columnIndex: number): ProcessedBlock {
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
            columnIndex,
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

    private blocksToItems(blocks: ProcessedBlock[], pageIndex: number): DocItem[] {
        return blocks.map((block, index) => {
            const lines: ItemLine[] = block.lines.map((line) => ({
                text: line.text,
                bbox: line.bbox,
                fontSize: line.style.size,
            }));
            const textLines = lines.length > 0
                ? lines
                : [{ text: block.text, bbox: block.bbox }];
            const base = {
                id: `p${pageIndex}:i${index}`,
                pageIndex,
                index,
                bbox: block.bbox,
                columnIndex: block.columnIndex,
                text: block.text,
                lines: textLines,
            };
            if (block.role === "heading") {
                return { ...base, kind: "section_header" as const, level: 1 };
            }
            return { ...base, kind: "text" as const };
        });
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
