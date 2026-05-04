/**
 * Unit tests for FilteredParagraphPipeline.
 *
 * Hermetic — synthetic RawPageData, no MuPDF, no Zotero.
 */

import { describe, it, expect } from "vitest";
import { detectFilteredParagraphs } from "../../../src/services/pdf/FilteredParagraphPipeline";
import { MarginFilter } from "../../../src/services/pdf/MarginFilter";
import { StyleAnalyzer } from "../../../src/services/pdf/StyleAnalyzer";
import {
    DEFAULT_MARGINS,
    DEFAULT_MARGIN_ZONE,
    type RawBlock,
    type RawLine,
    type RawPageData,
} from "../../../src/services/pdf/types";

// ---------------------------------------------------------------------------
// Synthetic page builders
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;
const BODY_SIZE = 12;
const HEADER_SIZE = 18;

function makeLine(
    text: string,
    yTop: number,
    xStart = 80,
    size: number = BODY_SIZE,
    fontName: string = "Body",
): RawLine {
    return {
        wmode: 0,
        bbox: { x: xStart, y: yTop, w: text.length * 6, h: size },
        font: {
            name: fontName,
            family: fontName,
            weight: "normal",
            style: "normal",
            size,
        },
        x: xStart,
        y: yTop,
        text,
    };
}

function makePage(pageIndex: number, lines: RawLine[]): RawPageData {
    const blocks: RawBlock[] = lines.length
        ? [
              {
                  type: "text",
                  bbox: {
                      x: Math.min(...lines.map((l) => l.bbox.x)),
                      y: Math.min(...lines.map((l) => l.bbox.y)),
                      w: PAGE_W,
                      h: PAGE_H,
                  },
                  lines,
              },
          ]
        : [];
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: PAGE_W,
        height: PAGE_H,
        blocks,
    };
}

/** Build a body line at a content-area y position. */
function bodyLine(text: string, yTop: number): RawLine {
    return makeLine(text, yTop, 80, BODY_SIZE);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectFilteredParagraphs", () => {
    describe("pageIndex resolution by document-page-index", () => {
        it("picks the page whose pageIndex matches, not the array position", () => {
            const pages = [
                makePage(8, [bodyLine("Page eight body text here.", 200)]),
                makePage(9, [bodyLine("Page nine body text here.", 200)]),
                makePage(10, [bodyLine("Page ten body text here.", 200)]),
            ];
            const out = detectFilteredParagraphs({ pages, pageIndex: 9 });
            expect(out.filteredPage.pageIndex).toBe(9);
            expect(out.paragraphResult.items.length).toBeGreaterThan(0);
            expect(out.paragraphResult.items[0].text).toContain("nine");
        });

        it("throws when pageIndex is not present in the supplied pages", () => {
            const pages = [makePage(0, [bodyLine("Body", 200)])];
            expect(() =>
                detectFilteredParagraphs({ pages, pageIndex: 99 }),
            ).toThrow(/page_index 99 not present/);
        });
    });

    describe("simple-margin filtering", () => {
        it("drops a line entirely inside the simple right-margin zone", () => {
            // Place a watermark at x exactly on the right-margin boundary
            // (page width 612, right margin 25 → boundary at 587, inclusive).
            const watermarkX = PAGE_W - DEFAULT_MARGINS.right; // 587
            const watermark: RawLine = {
                wmode: 0,
                bbox: { x: watermarkX, y: 200, w: 5, h: 300 },
                font: {
                    name: "WM",
                    family: "WM",
                    weight: "normal",
                    style: "normal",
                    size: 6,
                },
                x: watermarkX,
                y: 200,
                text: "Watermark",
            };
            const pages = [
                makePage(0, [
                    bodyLine("First line of body text.", 200),
                    bodyLine("Second line of body text.", 220),
                    watermark,
                ]),
            ];
            const out = detectFilteredParagraphs({ pages, pageIndex: 0 });
            const allLineTexts = out.lineResult.allLines
                .map((l) => l.text)
                .join(" ");
            expect(allLineTexts).not.toContain("Watermark");
            expect(allLineTexts).toContain("First line");
        });
    });

    describe("smart-removal: repeating header", () => {
        it("removes a header that appears in the top zone of ≥3 pages", () => {
            // Header text in the simple top margin zone — would normally
            // be excluded by the simple filter alone. But to prove the
            // *smart-removal* branch fires, we put it in the smart zone
            // (top-band 80pt) but outside the simple zone (40pt). Place
            // header line at y=50 → simple top boundary at y+h=62 ≤ 40
            // is false (62>40), so simple filter keeps it. Smart zone
            // boundary at y+h=62 ≤ 80 is true, so it's collected.
            const buildPage = (idx: number): RawPageData =>
                makePage(idx, [
                    {
                        wmode: 0,
                        bbox: { x: 80, y: 50, w: 200, h: 8 },
                        font: {
                            name: "H",
                            family: "H",
                            weight: "normal",
                            style: "normal",
                            size: 8,
                        },
                        x: 80,
                        y: 50,
                        text: "Repeating Journal Header",
                    },
                    bodyLine(`Body of page ${idx + 1} goes here.`, 200),
                    bodyLine("Second line of body text.", 220),
                ]);
            const pages = [0, 1, 2, 3, 4].map(buildPage);
            const out = detectFilteredParagraphs({
                pages,
                pageIndex: 2,
                repeatThreshold: 3,
            });
            const allText = out.lineResult.allLines.map((l) => l.text).join(" ");
            expect(allText).not.toContain("Repeating Journal Header");
            expect(out.marginRemoval.candidates.some((c) => c.reason === "repeat"))
                .toBe(true);
        });
    });

    describe("smart-removal: page-number sequence", () => {
        it("removes ascending page numbers in the same margin zone", () => {
            const buildPage = (idx: number, num: number): RawPageData =>
                makePage(idx, [
                    {
                        wmode: 0,
                        bbox: { x: 80, y: 50, w: 30, h: 8 },
                        font: {
                            name: "PN",
                            family: "PN",
                            weight: "normal",
                            style: "normal",
                            size: 8,
                        },
                        x: 80,
                        y: 50,
                        text: String(num),
                    },
                    bodyLine(`Body of page ${idx + 1}.`, 200),
                    bodyLine("Filler line two.", 220),
                ]);
            const pages = [0, 1, 2, 3, 4].map((i) => buildPage(i, 100 + i));
            const out = detectFilteredParagraphs({
                pages,
                pageIndex: 2,
                repeatThreshold: 3,
                detectPageSequences: true,
            });
            const allText = out.lineResult.allLines.map((l) => l.text).join(" ");
            expect(allText).not.toContain("102");
            expect(out.marginRemoval.candidates.some((c) => c.reason === "page_number"))
                .toBe(true);
        });
    });

    describe("empty / degenerate pages", () => {
        it("returns a well-formed empty result when the page has no text blocks", () => {
            const pages = [makePage(0, [])];
            const out = detectFilteredParagraphs({ pages, pageIndex: 0 });
            expect(out.paragraphResult.items).toEqual([]);
            expect(out.paragraphResult.itemLines).toEqual([]);
            expect(out.lineResult.allLines).toEqual([]);
        });

        it("returns a well-formed empty result when no columns are detected", () => {
            // Single tiny line in the margin → after filtering, nothing left
            const pages = [
                makePage(0, [
                    {
                        wmode: 0,
                        bbox: { x: 5, y: 5, w: 10, h: 5 },
                        font: {
                            name: "X",
                            family: "X",
                            weight: "normal",
                            style: "normal",
                            size: 5,
                        },
                        x: 5,
                        y: 5,
                        text: "x",
                    },
                ]),
            ];
            const out = detectFilteredParagraphs({ pages, pageIndex: 0 });
            expect(out.paragraphResult.items).toEqual([]);
            expect(out.paragraphResult.itemLines).toEqual([]);
        });
    });

    describe("caller-supplied precomputed values", () => {
        it("reuses caller-supplied marginRemoval without recomputing", () => {
            const pages = [makePage(0, [bodyLine("Body text.", 200)])];

            // Build a marginRemoval that flags "Body text." for removal
            // (synthetic — wouldn't naturally arise from these pages).
            // Confirm the helper uses it as-is by checking the candidate
            // array on the output matches the synthetic input.
            const synthetic = MarginFilter.identifyElementsToRemove(
                MarginFilter.collectMarginElements(pages, DEFAULT_MARGIN_ZONE),
                3,
                true,
            );
            // Tag the synthetic with a unique candidate so we can verify
            // identity reuse:
            synthetic.candidates.push({
                text: "synthetic-marker",
                originalText: "synthetic-marker",
                pageIndices: [0],
                reason: "repeat",
                position: "top",
            });

            const out = detectFilteredParagraphs({
                pages,
                pageIndex: 0,
                marginRemoval: synthetic,
            });
            expect(out.marginRemoval).toBe(synthetic);
            expect(
                out.marginRemoval.candidates.some(
                    (c) => c.text === "synthetic-marker",
                ),
            ).toBe(true);
        });

        it("reuses caller-supplied styleProfile without recomputing", () => {
            const pages = [makePage(0, [bodyLine("Body text here.", 200)])];
            const sp = new StyleAnalyzer().analyze(pages, 4, 0.15, 0);
            const out = detectFilteredParagraphs({
                pages,
                pageIndex: 0,
                styleProfile: sp,
            });
            expect(out.styleProfile).toBe(sp);
        });
    });

    describe("paragraph-result invariants", () => {
        it("populates itemLines aligned with items", () => {
            const pages = [
                makePage(0, [
                    bodyLine("First paragraph first line.", 200),
                    bodyLine("First paragraph second line.", 215),
                ]),
            ];
            const out = detectFilteredParagraphs({ pages, pageIndex: 0 });
            expect(out.paragraphResult.itemLines).toBeDefined();
            expect(out.paragraphResult.itemLines!.length).toBe(
                out.paragraphResult.items.length,
            );
        });
    });
});
