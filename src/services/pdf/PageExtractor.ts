/**
 * Page Extractor
 *
 * Processes raw page data into clean, structured text.
 * Handles:
 * - Line joining and hyphenation
 * - Block classification
 * - Margin-based filtering
 * - Paragraph reconstruction
 *
 * TODO: Column detection (future implementation)
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
} from "./types";
import { styleToKey } from "./types";
import { StyleAnalyzer } from "./StyleAnalyzer";
import { MarginFilter } from "./MarginFilter";

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
     * Process a raw page into structured output.
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
