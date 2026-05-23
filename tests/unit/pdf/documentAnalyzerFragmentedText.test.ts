/**
 * Unit tests for the fragmented-text check in `DocumentAnalyzer`.
 *
 * A font MuPDF cannot group into words — e.g. a Type 3 font with broken
 * metrics and a custom encoding, or any font lacking a usable ToUnicode CMap
 * once `use-cid-for-unknown-unicode` substitutes raw character codes — yields
 * a structured-text layer where every glyph becomes its own one-character
 * line. The substituted characters are ordinary letters, so the per-page
 * alphanumeric-ratio and replacement-character checks pass and the per-page
 * text length looks healthy, yet the text never assembles into words.
 *
 * The `fragmented_text_lines` check closes that gap: a page with many text
 * lines averaging ~1 character each is routed to OCR.
 *
 * These tests exercise `DocumentAnalyzer` through its `RawPageProvider` seam,
 * so they need neither MuPDF nor WASM.
 */
import { describe, it, expect } from "vitest";

import { DocumentAnalyzer } from "../../../src/beaver-extract/DocumentAnalyzer";
import type { RawPageProvider } from "../../../src/beaver-extract/DocumentAnalyzer";
import type {
    BoundingBox,
    RawBlock,
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

/** A text page whose single text block carries `lineCount` lines of `lineText`. */
function makeMultiLinePage(
    pageIndex: number,
    lineCount: number,
    lineText: string,
): RawPageData {
    const lines: RawLine[] = Array.from({ length: lineCount }, () => ({
        wmode: 0,
        bbox: makeBox(),
        font: makeFont(),
        x: 50,
        y: 60,
        text: lineText,
    }));
    const blocks: RawBlock[] = [{ type: "text", bbox: makeBox(), lines }];
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: 600,
        height: 800,
        blocks,
    };
}

function makeProvider(pages: RawPageData[]): RawPageProvider {
    return {
        getPageCount: () => pages.length,
        extractRawPage: (i: number) => pages[i],
    };
}

describe("DocumentAnalyzer fragmented-text check", () => {
    it("flags a document whose pages extract as one-character lines", () => {
        // 60 single-character lines per page — the signature of an undecodable
        // font whose glyphs never grouped into words.
        const pages = Array.from({ length: 3 }, (_, i) =>
            makeMultiLinePage(i, 60, "U"),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.needsOCR).toBe(true);
        expect(result.issueBreakdown.fragmented_text_lines).toBeGreaterThan(0);
        expect(result.pageAnalyses[0].issues).toContain("fragmented_text_lines");
    });

    it("does not flag ordinary prose with many full-length lines", () => {
        // Same high line count, but each line carries a real sentence — the
        // mean characters-per-line is far above the fragmentation ceiling.
        const pages = Array.from({ length: 3 }, (_, i) =>
            makeMultiLinePage(i, 60, "The quick brown fox jumps over the lazy dog"),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.needsOCR).toBe(false);
        expect(result.issueBreakdown.fragmented_text_lines).toBe(0);
    });

    it("does not fire below the line-count gate", () => {
        // Only 40 one-character lines — a page this sparse carries too little
        // signal, so the check stays silent and leaves the verdict to the
        // other guards.
        const pages = Array.from({ length: 3 }, (_, i) =>
            makeMultiLinePage(i, 40, "U"),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.issueBreakdown.fragmented_text_lines).toBe(0);
    });

    it("does not fire when the mean line length exceeds the ceiling", () => {
        // Many lines, but each is three characters — above the fragmentation
        // ceiling, so the page is treated as real (if terse) text.
        const pages = Array.from({ length: 3 }, (_, i) =>
            makeMultiLinePage(i, 60, "abc"),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.issueBreakdown.fragmented_text_lines).toBe(0);
    });
});
