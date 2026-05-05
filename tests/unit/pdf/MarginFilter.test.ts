/**
 * Unit tests for MarginFilter.
 *
 * Tests are written against the public API only — no private helper
 * exports. Behavior split: bare-digit / bare-roman fixtures must reach
 * `page_number`; same-template prefix fixtures must reach `repeat`.
 */

import { describe, it, expect, test } from "vitest";
import { MarginFilter } from "../../../src/services/pdf/MarginFilter";
import type {
    MarginAnalysis,
    MarginElement,
    MarginPosition,
    RawLine,
} from "../../../src/services/pdf/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;

/** Minimal RawLine used as filler for MarginElement.line. */
function makeLine(text: string, x: number, y: number): RawLine {
    return {
        wmode: 0,
        bbox: { x, y, w: Math.max(1, text.length * 6), h: 10 },
        font: {
            name: "T",
            family: "T",
            weight: "normal",
            style: "normal",
            size: 8,
        },
        x,
        y,
        text,
    };
}

/**
 * Build a MarginAnalysis where each entry in `texts` is placed in the
 * top-right margin on a unique page (pageIndex 0..N-1).
 *
 * Position: top, near the top-right corner so margin classification is
 * unambiguous regardless of which margin zone constant is used.
 */
function oneTextPerPage(
    texts: string[],
    position: MarginPosition = "top",
): MarginAnalysis {
    const elements = new Map<MarginPosition, MarginElement[]>([
        ["top", []],
        ["bottom", []],
        ["left", []],
        ["right", []],
    ]);
    const x = position === "right" ? PAGE_W - 80 : 100;
    const y = position === "bottom" ? PAGE_H - 30 : 30;
    texts.forEach((text, pageIndex) => {
        const line = makeLine(text, x, y);
        elements.get(position)!.push({
            text,
            position,
            bbox: line.bbox,
            pageIndex,
            line,
        });
    });
    const counts = {
        top: elements.get("top")!.length,
        bottom: elements.get("bottom")!.length,
        left: elements.get("left")!.length,
        right: elements.get("right")!.length,
    };
    return { elements, counts };
}

// ---------------------------------------------------------------------------
// Step 1 + Step 4: parser coverage via the sequence path
// ---------------------------------------------------------------------------

describe("sequence detection — bare digits and romans (parser-only path)", () => {
    const fixtures: { name: string; pages: string[] }[] = [
        { name: "ascending bare digits", pages: ["1", "2", "3", "4", "5"] },
        { name: "ascending bare digits, 100s", pages: ["100", "101", "102", "103", "104"] },
        { name: "lowercase romans 1-5", pages: ["i", "ii", "iii", "iv", "v"] },
        { name: "uppercase romans 11-15", pages: ["XI", "XII", "XIII", "XIV", "XV"] },
        { name: "romans past 20 (Step 4 expansion)", pages: ["xxi", "xxii", "xxiii", "xxiv", "xxv"] },
    ];
    test.each(fixtures)("$name → page_number", ({ pages }) => {
        const analysis = oneTextPerPage(pages);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });

    it("Roman parser rejects single-letter glyphs (M, D, C) above bound", () => {
        // ROMAN_MAX = 50; M=1000, D=500, C=100 all exceed and must NOT
        // become page numbers.
        const analysis = oneTextPerPage(["M", "MM", "MMM"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        // No sequence candidate (none parse).
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
    });

    it("Roman parser rejects malformed strings", () => {
        const analysis = oneTextPerPage(["iiii", "vx", "xxxx"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Step 1: the original bug — "X of 13"
// ---------------------------------------------------------------------------

describe("'X of N' indicators — the original bug", () => {
    it("filters 'X of N' via the sequence path", () => {
        // Bare connector forms are NOT templated — they go through the
        // sequence path. parsePageNumber("3 of 13") = 3 (Step 1 fix), so
        // the values 1..5 strictly increase and page_number fires.
        const analysis = oneTextPerPage([
            "1 of 13", "2 of 13", "3 of 13", "4 of 13", "5 of 13",
        ]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
        // Every variant lands in textsToRemove so the per-page filter
        // and external debug consumers can match against exact text.
        expect(out.textsToRemove.has("3 of 13")).toBe(true);
        expect(out.textsToRemove.has("1 of 13")).toBe(true);
        expect(out.textsToRemove.has("5 of 13")).toBe(true);
    });

    it("filters 'X/N' via the sequence path", () => {
        const analysis = oneTextPerPage(["1/13", "2/13", "3/13", "4/13", "5/13"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });

    it("filters 'Page X of N' via templating (prefix-anchored)", () => {
        const analysis = oneTextPerPage([
            "Page 1 of 13", "Page 2 of 13", "Page 3 of 13",
            "Page 4 of 13", "Page 5 of 13",
        ]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(true);
        expect(out.textsToRemove.has("page 3 of 13")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Step 2: multilingual coverage
// ---------------------------------------------------------------------------

describe("multilingual parser coverage — varied templates exercise sequence path", () => {
    it("structured forms with varied templates trigger page_number", () => {
        // Each entry templates to a different key (page §N, p. §N, §N/§N,
        // §N of §N, §N von §N), so templated-repeat never groups ≥3 of
        // them. Sequence path sees parsed values 1,2,3,4,5 → strictly
        // increasing → page_number.
        const pages = ["page 1", "p. 2", "3/10", "4 of 10", "5 von 10"];
        const out = MarginFilter.identifyElementsToRemove(
            oneTextPerPage(pages), 3, true,
        );
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });
});

describe("multilingual same-template repeats (templated branch)", () => {
    const sameTemplateFixtures: { name: string; pages: string[] }[] = [
        { name: "Seite N", pages: ["Seite 1", "Seite 2", "Seite 3", "Seite 4", "Seite 5"] },
        { name: "página N", pages: ["página 1", "página 2", "página 3", "página 4", "página 5"] },
        { name: "第 K 页", pages: ["第 1 页", "第 2 页", "第 3 页", "第 4 页", "第 5 页"] },
        { name: "K쪽", pages: ["1쪽", "2쪽", "3쪽", "4쪽", "5쪽"] },
        { name: "p. K", pages: ["p. 1", "p. 2", "p. 3", "p. 4", "p. 5"] },
    ];
    test.each(sameTemplateFixtures)("$name → repeat (templated)", ({ pages }) => {
        const out = MarginFilter.identifyElementsToRemove(
            oneTextPerPage(pages), 3, true,
        );
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(true);
    });
});

describe("non-ASCII digit normalization", () => {
    it("Arabic-Indic digits in 'X of Y' form parse correctly", () => {
        // ١=1 ٢=2 ٣=3 ٤=4 ٥=5 (Arabic-Indic). Page indicator "K of ١٣".
        const analysis = oneTextPerPage([
            "١ of ١٣", "٢ of ١٣", "٣ of ١٣", "٤ of ١٣", "٥ of ١٣",
        ]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });

    it("full-width digits fold to ASCII via NFKC", () => {
        // １=1, ２=2, ３=3 etc. Pure full-width digits.
        const analysis = oneTextPerPage(["１", "２", "３", "４", "５"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Two co-located page-number families in the same margin zone
// ---------------------------------------------------------------------------

describe("co-located page-number families in the same zone", () => {
    it("removes BOTH 'Page K' and 'K of 13' when they share a zone", () => {
        // 5 pages × 2 elements per page in the top zone:
        //   - "Page K"   → templated repeat (tpl:page §N)
        //   - "K of 13"  → sequence path (parses to K)
        // Without the textsToRemove dedup, sequence collection sees the
        // interleaved values [1,1,2,2,3,3,4,4,5,5] and isIncreasingSequence
        // fails — silently dropping the "K of 13" family.
        const elements: MarginElement[] = [];
        for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
            const k = pageIndex + 1;
            for (const text of [`Page ${k}`, `${k} of 13`]) {
                const line = makeLine(text, 100 + (text.length * 10), 30);
                elements.push({
                    text,
                    position: "top",
                    bbox: line.bbox,
                    pageIndex,
                    line,
                });
            }
        }
        const analysis: MarginAnalysis = {
            elements: new Map<MarginPosition, MarginElement[]>([
                ["top", elements],
                ["bottom", []],
                ["left", []],
                ["right", []],
            ]),
            counts: { top: elements.length, bottom: 0, left: 0, right: 0 },
        };
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        // Page K family → repeat
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(true);
        // K of 13 family → page_number (sequence path, post-dedup)
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
        // Both variants land in textsToRemove
        expect(out.textsToRemove.has("page 3")).toBe(true);
        expect(out.textsToRemove.has("3 of 13")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Step 3: templating gate behavior — positives and negatives
// ---------------------------------------------------------------------------

describe("templating gate — positives", () => {
    it("collapses 'Page N' across pages to one repeat candidate", () => {
        const analysis = oneTextPerPage([
            "Page 1", "Page 2", "Page 3", "Page 4", "Page 5",
        ]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        const repeats = out.candidates.filter((c) => c.reason === "repeat");
        expect(repeats.length).toBe(1);
        // Variants from every page land in textsToRemove.
        expect(out.textsToRemove.has("page 1")).toBe(true);
        expect(out.textsToRemove.has("page 5")).toBe(true);
    });

    it("variantPages: removalsByPage only contains variants from that page", () => {
        const analysis = oneTextPerPage(["Page 1", "Page 2", "Page 3"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        // Page 0 saw "page 1", not "page 2" or "page 3".
        const page0 = out.removalsByPage.get(0);
        expect(page0?.has("page 1")).toBe(true);
        expect(page0?.has("page 2")).toBe(false);
        expect(page0?.has("page 3")).toBe(false);
        const page2 = out.removalsByPage.get(2);
        expect(page2?.has("page 3")).toBe(true);
        expect(page2?.has("page 1")).toBe(false);
    });
});

describe("templating gate — negatives (no over-removal)", () => {
    it("does NOT remove hyphenated numeric codes via either path", () => {
        // "2024-05" / "2025-06" / "2026-07" — bare hyphen is excluded
        // from PAGE_NUMBER_PATTERNS entirely. Neither sequence (no
        // parsed values) nor templating (gate is false) engages, and
        // exact-text repeats don't fire because all three texts differ.
        const analysis = oneTextPerPage(["2024-05", "2025-06", "2026-07"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.length).toBe(0);
    });

    it("does NOT remove plain '3-15' style ranges (no prefix, no page-marker)", () => {
        const analysis = oneTextPerPage(["3-15", "4-16", "5-17"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.length).toBe(0);
    });

    it("does NOT template year-like sequences (templating not responsible for year false-positives)", () => {
        const analysis = oneTextPerPage(["2024", "2025", "2026"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        // Pin: templating must NOT collapse years.
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(false);
        // (The sequence path may still flag these as page_number — a
        // pre-existing limitation independent of this plan.)
    });

    it("does NOT template 'Chapter N' across pages", () => {
        const analysis = oneTextPerPage(["Chapter 1", "Chapter 2", "Chapter 3"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(false);
    });

    it("does NOT template 'Table N' across pages", () => {
        const analysis = oneTextPerPage(["Table 1", "Table 2", "Table 3"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Repeat-vs-sequence behavior split (renamed from the misleading "42" test)
// ---------------------------------------------------------------------------

describe("repeated identical numeric text", () => {
    it("is flagged as repeat (not sequence) — exact-text grouping path", () => {
        const analysis = oneTextPerPage(["42", "42", "42"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        // Same number on every page → not strictly increasing → no page_number.
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
        // But it IS the same exact text on ≥3 pages → flagged as repeat.
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Threshold behavior
// ---------------------------------------------------------------------------

describe("requiredCount threshold", () => {
    it("does not flag a 2-page templated group when requiredCount=3", () => {
        const analysis = oneTextPerPage(["Page 1", "Page 2"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(false);
    });

    it("flags a 2-page templated group when requiredCount=2", () => {
        const analysis = oneTextPerPage(["Page 1", "Page 2"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 2, true);
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(true);
    });
});
