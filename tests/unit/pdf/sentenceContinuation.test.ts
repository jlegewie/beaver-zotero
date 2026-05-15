/**
 * Unit tests for `annotateColumnContinuations` in `ParagraphSentenceMapper.ts`.
 *
 * Hermetic — synthetic `DocItem` arrays, no MuPDF, no Zotero.
 *
 * Verifies the conservative cheap-gate + splitter-validation heuristic:
 *   - Sets `joinWithNext = true` only when adjacent body paragraphs in
 *     consecutive columns appear to share one sentence (last text not
 *     terminated, first text starts lowercase, splitter agrees).
 *   - Never writes explicit `false` (omitted ≡ false per SentenceItem contract).
 *   - Clears stale `true` from prior calls so the helper is idempotent.
 */
import { describe, it, expect } from "vitest";
import { annotateColumnContinuations } from "../../../src/beaver-extract/ParagraphSentenceMapper";
import { simpleRegexSentenceSplit } from "../../../src/beaver-extract/SentenceMapper";
import {
    bboxFromXYWH,
    type BoundingBox,
    type SectionHeaderItem,
    type SentenceItem,
    type TextItem,
} from "../../../src/beaver-extract/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSentence(
    text: string,
    overrides: Partial<SentenceItem> = {},
): SentenceItem {
    return {
        parentId: "",
        index: 0,
        text,
        bboxes: [],
        ...overrides,
    };
}

/**
 * Synthetic per-column geometry. Column N occupies x ∈ [50 + N*300, 50 + N*300 + 250]
 * with a 50pt gutter between columns. Mirrors the LTR multi-column shape the
 * geometric gate in `shouldJoinAcrossColumns` checks: column N+1 starts
 * strictly to the right of column N's right edge.
 */
function defaultBBoxForColumn(columnIndex: number): BoundingBox {
    const x = 50 + columnIndex * 300;
    return bboxFromXYWH(x, 0, 250, 12, "top-left");
}

function makeParagraph(
    columnIndex: number,
    sentences: SentenceItem[],
    opts: { type?: "paragraph" | "header"; idx?: number } = {},
): TextItem | SectionHeaderItem {
    const index = opts.idx ?? columnIndex;
    const id = `p0:i${index}`;
    // Auto-fill bboxes so tests don't have to specify geometry unless they're
    // exercising the geometric gate. Mutates in place so the caller's
    // sentence references still point at the same objects after the test
    // helper runs the producer.
    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        s.parentId = id;
        s.index = i;
        if (s.bboxes.length === 0) {
            s.bboxes = [defaultBBoxForColumn(columnIndex)];
        }
    }
    const itemBBox = sentences[0]?.bboxes[0] ?? defaultBBoxForColumn(columnIndex);
    const base = {
        id,
        pageIndex: 0,
        index,
        bbox: itemBBox,
        columnIndex,
        text: sentences.map((s) => s.text).join(" "),
        lines: [{ text: sentences.map((s) => s.text).join(" "), bbox: itemBBox }],
    };
    if (opts.type === "header") {
        return {
            ...base,
            kind: "section_header",
            level: 1,
        };
    }
    return {
        ...base,
        kind: "text",
        sentences,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("annotateColumnContinuations", () => {
    it("sets joinWithNext on the last sentence when columns continue mid-sentence", () => {
        const left = makeParagraph(0, [
            makeSentence(
                "For this purpose, we examine changes in violent and property",
            ),
        ]);
        const right = makeParagraph(1, [
            makeSentence("crime before, during, and after."),
        ]);

        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );

        expect(left.sentences[0].joinWithNext).toBe(true);
        // Never set on the trailing-side last sentence (no successor here).
        expect(right.sentences[0].joinWithNext).toBeUndefined();
    });

    it("leaves the flag unset when last sentence ends with a period", () => {
        const left = makeParagraph(0, [makeSentence("Sentence ended.")]);
        const right = makeParagraph(1, [makeSentence("continuation here.")]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("leaves the flag unset for ASCII ! and ? terminators", () => {
        const left = makeParagraph(0, [makeSentence("Wow!")]);
        const right = makeParagraph(1, [makeSentence("continuation here.")]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();

        const left2 = makeParagraph(0, [makeSentence("Really?")]);
        const right2 = makeParagraph(1, [makeSentence("continuation here.")]);
        annotateColumnContinuations(
            [left2, right2],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left2.sentences[0].joinWithNext).toBeUndefined();
    });

    it("leaves the flag unset for ellipsis terminators (… and ...)", () => {
        const left = makeParagraph(0, [makeSentence("trailing off…")]);
        const right = makeParagraph(1, [makeSentence("more text here")]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();

        const left2 = makeParagraph(0, [makeSentence("trailing off...")]);
        const right2 = makeParagraph(1, [makeSentence("more text here")]);
        annotateColumnContinuations(
            [left2, right2],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left2.sentences[0].joinWithNext).toBeUndefined();
    });

    it("leaves the flag unset for terminators followed by closing quote/paren", () => {
        const left = makeParagraph(0, [makeSentence(`said "the report."`)]);
        const right = makeParagraph(1, [makeSentence("continuation here")]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("leaves the flag unset for CJK terminators", () => {
        const left = makeParagraph(0, [makeSentence("文。")]);
        const right = makeParagraph(1, [makeSentence("つづき")]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("sets the flag when the last char is a hyphen (continuation indicator)", () => {
        // A trailing hyphen at a column break ("popula-" / "tion of the
        // city...") is a strong positive signal that the sentence continues.
        // Word-level rejoining ("popula-" + "tion" → "population") is a
        // downstream concern; the producer's job is only to mark continuation.
        for (const hyphen of ["-", "‐", "‑", "‒", "–", "—", "­"]) {
            const left = makeParagraph(0, [
                makeSentence(`continuing popula${hyphen}`),
            ]);
            const right = makeParagraph(1, [
                makeSentence("tion of the city continues here"),
            ]);
            annotateColumnContinuations(
                [left, right],
                simpleRegexSentenceSplit,
                new Set(),
            );
            expect(
                left.sentences[0].joinWithNext,
                `hyphen U+${hyphen.codePointAt(0)?.toString(16)}`,
            ).toBe(true);
        }
    });

    it("leaves the flag unset when first sentence starts with uppercase / digit / symbol", () => {
        const cases = [
            "Capital start of new sentence",
            "1990 was the year",
            "(see also Smith 2023)",
        ];
        for (const firstText of cases) {
            const left = makeParagraph(0, [
                makeSentence("ending without terminator"),
            ]);
            const right = makeParagraph(1, [makeSentence(firstText)]);
            annotateColumnContinuations(
                [left, right],
                simpleRegexSentenceSplit,
                new Set(),
            );
            expect(
                left.sentences[0].joinWithNext,
                `first="${firstText}"`,
            ).toBeUndefined();
        }
    });

    it("does not join when CUR's bbox extends past NEXT's left edge (full-width figure-caption case)", () => {
        // Reproduces 1__2YWA8DTZ__p7 [3]: a figure-caption tag spans the full
        // page width above the two columns, the next paragraph starts at the
        // left edge of column 0. Cheap gates pass (no terminator, lowercase
        // start) but the geometric gate must reject because the caption's
        // rightmost bbox extends past the body's leftmost bbox.
        const left = makeParagraph(0, [
            makeSentence(
                "[Colour figure can be viewed at wileyonlinelibrary.com]",
                { bboxes: [bboxFromXYWH(50, 0, 700, 12, "top-left")] },
            ),
        ]);
        const right = makeParagraph(0, [
            makeSentence(
                "population in 2001 and 2011 with the quintiles of each variable",
                { bboxes: [bboxFromXYWH(50, 100, 250, 12, "top-left")] },
            ),
        ], { idx: 1 });
        // Force a column-step transition (helper's other gates require it).
        right.columnIndex = 1;
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("does not join when NEXT's left edge equals CUR's right edge minus a pixel (geometric overlap)", () => {
        // Edge case: next.left = prev.right - 1. The gate uses `>=` so any
        // overlap (even a single point shy) blocks the join.
        const left = makeParagraph(0, [
            makeSentence("ending without terminator", {
                bboxes: [bboxFromXYWH(50, 0, 250, 12, "top-left")],
            }),
        ]);
        const right = makeParagraph(0, [
            makeSentence("continuation that would join", {
                bboxes: [bboxFromXYWH(299, 100, 250, 12, "top-left")],
            }),
        ], { idx: 1 });
        right.columnIndex = 1;
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("uses MAX(prev.right) and MIN(next.left) across multi-fragment sentences", () => {
        // Prev sentence has two fragments; the WIDEST one defines the right
        // edge for the gate. Here fragment 0 is wide (overlaps right column)
        // — gate must reject even though fragment 1 (the last) is narrow.
        const left = makeParagraph(0, [
            makeSentence("multi-line ending without terminator", {
                bboxes: [
                    bboxFromXYWH(50, 0, 700, 12, "top-left"), // wide fragment 0
                    bboxFromXYWH(50, 12, 100, 12, "top-left"), // narrow fragment 1
                ],
            }),
        ]);
        const right = makeParagraph(0, [
            makeSentence("continuation that would join", {
                bboxes: [bboxFromXYWH(350, 100, 250, 12, "top-left")],
            }),
        ], { idx: 1 });
        right.columnIndex = 1;
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("sets the flag for capitalized continuation when CUR has an unclosed paren (parenthetical-citation case)", () => {
        // From NLNMPWNQ p18: "(for research on" / "NYC, see Durán-Narucki 2008)."
        const left = makeParagraph(0, [
            makeSentence("other educational outcomes (for research on"),
        ]);
        const right = makeParagraph(1, [
            makeSentence("NYC, see Durán-Narucki 2008)."),
        ]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBe(true);
    });

    it("does not engage the unclosed-paren bypass when parens are balanced", () => {
        // Matched parens earlier in the text — depth ends at 0, gate 7 enforces
        // the lowercase rule, capitalized next paragraph is rejected.
        const left = makeParagraph(0, [
            makeSentence("the report (Smith 2023) ended without terminator"),
        ]);
        const right = makeParagraph(1, [
            makeSentence("New sentence starts here."),
        ]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("unclosed-paren bypass still defers to splitter — internal terminator vetoes the join", () => {
        // CUR has an unclosed `(`, NEXT capitalized — bypass passes gate 7,
        // but the combined text contains an internal `. ` so splitter splits.
        const stubSplitter = (text: string) => {
            // Mimic a sentencex/regex split that breaks at the period before
            // the capital letter even when the paren is unclosed.
            const idx = text.indexOf(". ");
            if (idx === -1) return [{ start: 0, end: text.length }];
            return [
                { start: 0, end: idx + 1 },
                { start: idx + 2, end: text.length },
            ];
        };
        const left = makeParagraph(0, [
            makeSentence("first thought ended. (and continuing on"),
        ]);
        const right = makeParagraph(1, [
            makeSentence("Second sentence here)"),
        ]);
        annotateColumnContinuations([left, right], stubSplitter, new Set());
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("leaves the flag unset when the splitter splits the combined text into 2+", () => {
        // Splitter sees a `.` mid-string — emits two ranges. The cheap gate
        // passes (last has no terminator, first lowercase) but stage 2 vetoes.
        const stubSplitter = (_text: string) => [
            { start: 0, end: 5 },
            { start: 6, end: 12 },
        ];
        const left = makeParagraph(0, [
            makeSentence("continuing text without terminator"),
        ]);
        const right = makeParagraph(1, [
            makeSentence("continuation that splitter rejects"),
        ]);
        annotateColumnContinuations([left, right], stubSplitter, new Set());
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("does nothing for same-column adjacent paragraphs", () => {
        const a = makeParagraph(0, [
            makeSentence("ending without terminator"),
        ], { idx: 0 });
        const b = makeParagraph(0, [
            makeSentence("continuation that would join"),
        ], { idx: 1 });
        annotateColumnContinuations(
            [a, b],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(a.sentences[0].joinWithNext).toBeUndefined();
    });

    it("does nothing for non-consecutive columns (col 0 → col 2)", () => {
        const a = makeParagraph(0, [
            makeSentence("ending without terminator"),
        ]);
        const c = makeParagraph(2, [
            makeSentence("continuation that would join"),
        ]);
        annotateColumnContinuations(
            [a, c],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(a.sentences[0].joinWithNext).toBeUndefined();
    });

    it("does nothing if either side is a header", () => {
        const left = makeParagraph(
            0,
            [makeSentence("HEADING TEXT")],
            { type: "header" },
        );
        const right = makeParagraph(1, [
            makeSentence("continuation that would join"),
        ]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect("sentences" in left).toBe(false);

        const a = makeParagraph(0, [makeSentence("ending without terminator")]);
        const b = makeParagraph(
            1,
            [makeSentence("HEADING")],
            { type: "header" },
        );
        annotateColumnContinuations(
            [a, b],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(a.sentences[0].joinWithNext).toBeUndefined();
    });

    it("sets the flag on every intermediate paragraph in a 3-column chain", () => {
        const p0 = makeParagraph(0, [
            makeSentence("we examined the long sentence that begins"),
        ], { idx: 0 });
        const p1 = makeParagraph(1, [
            makeSentence(
                "continuing in the second column with no terminator",
            ),
        ], { idx: 1 });
        const p2 = makeParagraph(2, [
            makeSentence("and finally ending in the third column."),
        ], { idx: 2 });

        annotateColumnContinuations(
            [p0, p1, p2],
            simpleRegexSentenceSplit,
            new Set(),
        );

        expect(p0.sentences[0].joinWithNext).toBe(true);
        expect(p1.sentences[0].joinWithNext).toBe(true);
        // The terminal paragraph never gets the flag (no successor at i+1).
        expect(p2.sentences[0].joinWithNext).toBeUndefined();
    });

    it("skips degraded items on either side", () => {
        const left = makeParagraph(0, [
            makeSentence("ending without terminator"),
        ]);
        const right = makeParagraph(1, [
            makeSentence("continuation that would join"),
        ]);

        // Degraded left (idx 0) → skip.
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set([left.id]),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();

        // Degraded right (idx 1) → skip.
        const left2 = makeParagraph(0, [
            makeSentence("ending without terminator"),
        ]);
        const right2 = makeParagraph(1, [
            makeSentence("continuation that would join"),
        ]);
        annotateColumnContinuations(
            [left2, right2],
            simpleRegexSentenceSplit,
            new Set([right2.id]),
        );
        expect(left2.sentences[0].joinWithNext).toBeUndefined();
    });

    it("clears stale joinWithNext when a re-evaluation no longer qualifies", () => {
        const left = makeParagraph(0, [
            makeSentence("ending without terminator", { joinWithNext: true }),
        ]);
        const right = makeParagraph(1, [
            // Capitalized start → cheap gate now rejects.
            makeSentence("New sentence starts here"),
        ]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect(left.sentences[0].joinWithNext).toBeUndefined();
    });

    it("never writes explicit false — flag is either true or absent", () => {
        const left = makeParagraph(0, [makeSentence("Sentence ended.")]);
        const right = makeParagraph(1, [makeSentence("continuation")]);
        annotateColumnContinuations(
            [left, right],
            simpleRegexSentenceSplit,
            new Set(),
        );
        expect("joinWithNext" in left.sentences[0]).toBe(false);
    });

    it("handles empty input arrays", () => {
        expect(() =>
            annotateColumnContinuations(
                [],
                simpleRegexSentenceSplit,
                new Set(),
            ),
        ).not.toThrow();
    });
});
