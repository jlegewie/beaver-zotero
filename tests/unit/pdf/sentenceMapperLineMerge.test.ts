/**
 * Unit tests for the same-line fragment merge in
 * `SentenceMapper.sentenceToBoxes`.
 *
 * Hermetic — synthetic `RawLineDetailed`, no MuPDF, no Zotero.
 *
 * The bug being guarded against: MuPDF's structured-text walker can
 * split a single visual line into multiple `RawLineDetailed` entries
 * when a wider-than-normal horizontal gap appears mid-line (extra
 * spaces, justified spacing). Without merging, a sentence highlight
 * on one visual line renders as two disjoint rectangles. The merge
 * is gated on co-linearity (y/h) AND a max horizontal gap so unrelated
 * same-y fragments — table cells, columns reached by an out-of-order
 * fallback — never collapse into one wide rectangle.
 */
import { describe, it, expect } from "vitest";
import {
    sentenceToBoxes,
    type PageText,
    type SentenceRange,
} from "../../../src/beaver-extract/SentenceMapper";
import type {
    QuadPoint,
    RawChar,
    RawLineDetailed,
} from "../../../src/beaver-extract/types";
import { bboxFromXYWH, bboxHeight, bboxWidth } from "../../../src/beaver-extract/types";

function makeLine(
    text: string,
    yTop: number,
    xStart: number,
    charH = 12,
    charW = 10,
): RawLineDetailed {
    const chars: RawChar[] = [];
    for (let i = 0; i < text.length; i++) {
        const x = xStart + i * charW;
        const quad: QuadPoint = [
            x, yTop,
            x + charW, yTop,
            x, yTop + charH,
            x + charW, yTop + charH,
        ];
        chars.push({
            c: text[i],
            quad,
            bbox: bboxFromXYWH(x, yTop, charW, charH, "top-left"),
        });
    }
    return {
        wmode: 0,
        bbox: bboxFromXYWH(xStart, yTop, text.length * charW, charH, "top-left"),
        font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 12 },
        x: xStart,
        y: yTop,
        text,
        chars,
    };
}

/**
 * Build a `PageText` from synthetic lines, mirroring how
 * `flattenPageText` / `buildParagraphText` lay out the source map:
 * one entry per real char, plus one `null` filler between consecutive
 * lines so the splitter sees word boundaries.
 */
function buildPageText(lines: RawLineDetailed[]): PageText {
    const textParts: string[] = [];
    const source: PageText["source"] = [];
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        for (let ci = 0; ci < line.chars.length; ci++) {
            textParts.push(line.chars[ci].c);
            source.push({ lineIndex: li, charIndex: ci });
        }
        if (li < lines.length - 1) {
            textParts.push(" ");
            source.push(null);
        }
    }
    return { text: textParts.join(""), source, lines };
}

function fullRange(pt: PageText): SentenceRange {
    return { start: 0, end: pt.text.length };
}

describe("sentenceToBoxes — same-line fragment merge", () => {
    it("merges two same-y fragments with a small horizontal gap", () => {
        // 12pt body line height. Pieces sit on the same y with a 20pt
        // gap between them (~1.7× line height, well under the 3× ratio
        // cap). Mirrors the "possible␠␠mechanism." failure mode where
        // MuPDF splits a single visual line across an extra-space.
        const line0 = makeLine("possible", 100, 50); // x = 50..130
        const line1 = makeLine("mechanism.", 100, 150); // gap = 20 (~1.7×h)
        const pt = buildPageText([line0, line1]);

        const sentence = sentenceToBoxes(pt, fullRange(pt), 0, 0, 0);
        expect(sentence).not.toBeNull();
        expect(sentence!.bboxes).toHaveLength(1);
        const b = sentence!.bboxes[0];
        // Spans the union of both fragments + the gap they sit in.
        expect(b.l).toBeCloseTo(50);
        expect(b.r).toBeCloseTo(150 + 10 * "mechanism.".length);
        expect(b.t).toBeCloseTo(100);
        expect(bboxHeight(b)).toBeCloseTo(12);
    });

    it("does NOT merge two same-y fragments separated by a large gap (column gutter / table cell)", () => {
        // Two cells on the same row, separated far enough that a real
        // layout boundary is the only sensible interpretation. With h=12,
        // the cap is 36 pt; we use a 200 pt gap so any reasonable cap
        // would still reject it.
        const left = makeLine("CellA", 100, 50);
        const right = makeLine("CellB", 100, 50 + 5 * 10 + 200); // 200 pt gap
        const pt = buildPageText([left, right]);

        const sentence = sentenceToBoxes(pt, fullRange(pt), 0, 0, 0);
        expect(sentence).not.toBeNull();
        // Per-fragment precision preserved: two distinct rectangles.
        expect(sentence!.bboxes).toHaveLength(2);
        expect(sentence!.bboxes[0].l).toBeCloseTo(50);
        expect(bboxWidth(sentence!.bboxes[0])).toBeCloseTo(50);
        expect(sentence!.bboxes[1].l).toBeCloseTo(50 + 50 + 200);
    });

    it("does NOT merge fragments with different y (different visual lines)", () => {
        const line0 = makeLine("first line", 100, 50);
        const line1 = makeLine("second", 120, 50); // 20 pt below
        const pt = buildPageText([line0, line1]);

        const sentence = sentenceToBoxes(pt, fullRange(pt), 0, 0, 0);
        expect(sentence).not.toBeNull();
        expect(sentence!.bboxes).toHaveLength(2);
        expect(sentence!.bboxes[0].t).toBeCloseTo(100);
        expect(sentence!.bboxes[1].t).toBeCloseTo(120);
    });

    it("does NOT merge fragments with different heights (subscript / superscript)", () => {
        const body = makeLine("body", 100, 50, 12);
        // Smaller character height — superscript-like. Same y, small gap.
        const sup = makeLine("sup", 100, 100, 7);
        const pt = buildPageText([body, sup]);

        const sentence = sentenceToBoxes(pt, fullRange(pt), 0, 0, 0);
        expect(sentence).not.toBeNull();
        expect(sentence!.bboxes).toHaveLength(2);
        expect(bboxHeight(sentence!.bboxes[0])).toBeCloseTo(12);
        expect(bboxHeight(sentence!.bboxes[1])).toBeCloseTo(7);
    });

    it("does NOT merge backwards (next fragment starts left of previous fragment's right edge)", () => {
        // Pathological reading-order: same y, second fragment starts
        // before the first one ended. Should never happen on a healthy
        // page, but if it does we keep both bboxes rather than producing
        // a degenerate union.
        const right = makeLine("right", 100, 200);
        const left = makeLine("left", 100, 50); // emitted second despite being to the left
        const pt = buildPageText([right, left]);

        const sentence = sentenceToBoxes(pt, fullRange(pt), 0, 0, 0);
        expect(sentence).not.toBeNull();
        expect(sentence!.bboxes).toHaveLength(2);
    });
});
