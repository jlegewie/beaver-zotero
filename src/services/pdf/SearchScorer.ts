/**
 * Search Scorer
 * 
 * Computes relevance scores for PDF search results by analyzing the semantic
 * role of text where matches are found (heading, body, caption, footnote).
 * 
 * Scoring Methodology:
 * - Each hit is assigned a weight based on text role
 * - Page score = Σ(hit_weight) × base_multiplier / normalization_factor
 * - Normalization optionally accounts for page text length
 * 
 * This approach prioritizes pages where matches appear in significant
 * content (headings, main body) over those in peripheral content (footnotes).
 */

import type {
    RawPageData,
    RawLine,
    RawBBox,
    PDFPageSearchResult,
    PDFSearchHit,
    ScoredSearchHit,
    ScoredPageSearchResult,
    SearchScoringOptions,
    SearchRoleWeights,
    TextRole,
    StyleProfile,
} from "./types";
import {
    DEFAULT_SEARCH_SCORING_OPTIONS,
    DEFAULT_SEARCH_ROLE_WEIGHTS,
} from "./types";
import { StyleAnalyzer } from "./StyleAnalyzer";

/**
 * Check if two bounding boxes overlap.
 * Uses a tolerance to handle slight coordinate mismatches.
 */
function bboxOverlaps(a: RawBBox, b: RawBBox, tolerance: number = 2): boolean {
    const aRight = a.x + a.w;
    const aBottom = a.y + a.h;
    const bRight = b.x + b.w;
    const bBottom = b.y + b.h;

    return !(
        aRight < b.x - tolerance ||
        a.x > bRight + tolerance ||
        aBottom < b.y - tolerance ||
        a.y > bBottom + tolerance
    );
}

/**
 * Find the line in a page that best matches a hit's bounding box.
 * Returns the line and its role, or null if no match found.
 */
function findLineForHit(
    hit: PDFSearchHit,
    page: RawPageData,
    styleProfile: StyleProfile
): { line: RawLine; role: TextRole } | null {
    const hitBbox = hit.bbox;

    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;

        for (const line of block.lines) {
            if (bboxOverlaps(hitBbox, line.bbox)) {
                const role = StyleAnalyzer.classifyRole(line, styleProfile);
                return { line, role };
            }
        }
    }

    return null;
}

/**
 * Extract text from a line that overlaps with the hit bbox.
 * This provides context for the match.
 */
function extractMatchedText(hit: PDFSearchHit, line: RawLine): string {
    // For simplicity, return the full line text
    // A more sophisticated approach would extract just the matching portion
    return line.text;
}

/**
 * Compute total text length on a page.
 */
function computePageTextLength(page: RawPageData): number {
    let total = 0;
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            total += line.text.length;
        }
    }
    return total;
}

/**
 * SearchScorer class for computing relevance scores.
 * 
 * Usage:
 * ```typescript
 * const scorer = new SearchScorer(rawPages, options);
 * const scoredResults = scorer.scorePageResults(pageResults);
 * ```
 */
export class SearchScorer {
    private readonly styleProfile: StyleProfile;
    private readonly pageMap: Map<number, RawPageData>;
    private readonly weights: SearchRoleWeights;
    private readonly options: Required<SearchScoringOptions>;

    /**
     * Create a scorer with document context.
     * 
     * @param pages - Raw page data for the document (for text extraction)
     * @param options - Scoring options
     */
    constructor(pages: RawPageData[], options: SearchScoringOptions = {}) {
        this.options = {
            ...DEFAULT_SEARCH_SCORING_OPTIONS,
            ...options,
            roleWeights: {
                ...DEFAULT_SEARCH_ROLE_WEIGHTS,
                ...options.roleWeights,
            },
        };
        this.weights = this.options.roleWeights as SearchRoleWeights;

        // Build style profile for role classification
        const analyzer = new StyleAnalyzer();
        this.styleProfile = analyzer.analyze(pages);

        // Index pages by page index for fast lookup
        this.pageMap = new Map();
        for (const page of pages) {
            this.pageMap.set(page.pageIndex, page);
        }
    }

    /**
     * Score a single hit based on its text role.
     */
    scoreHit(hit: PDFSearchHit, pageIndex: number): ScoredSearchHit {
        const page = this.pageMap.get(pageIndex);

        if (!page) {
            // No page data available - use default weight
            return {
                ...hit,
                role: "unknown",
                weight: this.weights.unknown,
            };
        }

        const lineMatch = findLineForHit(hit, page, this.styleProfile);

        if (!lineMatch) {
            // Hit doesn't match any extracted line - use default
            return {
                ...hit,
                role: "unknown",
                weight: this.weights.unknown,
            };
        }

        const { line, role } = lineMatch;
        const weight = this.weights[role];
        const matchedText = extractMatchedText(hit, line);

        return {
            ...hit,
            role,
            weight,
            matchedText,
        };
    }

    /**
     * Score all hits on a page and compute page score.
     */
    scorePageResult(pageResult: PDFPageSearchResult): ScoredPageSearchResult {
        const page = this.pageMap.get(pageResult.pageIndex);
        const textLength = page ? computePageTextLength(page) : 0;

        // Score each hit
        const scoredHits: ScoredSearchHit[] = pageResult.hits.map(hit =>
            this.scoreHit(hit, pageResult.pageIndex)
        );

        // Compute raw score (sum of weights)
        const rawScore = scoredHits.reduce((sum, hit) => sum + hit.weight, 0);

        // Compute normalized score
        let score = rawScore * this.options.baseMultiplier;

        if (this.options.normalizeByTextLength && textLength > 0) {
            // Normalize by text length, with a floor to prevent extreme values
            const effectiveLength = Math.max(
                textLength,
                this.options.minTextLengthForNormalization
            );
            score = score / Math.sqrt(effectiveLength);
        }

        return {
            pageIndex: pageResult.pageIndex,
            label: pageResult.label,
            matchCount: pageResult.matchCount,
            width: pageResult.width,
            height: pageResult.height,
            hits: scoredHits,
            score,
            rawScore,
            textLength,
        };
    }

    /**
     * Score multiple page results and sort by score.
     */
    scorePageResults(pageResults: PDFPageSearchResult[]): ScoredPageSearchResult[] {
        const scored = pageResults.map(pr => this.scorePageResult(pr));

        // Sort by score (highest first)
        scored.sort((a, b) => b.score - a.score);

        return scored;
    }

    /**
     * Get the style profile used for role classification.
     * Useful for debugging.
     */
    getStyleProfile(): StyleProfile {
        return this.styleProfile;
    }

    /**
     * Log scoring details for debugging.
     */
    static logScoredResult(result: ScoredPageSearchResult): void {
        console.group(`Page ${result.pageIndex + 1} (score: ${result.score.toFixed(2)})`);
        console.log(`  Matches: ${result.matchCount}`);
        console.log(`  Raw score: ${result.rawScore.toFixed(2)}`);
        console.log(`  Text length: ${result.textLength}`);

        // Group hits by role
        const byRole = new Map<TextRole, number>();
        for (const hit of result.hits) {
            byRole.set(hit.role, (byRole.get(hit.role) || 0) + 1);
        }

        console.log("  Hits by role:");
        for (const [role, count] of byRole) {
            console.log(`    ${role}: ${count}`);
        }

        console.groupEnd();
    }
}
