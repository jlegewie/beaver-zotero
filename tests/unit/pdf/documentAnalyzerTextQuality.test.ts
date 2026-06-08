/**
 * Unit tests for the `low_alphanumeric_ratio` text-quality heuristic in
 * `DocumentAnalyzer`.
 *
 * The check flags pages whose ratio of alphanumeric characters is below
 * `minAlphanumericRatio`. On its own that misclassifies legitimate content
 * as garbled. Two defenses keep false positives out:
 *
 *  - Runs of 4+ identical non-alphanumeric characters are collapsed before
 *    the ratio is taken, so table-of-contents / index dot leaders and rule
 *    lines no longer sink the ratio of readable pages.
 *  - A page is only flagged when it ALSO carries fewer than
 *    `minValidCharsToAccept` real alphanumeric characters, so symbol-dense
 *    pages (dense mathematics, equation-heavy papers) with substantial real
 *    text are spared.
 *
 * These tests exercise `DocumentAnalyzer` through its `RawPageProvider`
 * seam, so they need neither MuPDF nor WASM.
 */
import { describe, it, expect } from "vitest";

import { DocumentAnalyzer } from "../../../src/beaver-extract/DocumentAnalyzer";
import type { RawPageProvider } from "../../../src/beaver-extract/DocumentAnalyzer";
import type {
    BoundingBox,
    RawFont,
    RawLine,
    RawPageData,
} from "../../../src/beaver-extract/types";

function makeBox(): BoundingBox {
    return { l: 50, t: 50, r: 550, b: 750, origin: "top-left" };
}

function makeFont(): RawFont {
    return { name: "TestFont", family: "TestFont", weight: "normal", style: "normal", size: 10 };
}

/** A single-line text page carrying `text` — no images, upright body text. */
function makeTextPage(pageIndex: number, text: string): RawPageData {
    const line: RawLine = {
        wmode: 0,
        bbox: makeBox(),
        font: makeFont(),
        x: 50,
        y: 60,
        text,
    };
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: 600,
        height: 800,
        blocks: [{ type: "text", bbox: makeBox(), lines: [line] }],
    };
}

function makeProvider(pages: RawPageData[]): RawPageProvider {
    return {
        getPageCount: () => pages.length,
        extractRawPage: (i: number) => pages[i],
    };
}

/**
 * Table-of-contents page: short entry titles joined to page numbers by long
 * dot leaders. Raw alphanumeric ratio ≈ 0.17 (would flag); after the leader
 * runs collapse it rises to ≈ 0.9.
 */
const dotLeaderText = ("ChapterXYZ" + ".".repeat(60) + "12").repeat(30);

/**
 * Symbol-dense but substantive: 1200 real letters interleaved with varied
 * operator/bracket symbols (no character repeats 4× in a row, so the leader
 * collapse does not touch it). Ratio ≈ 0.1 — only the absolute-volume guard
 * keeps it out of the garbled bucket.
 */
const symbolDenseText = "a+-=()[]<>".repeat(1200);

/**
 * Genuinely garbled: only 100 real letters amid varied junk symbols, none in
 * runs of 4+. Neither defense applies — it is correctly flagged.
 */
const garbledText = "a%^&~|#@$".repeat(100);

/** Ordinary prose — overwhelmingly alphanumeric. */
const normalText = "The quick brown fox jumps over the lazy dog. ".repeat(40);

describe("DocumentAnalyzer low_alphanumeric_ratio false-positive defenses", () => {
    it("does not flag table-of-contents pages with dot leaders", () => {
        const analyzer = new DocumentAnalyzer(
            makeProvider([
                makeTextPage(0, dotLeaderText),
                makeTextPage(1, dotLeaderText),
            ]),
        );
        const result = analyzer.analyzeOCRNeeds();

        expect(result.issueBreakdown.low_alphanumeric_ratio).toBe(0);
        expect(result.needsOCR).toBe(false);
    });

    it("does not flag symbol-dense pages that carry substantial real text", () => {
        const analyzer = new DocumentAnalyzer(
            makeProvider([
                makeTextPage(0, symbolDenseText),
                makeTextPage(1, symbolDenseText),
            ]),
        );
        const result = analyzer.analyzeOCRNeeds();

        expect(result.issueBreakdown.low_alphanumeric_ratio).toBe(0);
        expect(result.needsOCR).toBe(false);
    });

    it("flags genuinely garbled pages (varied junk, little real text)", () => {
        const analyzer = new DocumentAnalyzer(
            makeProvider([
                makeTextPage(0, garbledText),
                makeTextPage(1, garbledText),
            ]),
        );
        const result = analyzer.analyzeOCRNeeds();

        expect(result.issueBreakdown.low_alphanumeric_ratio).toBe(2);
        expect(result.needsOCR).toBe(true);
    });

    it("re-flags symbol-dense pages once the volume guard is raised above their real-text count", () => {
        const analyzer = new DocumentAnalyzer(
            makeProvider([
                makeTextPage(0, symbolDenseText),
                makeTextPage(1, symbolDenseText),
            ]),
        );
        // The symbol-dense pages hold 1200 real characters; raising the guard
        // above that re-enables the bare ratio check, proving the guard — not
        // the leader collapse — is what spares them under the default options.
        const result = analyzer.analyzeOCRNeeds({ minValidCharsToAccept: 2000 });

        expect(result.issueBreakdown.low_alphanumeric_ratio).toBe(2);
    });

    it("never flags ordinary prose", () => {
        const analyzer = new DocumentAnalyzer(
            makeProvider([
                makeTextPage(0, normalText),
                makeTextPage(1, normalText),
            ]),
        );
        const result = analyzer.analyzeOCRNeeds();

        expect(result.issueBreakdown.low_alphanumeric_ratio).toBe(0);
        expect(result.needsOCR).toBe(false);
    });
});
