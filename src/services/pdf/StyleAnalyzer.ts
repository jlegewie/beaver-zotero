/**
 * Style Analyzer
 *
 * Identifies the dominant "body text" styles by counting character frequencies.
 * This allows distinguishing between main content and headers, footers, captions, etc.
 *
 * The key insight is that body text has the most characters in a document,
 * so we use character count (not span/line count) as the weight.
 */

import type {
    RawPageData,
    RawLine,
    RawFont,
    TextStyle,
    StyleProfile,
} from "./types";
import { styleToKey } from "./types";

/** Minimum characters in a span to include in analysis */
const DEFAULT_MIN_CHARS = 4;

/** Threshold for considering a style as "body" (percentage of primary style) */
const DEFAULT_THRESHOLD_PERC = 0.15;

/**
 * Extract TextStyle from a raw line's font information.
 */
function extractStyle(line: RawLine): TextStyle {
    const font = line.font;

    // Handle missing font info
    if (!font) {
        return {
            size: 12,
            font: "unknown",
            bold: false,
            italic: false,
        };
    }

    // Determine bold/italic from font properties or name
    const fontName = font.name || "unknown";
    const fontNameLower = fontName.toLowerCase();

    // Check font weight and style properties
    const isBold = font.weight === "bold" ||
        fontNameLower.includes("bold") ||
        fontNameLower.includes("black") ||
        fontNameLower.includes("heavy");

    const isItalic = font.style === "italic" ||
        fontNameLower.includes("italic") ||
        fontNameLower.includes("oblique");

    return {
        size: Math.round(font.size || 12),
        font: fontName,
        bold: isBold,
        italic: isItalic,
    };
}

/**
 * Check if text should be ignored for style analysis.
 * Ignores very short text, whitespace-only, and non-alphanumeric text.
 */
function shouldIgnoreText(text: string, minChars: number): boolean {
    // Too short
    if (text.length < minChars) return true;

    // Only whitespace
    const trimmed = text.trim();
    if (trimmed.length === 0) return true;

    // Only non-alphanumeric (like "...", "---", etc.)
    if (!/[a-zA-Z0-9]/.test(trimmed)) return true;

    return false;
}

/**
 * StyleAnalyzer class for understanding document typography.
 *
 * Usage:
 * ```typescript
 * const analyzer = new StyleAnalyzer();
 * const profile = analyzer.analyze(rawPages);
 * console.log(profile.primaryBodyStyle);
 * ```
 */
export class StyleAnalyzer {
    /**
     * Analyze pages to build a style profile.
     *
     * @param pages - Raw page data to analyze
     * @param minChars - Minimum characters per span to include (default 4)
     * @param thresholdPerc - Threshold for body styles (default 0.15 = 15%)
     * @param sampleSize - Max pages to sample (0 = all pages)
     * @returns Style profile with body styles identified
     */
    analyze(
        pages: RawPageData[],
        minChars: number = DEFAULT_MIN_CHARS,
        thresholdPerc: number = DEFAULT_THRESHOLD_PERC,
        sampleSize: number = 0
    ): StyleProfile {
        // Select pages to analyze
        const pagesToAnalyze = this.selectPages(pages, sampleSize);

        // Build style counts map
        const styleCounts = new Map<string, { count: number; style: TextStyle }>();

        for (const page of pagesToAnalyze) {
            for (const block of page.blocks) {
                if (block.type !== "text" || !block.lines) continue;

                for (const line of block.lines) {
                    // Skip if text should be ignored
                    if (shouldIgnoreText(line.text, minChars)) continue;

                    // Extract style and create key
                    const style = extractStyle(line);
                    const key = styleToKey(style);

                    // Get or create entry
                    const entry = styleCounts.get(key) || { count: 0, style };

                    // Weight by character count (the core metric)
                    entry.count += line.text.length;

                    styleCounts.set(key, entry);
                }
            }
        }

        // Sort by character count (descending)
        const sorted = Array.from(styleCounts.values())
            .sort((a, b) => b.count - a.count);

        // Handle empty document
        if (sorted.length === 0) {
            const defaultStyle: TextStyle = { size: 12, font: "unknown", bold: false, italic: false };
            return {
                primaryBodyStyle: defaultStyle,
                bodyStyles: [defaultStyle],
                styleCounts,
            };
        }

        // Primary body style is the one with most characters
        const primaryBodyStyle = sorted[0].style;
        const primaryCount = sorted[0].count;

        // Body styles are those above the threshold
        const bodyStyles = sorted
            .filter(item => item.count >= primaryCount * thresholdPerc)
            .map(item => item.style);

        return {
            primaryBodyStyle,
            bodyStyles,
            styleCounts,
        };
    }

    /**
     * Select pages to analyze (for large documents, sample randomly).
     */
    private selectPages(pages: RawPageData[], sampleSize: number): RawPageData[] {
        if (sampleSize <= 0 || pages.length <= sampleSize) {
            return pages;
        }

        // Random sampling for large documents
        const indices = new Set<number>();
        while (indices.size < sampleSize) {
            indices.add(Math.floor(Math.random() * pages.length));
        }

        return Array.from(indices)
            .sort((a, b) => a - b)
            .map(i => pages[i]);
    }

    /**
     * Check if a style is considered "body text".
     */
    static isBodyStyle(style: TextStyle, profile: StyleProfile): boolean {
        const key = styleToKey(style);
        return profile.bodyStyles.some(s => styleToKey(s) === key);
    }

    /**
     * Classify a line's semantic role based on its style.
     */
    static classifyRole(
        line: RawLine,
        profile: StyleProfile
    ): "heading" | "body" | "caption" | "footnote" {
        const style = extractStyle(line);
        const bodySize = profile.primaryBodyStyle.size;

        // Significantly larger = heading
        if (style.size > bodySize * 1.2) {
            return "heading";
        }

        // Much smaller = footnote
        if (style.size < bodySize * 0.85) {
            return "footnote";
        }

        // Slightly smaller = caption
        if (style.size < bodySize * 0.95) {
            return "caption";
        }

        return "body";
    }

    /**
     * Log style analysis for debugging.
     * Only logs in development mode.
     */
    static logStyleProfile(profile: StyleProfile): void {
        if (process.env.NODE_ENV !== "development") return;

        console.log("[StyleAnalyzer] Style analysis:");
        console.log(`  Primary body style: ${styleToKey(profile.primaryBodyStyle)}`);
        console.log(`  Body styles count: ${profile.bodyStyles.length}`);

        // Log top 10 styles by character count
        console.log("\n[StyleAnalyzer] Top styles by character count:");
        const sorted = Array.from(profile.styleCounts.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        for (const [key, { count, style }] of sorted) {
            const isBody = profile.bodyStyles.some(s => styleToKey(s) === key);
            const marker = isBody ? "[BODY]" : "";
            console.log(`    ${key}: ${count} chars ${marker}`);
            console.log(`      Font: ${style.font}, Size: ${style.size}, Bold: ${style.bold}, Italic: ${style.italic}`);
        }
    }
}
