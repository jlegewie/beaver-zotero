/**
 * Unit tests for MarginFilter.
 *
 * Tests are written against the public API only — no private helper
 * exports. Behavior split: bare-digit / bare-roman fixtures must reach
 * `page_number`; same-template prefix fixtures must reach `repeat`.
 */

import { describe, it, expect, test } from "vitest";
import {
    MarginFilter,
    getEffectiveRepeatThreshold,
} from "../../../src/services/pdf/MarginFilter";
import type {
    MarginAnalysis,
    MarginElement,
    MarginPosition,
    MarginRemovalResult,
    RawBlock,
    RawLine,
    RawPageData,
    TextStyle,
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
    return { elements, counts, offMarginPageNumberCandidates: [] };
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
// Two valid page-number runs in the same margin position, split by numeral
// system (Roman preface + Arabic body — standard dissertation/book layout).
// Concatenating their parsed values would produce a non-monotone list, so
// the sequence detector must validate each numeral system independently.
// ---------------------------------------------------------------------------

describe("two page-number runs in the same margin position split by numeral system", () => {
    it("detects both Roman and Arabic sequences when concatenation would fail", () => {
        // Pages 0–4: iii, iv, v, vi, vii (Roman, parsed values 3,4,5,6,7).
        // Pages 5–9: 1, 2, 3, 4, 5 (Arabic). Concatenated values are
        // [3,4,5,6,7,1,2,3,4,5] — NOT strictly increasing — so a single-
        // bucket validator would reject the whole thing. Per-script
        // bucketing detects both runs.
        const out = MarginFilter.identifyElementsToRemove(
            oneTextPerPage(
                ["iii", "iv", "v", "vi", "vii", "1", "2", "3", "4", "5"],
                "bottom",
            ),
            3,
            true,
        );

        const pageNumberTexts = out.candidates
            .filter((c) => c.reason === "page_number")
            .map((c) => c.text);
        expect(pageNumberTexts).toContain("iii");
        expect(pageNumberTexts).toContain("vii");
        expect(pageNumberTexts).toContain("1");
        expect(pageNumberTexts).toContain("5");

        expect(out.textsToRemove.has("iii")).toBe(true);
        expect(out.textsToRemove.has("vii")).toBe(true);
        expect(out.textsToRemove.has("1")).toBe(true);
        expect(out.textsToRemove.has("5")).toBe(true);

        expect(out.removalsByPage.get(0)?.has("iii")).toBe(true);
        expect(out.removalsByPage.get(4)?.has("vii")).toBe(true);
        expect(out.removalsByPage.get(5)?.has("1")).toBe(true);
        expect(out.removalsByPage.get(9)?.has("5")).toBe(true);
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
            offMarginPageNumberCandidates: [],
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

// ---------------------------------------------------------------------------
// Fix 4a: middot-wrapped page numbers (Chinese journal stripe `·NNNN·`)
// ---------------------------------------------------------------------------

describe("middot-wrapped page numbers", () => {
    const middotFixtures: { name: string; pages: string[] }[] = [
        { name: "U+00B7 wrap", pages: ["·2466·", "·2467·", "·2468·"] },
        { name: "U+30FB wrap", pages: ["・100・", "・101・", "・102・"] },
        { name: "U+2027 wrap", pages: ["‧42‧", "‧43‧", "‧44‧"] },
    ];
    test.each(middotFixtures)(
        "$name on 3 pages → caught via templating (single repeat candidate)",
        ({ pages }) => {
            const analysis = oneTextPerPage(pages);
            const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
            // Templated → one repeat candidate, not three separate ones.
            const repeatCandidates = out.candidates.filter((c) => c.reason === "repeat");
            expect(repeatCandidates).toHaveLength(1);
            expect(repeatCandidates[0].pageIndices).toEqual([0, 1, 2]);
        },
    );

    it("rejects bare middot with no digits", () => {
        const analysis = oneTextPerPage(["·", "·", "·"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
    });

    it("relaxed top-margin threshold (=2) catches ·NNNN· on 2 pages via templating", () => {
        const analysis = oneTextPerPage(["·2466·", "·2467·"]);
        const out = MarginFilter.identifyElementsToRemove(
            analysis,
            { topBottom: 2, leftRight: 3 },
            true,
        );
        const repeatCandidates = out.candidates.filter((c) => c.reason === "repeat");
        expect(repeatCandidates).toHaveLength(1);
        expect(repeatCandidates[0].pageIndices).toEqual([0, 1]);
    });
});

// ---------------------------------------------------------------------------
// Fix 4b: getEffectiveRepeatThreshold helper
// ---------------------------------------------------------------------------

describe("getEffectiveRepeatThreshold", () => {
    it("uses adaptive default for short docs (≤6 pages): top/bottom=2, left/right=3", () => {
        const t = getEffectiveRepeatThreshold({ analysisPageCount: 5 });
        expect(t).toEqual({ topBottom: 2, leftRight: 3 });
    });

    it("uses default 3 everywhere for longer docs", () => {
        const t = getEffectiveRepeatThreshold({ analysisPageCount: 20 });
        expect(t).toEqual({ topBottom: 3, leftRight: 3 });
    });

    it("respects explicit caller value (applied to both positions)", () => {
        const t = getEffectiveRepeatThreshold({
            requested: 5,
            analysisPageCount: 4, // short doc
        });
        expect(t).toEqual({ topBottom: 5, leftRight: 5 });
    });

    it("explicit value of 3 overrides relaxation on a short doc", () => {
        const t = getEffectiveRepeatThreshold({
            requested: 3,
            analysisPageCount: 4,
        });
        expect(t).toEqual({ topBottom: 3, leftRight: 3 });
    });

    it("ignores invalid requested values (0, negative, NaN, non-integer)", () => {
        // analysisPageCount=4 (short doc) → should fall back to adaptive.
        for (const requested of [0, -1, NaN, 2.5]) {
            const t = getEffectiveRepeatThreshold({
                requested,
                analysisPageCount: 4,
            });
            expect(t).toEqual({ topBottom: 2, leftRight: 3 });
        }
    });

    it("undefined analysisPageCount=0 falls back to default 3", () => {
        const t = getEffectiveRepeatThreshold({ analysisPageCount: 0 });
        expect(t).toEqual({ topBottom: 3, leftRight: 3 });
    });

    it("boundary: 6-page doc (≤6) gets relaxed, 7-page doc (>6) does not", () => {
        expect(getEffectiveRepeatThreshold({ analysisPageCount: 6 }))
            .toEqual({ topBottom: 2, leftRight: 3 });
        expect(getEffectiveRepeatThreshold({ analysisPageCount: 7 }))
            .toEqual({ topBottom: 3, leftRight: 3 });
    });

    // totalPageCount is the authoritative signal — a 5-page subset of a
    // 100-page paper should NOT relax.
    it("totalPageCount=100 with analysisPageCount=5 does NOT relax", () => {
        const t = getEffectiveRepeatThreshold({
            totalPageCount: 100,
            analysisPageCount: 5,
        });
        expect(t).toEqual({ topBottom: 3, leftRight: 3 });
    });

    it("totalPageCount=4 with analysisPageCount=4 DOES relax (genuinely short doc)", () => {
        const t = getEffectiveRepeatThreshold({
            totalPageCount: 4,
            analysisPageCount: 4,
        });
        expect(t).toEqual({ topBottom: 2, leftRight: 3 });
    });

    it("totalPageCount missing falls back to analysisPageCount (best-effort)", () => {
        const t = getEffectiveRepeatThreshold({ analysisPageCount: 5 });
        expect(t).toEqual({ topBottom: 2, leftRight: 3 });
    });

    it("totalPageCount=0 (invalid) falls back to analysisPageCount", () => {
        const t = getEffectiveRepeatThreshold({
            totalPageCount: 0,
            analysisPageCount: 5,
        });
        expect(t).toEqual({ topBottom: 2, leftRight: 3 });
    });
});

// ---------------------------------------------------------------------------
// Fix 4b: per-position threshold inside identifyElementsToRemove
// ---------------------------------------------------------------------------

describe("per-position threshold object", () => {
    it("top-margin candidate on 2 pages: caught with topBottom=2, missed with topBottom=3", () => {
        const analysis = oneTextPerPage(["recto title", "recto title"], "top");
        const caught = MarginFilter.identifyElementsToRemove(
            analysis,
            { topBottom: 2, leftRight: 3 },
            true,
        );
        expect(caught.candidates.some((c) => c.reason === "repeat")).toBe(true);

        const missed = MarginFilter.identifyElementsToRemove(
            analysis,
            { topBottom: 3, leftRight: 3 },
            true,
        );
        expect(missed.candidates.some((c) => c.reason === "repeat")).toBe(false);
    });

    it("left-margin candidate on 2 pages: NOT caught even when topBottom=2 (leftRight stays 3)", () => {
        const analysis = oneTextPerPage(["sidebar text", "sidebar text"], "left");
        const out = MarginFilter.identifyElementsToRemove(
            analysis,
            { topBottom: 2, leftRight: 3 },
            true,
        );
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(false);
    });

    it("numeric form preserves single-threshold backward compat", () => {
        const analysis = oneTextPerPage(["repeating", "repeating", "repeating"]);
        // numeric 3 → same as { topBottom: 3, leftRight: 3 }.
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "repeat")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Fix 4b: distinct-page guard on page-number-sequence path
// ---------------------------------------------------------------------------

describe("page-number-sequence distinct-page guard", () => {
    it("does not flag a single page that emits two numeric margin elements as a sequence", () => {
        // Two separate elements on page 0 only. Old code would compare
        // pageNumberElements.length (2) >= requiredForPosition (2) and try
        // to build a sequence from `[1, 2]` → falsely detect.
        const elements = new Map<MarginPosition, MarginElement[]>([
            ["top", []],
            ["bottom", []],
            ["left", []],
            ["right", []],
        ]);
        for (const value of ["1", "2"]) {
            const line = makeLine(value, 100, 30);
            elements.get("top")!.push({
                text: value,
                position: "top",
                bbox: line.bbox,
                pageIndex: 0, // both on the SAME page
                line,
            });
        }
        const analysis: MarginAnalysis = {
            elements,
            counts: { top: 2, bottom: 0, left: 0, right: 0 },
            offMarginPageNumberCandidates: [],
        };
        const out = MarginFilter.identifyElementsToRemove(
            analysis,
            { topBottom: 2, leftRight: 3 },
            true,
        );
        // Only 1 distinct page → guard fails → no page_number candidate.
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
    });

    it("still flags page numbers when distinct pages reach the threshold", () => {
        const analysis = oneTextPerPage(["1", "2"]);
        const out = MarginFilter.identifyElementsToRemove(
            analysis,
            { topBottom: 2, leftRight: 3 },
            true,
        );
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });

    it("collapses to one element per page before the increasing-sequence check", () => {
        // Each page emits TWO numeric margin elements (e.g. left+right
        // headers both showing the same page number). Raw value list
        // would be `[1, 1, 2, 2, 3, 3]` which is NOT strictly
        // increasing; the per-page collapse picks one per page and
        // tests `[1, 2, 3]` which IS increasing.
        const elements = new Map<MarginPosition, MarginElement[]>([
            ["top", []],
            ["bottom", []],
            ["left", []],
            ["right", []],
        ]);
        for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
            // Two elements on each page with the same numeric value.
            const value = String(pageIndex + 1);
            for (let slot = 0; slot < 2; slot++) {
                const line = makeLine(value, 100 + slot * 200, 30);
                elements.get("top")!.push({
                    text: value,
                    position: "top",
                    bbox: line.bbox,
                    pageIndex,
                    line,
                });
            }
        }
        const analysis: MarginAnalysis = {
            elements,
            counts: { top: 6, bottom: 0, left: 0, right: 0 },
            offMarginPageNumberCandidates: [],
        };
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        // Sequence detected → page_number candidates emitted.
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Off-margin page-number sequences — page numbers placed at a "natural
// footer" position that the smart-removal zone misses (common in JSTOR /
// digital-archive scans where the archive watermark sits below the
// original page number). Detection should pick them up on cross-page
// monotone increase clustered at a consistent y position; non-monotone
// or scattered numerics must NOT be misclassified.
// ---------------------------------------------------------------------------

describe("off-margin page-number sequence — natural-footer layout", () => {
    /**
     * Build an analysis with N off-margin page-number candidates,
     * one per page, all at the same y position. Mirrors the JSTOR
     * footer-with-watermark layout where the page number sits just
     * above the watermark but outside the margin zone.
     */
    function buildOffMargin(
        texts: string[],
        opts: { y?: number; jitter?: number } = {},
    ): MarginAnalysis {
        const { y = 620, jitter = 0 } = opts;
        const offMargin: MarginElement[] = [];
        texts.forEach((text, pageIndex) => {
            const lineY = y + (jitter ? pageIndex * jitter : 0);
            const line = makeLine(text, 100, lineY);
            offMargin.push({
                text,
                // Page midline = PAGE_H/2 = 396. y=620 > 396 → bottom.
                position: lineY < PAGE_H / 2 ? "top" : "bottom",
                bbox: line.bbox,
                pageIndex,
                line,
            });
        });
        return {
            elements: new Map<MarginPosition, MarginElement[]>([
                ["top", []],
                ["bottom", []],
                ["left", []],
                ["right", []],
            ]),
            counts: { top: 0, bottom: 0, left: 0, right: 0 },
            offMarginPageNumberCandidates: offMargin,
        };
    }

    it("detects monotone sequence at consistent y outside margin zone", () => {
        // 5 pages of bare-digit page numbers at y=620 (page midline=396
        // so synthesized side=bottom). Bottom margin zone of 80pt
        // starts at y=712 → these candidates are off-margin.
        const analysis = buildOffMargin(["1199", "1200", "1201", "1202", "1203"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);

        const pageNumberCandidate = out.candidates.find(
            (c) => c.reason === "page_number" && c.text === "1199",
        );
        expect(pageNumberCandidate).toBeDefined();
        expect(pageNumberCandidate!.position).toBe("bottom");

        // Off-margin removals populated per-page (so the per-page
        // filter can drop them without consulting the margin zone).
        expect(out.offMarginPageNumberRemovals.get(0)?.has("1199")).toBe(true);
        expect(out.offMarginPageNumberRemovals.get(4)?.has("1203")).toBe(true);

        // textsToRemove tracks them for debug visibility too.
        expect(out.textsToRemove.has("1199")).toBe(true);
        expect(out.textsToRemove.has("1203")).toBe(true);

        // The general per-page removals path is NOT used for off-margin
        // entries (those need bypass-zone logic at filter time).
        expect(out.removalsByPage.has(0)).toBe(false);
    });

    it("ignores off-margin numerics that don't form an increasing sequence", () => {
        // Five short numbers at consistent y, but values jump around
        // (e.g. table values across pages, not page numbers).
        const analysis = buildOffMargin(["299", "495", "911", "364", "405"]);
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);

        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
        expect(out.offMarginPageNumberRemovals.size).toBe(0);
    });

    it("ignores off-margin numerics that drift across y buckets", () => {
        // Monotone values but each page's numeric lands at a different
        // y position (50pt drift per page). Cluster gate prevents these
        // from being treated as page numbers.
        const analysis = buildOffMargin(
            ["1", "2", "3", "4", "5"],
            { y: 300, jitter: 50 },
        );
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(out.candidates.some((c) => c.reason === "page_number")).toBe(false);
    });

    it("respects the requiredCount threshold on off-margin sequences", () => {
        // Only 2 distinct pages. Default threshold of 3 should miss it;
        // explicit threshold of 2 should catch it.
        const analysis = buildOffMargin(["1", "2"]);
        const outDefault = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        expect(outDefault.candidates.some((c) => c.reason === "page_number")).toBe(false);

        const outRelaxed = MarginFilter.identifyElementsToRemove(analysis, 2, true);
        expect(outRelaxed.candidates.some((c) => c.reason === "page_number")).toBe(true);
    });

    it("collectMarginElements promotes off-margin page-number lines", () => {
        // End-to-end: build a RawPageData with the page number drawn
        // at a natural footer position outside the margin zone, then
        // verify collectMarginElements drops it into the off-margin
        // candidate bucket (not the regular position elements).
        const pages: RawPageData[] = [];
        for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
            const pageNumberLine = makeLine(String(1199 + pageIndex), 100, 620);
            const bodyLine = makeLine("body text on this page", 60, 300);
            const block: RawBlock = {
                type: "text",
                bbox: { x: 0, y: 0, w: PAGE_W, h: PAGE_H },
                lines: [bodyLine, pageNumberLine],
            };
            pages.push({
                pageIndex,
                pageNumber: pageIndex + 1,
                width: PAGE_W,
                height: PAGE_H,
                blocks: [block],
            });
        }
        const marginZone = { left: 60, top: 80, right: 60, bottom: 80 };
        const analysis = MarginFilter.collectMarginElements(pages, marginZone);

        // No regular margin elements (everything is mid-page).
        expect(analysis.counts).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });

        // 4 off-margin page-number candidates collected.
        expect(analysis.offMarginPageNumberCandidates).toHaveLength(4);

        // Sequence pass picks them up and writes the per-page removal map.
        const removal = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        for (let p = 0; p < 4; p++) {
            expect(removal.offMarginPageNumberRemovals.get(p)?.has(String(1199 + p)))
                .toBe(true);
        }
    });

    it("filterPageWithSmartRemoval drops off-margin page numbers without zone gate", () => {
        // Single page with the page number "1228" at y=620 — outside
        // every margin zone (bottom zone starts at y=712, page is 792).
        const pageNumberLine = makeStyledLine("1228", 100, 620, 20, "T", 10);
        const bodyLine = makeStyledLine("body content", 60, 300, 250, "T", 10);
        const page = makePageWithLines([bodyLine, pageNumberLine]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const removal: MarginRemovalResult = {
            candidates: [
                {
                    text: "1228",
                    originalText: "1228",
                    reason: "page_number",
                    position: "bottom",
                    pageIndices: [0],
                },
            ],
            textsToRemove: new Set(["1228"]),
            removalsByPage: new Map(),
            offMarginPageNumberRemovals: new Map([[0, new Set(["1228"])]]),
        };

        const filtered = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            removal,
        );
        const remainingTexts = filtered.blocks
            .flatMap((b) => (b.type === "text" ? b.lines ?? [] : []))
            .map((L) => L.text);
        expect(remainingTexts).toContain("body content");
        expect(remainingTexts).not.toContain("1228");
    });
});

// ---------------------------------------------------------------------------
// Fix 4: end-to-end split-line alternating recto/verso headers
// ---------------------------------------------------------------------------

describe("split-line alternating headers (5I23IGRY shape)", () => {
    /**
     * Build a 4-page synthetic fixture mirroring the shape of the
     * 5I23IGRY journal:
     *   - even pages (0, 2): three top-margin elements per page —
     *     `·NNNN·` (left), `化工进展` (center), `2012年第31卷` (right)
     *   - odd pages (1, 3): three top-margin elements per page —
     *     `第11期` (left), `李磊等：Beta沸石合成研究进展` (center), `·NNNN·` (right)
     *
     * MuPDF emits each text run as its own raw line, so the cross-page
     * grouping sees 4 distinct verso lines and 4 distinct recto lines
     * with the page-number stripe varying per page.
     */
    function build4PageHeaders(): MarginAnalysis {
        const elements = new Map<MarginPosition, MarginElement[]>([
            ["top", []],
            ["bottom", []],
            ["left", []],
            ["right", []],
        ]);
        const top = elements.get("top")!;

        const versoCenter = "化工进展";
        const versoRight = "2012年第31卷";
        const rectoLeft = "第11期";
        const rectoCenter = "李磊等：Beta沸石合成研究进展";

        const pageNumbers = ["·2466·", "·2467·", "·2468·", "·2469·"];

        for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
            const pn = pageNumbers[pageIndex];
            if (pageIndex % 2 === 0) {
                // verso: pn (left) + journal title (center) + volume (right)
                for (const text of [pn, versoCenter, versoRight]) {
                    const line = makeLine(text, 100, 30);
                    top.push({ text, position: "top", bbox: line.bbox, pageIndex, line });
                }
            } else {
                // recto: 第11期 (left) + author/title (center) + pn (right)
                for (const text of [rectoLeft, rectoCenter, pn]) {
                    const line = makeLine(text, 100, 30);
                    top.push({ text, position: "top", bbox: line.bbox, pageIndex, line });
                }
            }
        }

        const counts = { top: top.length, bottom: 0, left: 0, right: 0 };
        return { elements, counts, offMarginPageNumberCandidates: [] };
    }

    it("relaxed threshold (4-page short doc) catches both verso and recto text repeats AND middot stripe", () => {
        const analysis = build4PageHeaders();
        const thresholds = getEffectiveRepeatThreshold({ analysisPageCount: 4 });
        // Sanity: helper relaxed top to 2.
        expect(thresholds.topBottom).toBe(2);

        const out = MarginFilter.identifyElementsToRemove(analysis, thresholds, true);
        const texts = out.candidates
            .filter((c) => c.reason === "repeat")
            .map((c) => c.text);
        // Verso text-heavy parts (each on 2 pages):
        expect(texts).toContain("化工进展");
        expect(texts).toContain("2012年第31卷");
        // Recto text-heavy parts (each on 2 pages):
        expect(texts).toContain("第11期");
        expect(texts).toContain("李磊等：beta沸石合成研究进展"); // normalized lowercase
        // Middot-wrapped page numbers grouped by templating — `·2466·`,
        // `·2467·`, `·2468·`, `·2469·` collapse to one template family
        // covering all 4 pages.
        const middotCandidate = out.candidates.find(
            (c) => c.reason === "repeat" && /·\d+·/.test(c.originalText),
        );
        expect(middotCandidate).toBeDefined();
        expect(middotCandidate!.pageIndices).toEqual([0, 1, 2, 3]);
    });

    it("default threshold of 3 misses the alternating verso/recto headers (regression baseline)", () => {
        const analysis = build4PageHeaders();
        const out = MarginFilter.identifyElementsToRemove(analysis, 3, true);
        const texts = out.candidates
            .filter((c) => c.reason === "repeat")
            .map((c) => c.text);
        // 化工进展 only on 2 pages → not enough.
        expect(texts).not.toContain("化工进展");
        expect(texts).not.toContain("第11期");
        // The middot family still hits 4 pages → still caught.
        expect(out.candidates.some(
            (c) => c.reason === "repeat" && /·\d+·/.test(c.originalText),
        )).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Body-style spare — tight-margin layouts
// ---------------------------------------------------------------------------

const BODY_STYLE: TextStyle = {
    size: 9,
    font: "MinionPro-Regular",
    bold: false,
    italic: false,
};

function makeStyledLine(
    text: string,
    x: number,
    y: number,
    w: number,
    fontName: string,
    fontSize: number,
): RawLine {
    return {
        wmode: 0,
        bbox: { x, y, w, h: 9 },
        font: {
            name: fontName,
            family: fontName,
            weight: "normal",
            style: "normal",
            size: fontSize,
        },
        x,
        y,
        text,
    };
}

function makePageWithLines(lines: RawLine[]): RawPageData {
    const block: RawBlock = {
        type: "text",
        bbox: {
            x: Math.min(...lines.map((L) => L.bbox.x)),
            y: Math.min(...lines.map((L) => L.bbox.y)),
            w: 400,
            h: PAGE_H,
        },
        lines,
    };
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: PAGE_W,
        height: PAGE_H,
        blocks: [block],
    };
}

const EMPTY_REMOVAL: MarginRemovalResult = {
    candidates: [],
    textsToRemove: new Set(),
    removalsByPage: new Map(),
    offMarginPageNumberRemovals: new Map(),
};

describe("filterPageWithSmartRemoval — body-style spare", () => {
    it("spares a body-styled line that is entirely in the bottom-margin band", () => {
        // Page 792pt tall, simple bottom margin 40pt → margin band starts at y=752.
        // Body line at y=755 is entirely in the bottom margin.
        const bodyLine = makeStyledLine(
            "ture must be understood within the larger",
            45,
            755,
            300,
            "MinionPro-Regular",
            9,
        );
        const page = makePageWithLines([bodyLine]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const without = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            EMPTY_REMOVAL,
        );
        // No bodyStyles → simple filter drops the line as before.
        expect(without.blocks).toHaveLength(0);

        const withBody = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            EMPTY_REMOVAL,
            [BODY_STYLE],
        );
        expect(withBody.blocks).toHaveLength(1);
        expect(withBody.blocks[0].lines).toHaveLength(1);
        expect(withBody.blocks[0].lines![0].text).toBe(
            "ture must be understood within the larger",
        );
    });

    it("still drops non-body-styled marginalia (smaller font / different style) from the margin band", () => {
        // "index.html" footnote-style line in the bottom margin, smaller
        // font than body — typical for hyperlink footers / running URLs.
        const marginaliaLine = makeStyledLine(
            "index.html",
            45,
            755,
            60,
            "MinionPro-Regular",
            7, // ≠ body size 9
        );
        const page = makePageWithLines([marginaliaLine]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const filtered = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            EMPTY_REMOVAL,
            [BODY_STYLE],
        );
        expect(filtered.blocks).toHaveLength(0);
    });

    it("drops a body-font page number from the margin band (style match alone isn't enough — substance check)", () => {
        // Page number "17" rendered in the body font size in the bottom-
        // margin band. Style alone would falsely spare this; the substance
        // gate (≥2 words AND ≥8 alnum chars) keeps it out of extraction.
        // Mirrors the DPKD3QHI page-17 regression where smart-removal's
        // page-number sequence detector missed the bottom-margin sequence.
        const pageNumberLine = makeStyledLine(
            "17",
            292,
            760,
            10,
            "MinionPro-Regular",
            9, // body size + body font
        );
        const page = makePageWithLines([pageNumberLine]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const filtered = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            EMPTY_REMOVAL,
            [BODY_STYLE],
        );
        expect(filtered.blocks).toHaveLength(0);
    });

    it("drops a single-token body-font label like 'ESSAY' from the margin band (1 word fails the substance gate)", () => {
        const labelLine = makeStyledLine(
            "ESSAY",
            528,
            760,
            32,
            "MinionPro-Regular",
            9,
        );
        const page = makePageWithLines([labelLine]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const filtered = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            EMPTY_REMOVAL,
            [BODY_STYLE],
        );
        expect(filtered.blocks).toHaveLength(0);
    });

    it("smart-removal still beats the body-style spare (repeating body-styled header)", () => {
        // Body-styled line that ALSO matches a smart-removal candidate
        // (e.g. a section header that repeats across pages). The smart-
        // removal pass should still drop it.
        const repeatingHeader = makeStyledLine(
            "Repeating Header",
            45,
            755,
            120,
            "MinionPro-Regular",
            9,
        );
        const page = makePageWithLines([repeatingHeader]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const removal: MarginRemovalResult = {
            candidates: [
                {
                    text: "repeating header",
                    originalText: "Repeating Header",
                    reason: "repeat",
                    position: "bottom",
                    pageIndices: [0, 1, 2],
                },
            ],
            textsToRemove: new Set(["repeating header"]),
            removalsByPage: new Map([[0, new Set(["repeating header"])]]),
            offMarginPageNumberRemovals: new Map(),
        };

        const filtered = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            removal,
            [BODY_STYLE],
        );
        expect(filtered.blocks).toHaveLength(0);
    });

    it("keeps body-styled content normally inside the content area (regression: spare doesn't change in-content behavior)", () => {
        const inBody = makeStyledLine(
            "Inside the content area",
            45,
            400,
            200,
            "MinionPro-Regular",
            9,
        );
        const page = makePageWithLines([inBody]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };
        const zone = { left: 60, top: 80, right: 60, bottom: 80 };

        const filtered = MarginFilter.filterPageWithSmartRemoval(
            page,
            margins,
            zone,
            EMPTY_REMOVAL,
            [BODY_STYLE],
        );
        expect(filtered.blocks).toHaveLength(1);
        expect(filtered.blocks[0].lines).toHaveLength(1);
    });
});

describe("filterPageByMargins — body-style spare", () => {
    it("spares a body-styled line in the simple-margin band", () => {
        const bodyLine = makeStyledLine(
            "As a case study, we utilize the Charlie Hebdo attack",
            45,
            760,
            350,
            "MinionPro-Regular",
            9,
        );
        const page = makePageWithLines([bodyLine]);
        const margins = { left: 25, top: 40, right: 25, bottom: 40 };

        const without = MarginFilter.filterPageByMargins(page, margins);
        expect(without.blocks).toHaveLength(0);

        const withBody = MarginFilter.filterPageByMargins(page, margins, [
            BODY_STYLE,
        ]);
        expect(withBody.blocks).toHaveLength(1);
    });
});
