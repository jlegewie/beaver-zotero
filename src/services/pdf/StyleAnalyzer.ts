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
import { pdfLog } from "./logging";

/** Minimum characters in a span to include in analysis */
const DEFAULT_MIN_CHARS = 4;

/** Threshold for considering a style as "body" (percentage of primary style) */
const DEFAULT_THRESHOLD_PERC = 0.15;

/**
 * Extract TextStyle from a raw line's font information.
 */
export function extractStyle(line: RawLine): TextStyle {
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

    // Subset font names often encode weight/style as a suffix that substring
    // checks miss — e.g. `AJHJCE+AdvTT56ea2c23.B` (bold),
    // `BPEJCI+AdvTTa15c7c65.I` (italic), `XXX.BI`/`.IB` (bold-italic).
    const boldSuffix = /\.(B|Bd|Bld|Bold|Black|Heavy|BI|IB)$/i;
    const italicSuffix = /\.(I|It|Italic|Obl|Oblique|BI|IB)$/i;

    const isBold = font.weight === "bold" ||
        fontNameLower.includes("bold") ||
        fontNameLower.includes("black") ||
        fontNameLower.includes("heavy") ||
        boldSuffix.test(fontName);

    const isItalic = font.style === "italic" ||
        fontNameLower.includes("italic") ||
        fontNameLower.includes("oblique") ||
        italicSuffix.test(fontName);

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

    // Only non-alphanumeric (like "...", "---", etc.). Unicode-aware so
    // non-Latin scripts (Cyrillic, Greek, Arabic, CJK, ...) are not ignored.
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;

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
     * Check whether a raw line's font matches one of the document's body
     * styles. Used by the margin filter + column detector to spare body-
     * styled content that lives inside the simple-margin band.
     */
    static isLineBodyStyled(line: RawLine, bodyStyles: TextStyle[]): boolean {
        if (!bodyStyles || bodyStyles.length === 0) return false;
        const key = styleToKey(extractStyle(line));
        return bodyStyles.some((s) => styleToKey(s) === key);
    }

    /**
     * Predicate used by the margin filter / column detector to decide
     * whether a line should be spared from the simple-margin drop on the
     * basis of "this looks like body content packed near the page edge".
     *
     * Two signals combined:
     *  - **Style**: the line's font matches a document body style
     *    (`isLineBodyStyled`).
     *  - **Substance**: the text has at least two word tokens AND at
     *    least 8 alphanumeric characters. Short tokens that happen to
     *    share body style sail through.
     */
    static looksLikeBodyContent(
        line: RawLine,
        bodyStyles: TextStyle[]
    ): boolean {
        if (!StyleAnalyzer.isLineBodyStyled(line, bodyStyles)) return false;
        const text = (line.text || "").trim();
        const alnumMatches = text.match(/[\p{L}\p{N}]/gu);
        if (!alnumMatches || alnumMatches.length < 8) return false;
        const tokens = text
            .split(/\s+/)
            .filter((t) => /[\p{L}\p{N}]/u.test(t));
        return tokens.length >= 2;
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

        pdfLog("[StyleAnalyzer] Style analysis:", 3);
        pdfLog(`  Primary body style: ${styleToKey(profile.primaryBodyStyle)}`, 3);
        pdfLog(`  Body styles count: ${profile.bodyStyles.length}`, 3);

        // Log top 10 styles by character count
        pdfLog("\n[StyleAnalyzer] Top styles by character count:", 3);
        const sorted = Array.from(profile.styleCounts.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        for (const [key, { count, style }] of sorted) {
            const isBody = profile.bodyStyles.some(s => styleToKey(s) === key);
            const marker = isBody ? "[BODY]" : "";
            pdfLog(`    ${key}: ${count} chars ${marker}`, 3);
            pdfLog(`      Font: ${style.font}, Size: ${style.size}, Bold: ${style.bold}, Italic: ${style.italic}`, 3);
        }
    }
}
