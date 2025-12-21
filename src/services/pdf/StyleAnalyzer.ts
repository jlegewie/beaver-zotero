/**
 * Style Analyzer
 *
 * Analyzes font styles across the document to understand visual hierarchy.
 * Used to identify headings, body text, captions, and footnotes.
 */

import type { RawPageData, StyleProfile, TextStyle } from "./types";

/** Font size frequency entry */
interface FontSizeEntry {
    size: number;
    count: number;
}

/**
 * Style Analyzer class for understanding document typography.
 */
export class StyleAnalyzer {
    private fontSizes: Map<number, number> = new Map();
    private fontNames: Map<string, number> = new Map();

    /**
     * Add pages to the analysis.
     * Call this with raw page data to accumulate statistics.
     */
    addPages(pages: RawPageData[]): void {
        for (const page of pages) {
            this.analyzePage(page);
        }
    }

    /**
     * Analyze a single page and accumulate font statistics.
     */
    private analyzePage(page: RawPageData): void {
        for (const block of page.blocks) {
            if (block.type !== "text") continue;

            for (const line of block.lines || []) {
                const size = line.size ?? 12;
                const font = line.font ?? "unknown";

                this.fontSizes.set(size, (this.fontSizes.get(size) || 0) + 1);
                this.fontNames.set(font, (this.fontNames.get(font) || 0) + 1);
            }
        }
    }

    /**
     * Build the style profile from accumulated data.
     */
    buildProfile(): StyleProfile {
        // Find most common font size (likely body text)
        let bodyFontSize = 12;
        let maxCount = 0;

        for (const [size, count] of this.fontSizes) {
            if (count > maxCount) {
                maxCount = count;
                bodyFontSize = size;
            }
        }

        // Find heading sizes (significantly larger than body)
        const headingFontSizes: number[] = [];
        for (const [size] of this.fontSizes) {
            if (size > bodyFontSize * 1.2) {
                headingFontSizes.push(size);
            }
        }
        headingFontSizes.sort((a, b) => b - a);

        // Find primary font
        let primaryFont = "unknown";
        maxCount = 0;
        for (const [font, count] of this.fontNames) {
            if (count > maxCount) {
                maxCount = count;
                primaryFont = font;
            }
        }

        return {
            bodyFontSize,
            headingFontSizes,
            primaryFont,
            fonts: new Map(this.fontNames),
        };
    }

    /**
     * Parse font name to extract style information.
     */
    static parseStyle(fontName: unknown, fontSize: number): TextStyle {
        // Handle cases where fontName might not be a string
        const name = typeof fontName === "string" ? fontName : "unknown";
        const nameLower = name.toLowerCase();

        return {
            fontName: name,
            fontSize: fontSize || 12,
            isBold: nameLower.includes("bold") || nameLower.includes("black"),
            isItalic: nameLower.includes("italic") || nameLower.includes("oblique"),
        };
    }

    /**
     * Determine the semantic role of text based on its style.
     */
    classifyRole(
        style: TextStyle,
        profile: StyleProfile
    ): "heading" | "body" | "caption" | "footnote" {
        const { fontSize } = style;
        const { bodyFontSize } = profile;

        if (fontSize > bodyFontSize * 1.2) {
            return "heading";
        }

        if (fontSize < bodyFontSize * 0.85) {
            return "footnote";
        }

        if (fontSize < bodyFontSize * 0.95) {
            return "caption";
        }

        return "body";
    }

    /** Reset accumulated statistics */
    reset(): void {
        this.fontSizes.clear();
        this.fontNames.clear();
    }
}

