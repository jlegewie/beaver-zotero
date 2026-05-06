/**
 * Unit tests for `annotateColumnContinuations` in `ParagraphSentenceMapper.ts`.
 *
 * Hermetic — synthetic `ParagraphWithSentences` arrays, no MuPDF, no Zotero.
 *
 * Verifies the conservative cheap-gate + splitter-validation heuristic:
 *   - Sets `joinWithNext = true` only when adjacent body paragraphs in
 *     consecutive columns appear to share one sentence (last text not
 *     terminated, first text starts lowercase, splitter agrees).
 *   - Never writes explicit `false` (omitted ≡ false per SentenceBBox contract).
 *   - Clears stale `true` from prior calls so the helper is idempotent.
 */
import { describe, it, expect } from "vitest";
import {
    annotateColumnContinuations,
    type ParagraphWithSentences,
} from "../../../src/services/pdf/ParagraphSentenceMapper";
import { simpleRegexSentenceSplit } from "../../../src/services/pdf/SentenceMapper";
import type { ContentItem } from "../../../src/services/pdf/ParagraphDetector";
import type { SentenceBBox } from "../../../src/services/pdf/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeItem(
    overrides: Partial<ContentItem> & {
        idx: number;
        columnIndex: number;
        type?: "paragraph" | "header";
    },
): ContentItem {
    return {
        type: overrides.type ?? "paragraph",
        idx: overrides.idx,
        docIdx: overrides.idx,
        start: 0,
        end: 0,
        text: "",
        id: `item-${overrides.idx}`,
        bbox: { l: 0, t: 0, r: 0, b: 0, width: 0, height: 0 },
        columnIndex: overrides.columnIndex,
        ...overrides,
    };
}

function makeSentence(
    text: string,
    overrides: Partial<SentenceBBox> = {},
): SentenceBBox {
    return {
        pageIndex: 0,
        paragraphIndex: 0,
        sentenceIndex: 0,
        text,
        bboxes: [],
        ...overrides,
    };
}

function makeParagraph(
    columnIndex: number,
    sentences: SentenceBBox[],
    opts: { type?: "paragraph" | "header"; idx?: number } = {},
): ParagraphWithSentences {
    return {
        item: makeItem({
            idx: opts.idx ?? columnIndex,
            columnIndex,
            type: opts.type ?? "paragraph",
        }),
        paragraphText: { text: "", source: [], lines: [] },
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

    it("leaves the flag unset when the last char is a hyphen (hyphenation skip)", () => {
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
            ).toBeUndefined();
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
            [makeSentence("HEADING TEXT", { kind: "heading" })],
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
        expect(left.sentences[0].joinWithNext).toBeUndefined();

        const a = makeParagraph(0, [makeSentence("ending without terminator")]);
        const b = makeParagraph(
            1,
            [makeSentence("HEADING", { kind: "heading" })],
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
            new Set([0]),
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
            new Set([1]),
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
