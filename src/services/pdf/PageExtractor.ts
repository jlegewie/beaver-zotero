/**
 * Page Extractor
 *
 * Processes raw page data into clean, structured text.
 * Handles:
 * - Line joining and hyphenation
 * - Block classification
 * - Header/footer removal
 * - Paragraph reconstruction
 */

import type {
    RawPageData,
    RawBlock,
    ProcessedPage,
    ProcessedBlock,
    ProcessedLine,
    RepeatedElement,
    StyleProfile,
    BBox,
} from "./types";
import { StyleAnalyzer } from "./StyleAnalyzer";

/** Options for page extraction */
export interface PageExtractorOptions {
    /** Elements to filter out (headers/footers) */
    repeatedElements?: RepeatedElement[];
    /** Style profile for classification */
    styleProfile?: StyleProfile;
}

/**
 * Page Extractor class for processing individual pages.
 */
export class PageExtractor {
    private repeatedElements: RepeatedElement[];
    private styleProfile: StyleProfile | null;

    constructor(options: PageExtractorOptions = {}) {
        this.repeatedElements = options.repeatedElements || [];
        this.styleProfile = options.styleProfile || null;
    }

    /**
     * Process a raw page into structured output.
     */
    extractPage(
        rawPage: RawPageData,
        pageIndex: number,
        pageWidth: number,
        pageHeight: number,
        pageLabel?: string
    ): ProcessedPage {
        const blocks = this.processBlocks(rawPage.blocks, pageHeight);
        const content = this.buildContent(blocks);

        return {
            index: pageIndex,
            label: pageLabel,
            width: pageWidth,
            height: pageHeight,
            blocks,
            content,
        };
    }

    /**
     * Process raw blocks into structured blocks.
     */
    private processBlocks(rawBlocks: RawBlock[], pageHeight: number): ProcessedBlock[] {
        const processed: ProcessedBlock[] = [];

        for (const block of rawBlocks) {
            if (block.type !== "text") continue;
            if (this.shouldFilterBlock(block, pageHeight)) continue;

            const processedBlock = this.processBlock(block);
            if (processedBlock.text.trim()) {
                processed.push(processedBlock);
            }
        }

        return processed;
    }

    /**
     * Check if a block should be filtered (header/footer).
     */
    private shouldFilterBlock(block: RawBlock, pageHeight: number): boolean {
        if (!this.repeatedElements.length) return false;

        const blockText = this.getBlockText(block);
        const blockY = block.bbox[1];
        const isTop = blockY < pageHeight * 0.1;
        const isBottom = blockY > pageHeight * 0.9;

        for (const elem of this.repeatedElements) {
            if (elem.position === "header" && isTop && blockText.includes(elem.text)) {
                return true;
            }
            if (elem.position === "footer" && isBottom && blockText.includes(elem.text)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get plain text from a raw block.
     */
    private getBlockText(block: RawBlock): string {
        if (!block.lines) return "";
        return block.lines.map(l => l.text || "").join(" ");
    }

    /**
     * Process a single block.
     */
    private processBlock(block: RawBlock): ProcessedBlock {
        const lines: ProcessedLine[] = [];
        let blockText = "";

        for (const line of block.lines || []) {
            const text = line.text || "";
            const style = StyleAnalyzer.parseStyle(
                line.font || "unknown",
                line.size || 12
            );

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

        // Use the first line's style for classification
        const firstStyle = lines[0].style;
        const analyzer = new StyleAnalyzer();
        return analyzer.classifyRole(firstStyle, this.styleProfile);
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
     * Update the repeated elements to filter.
     */
    setRepeatedElements(elements: RepeatedElement[]): void {
        this.repeatedElements = elements;
    }
}

