/**
 * Unit tests for the superscript-footnote collapse in
 * `ParagraphSentenceMapper.buildParagraphText`.
 *
 * Hermetic — synthetic `RawLineDetailed`, no MuPDF, no Zotero.
 *
 * The bug being guarded against: PDF body text often renders footnote
 * markers (the "11" in "factor.11 The") as superscripts immediately after
 * the period, with no whitespace separating them. Both sentencex and the
 * regex fallback only treat ". " (period + whitespace) as a sentence
 * boundary, so without preprocessing the two clauses end up in a single
 * sentence. `buildParagraphText` collapses such superscript runs into a
 * single inter-word space so the splitter recovers the boundary.
 */

import { describe, it, expect } from "vitest";
import { buildParagraphText } from "../../../src/services/pdf/ParagraphSentenceMapper";
import type {
    QuadPoint,
    RawChar,
    RawLineDetailed,
} from "../../../src/services/pdf/types";

function makeLine(text: string, yTop: number, xStart = 50): RawLineDetailed {
    const chars: RawChar[] = [];
    const charH = 12;
    for (let i = 0; i < text.length; i++) {
        const x = xStart + i * 10;
        const quad: QuadPoint = [
            x, yTop,
            x + 10, yTop,
            x, yTop + charH,
            x + 10, yTop + charH,
        ];
        chars.push({
            c: text[i],
            quad,
            bbox: { x, y: yTop, w: 10, h: charH },
        });
    }
    return {
        wmode: 0,
        bbox: { x: xStart, y: yTop, w: text.length * 10, h: charH },
        font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 12 },
        x: xStart,
        y: yTop,
        text,
        chars,
    };
}

function shrinkChars(line: RawLineDetailed, indices: number[], ratio = 0.65) {
    for (const idx of indices) {
        const ch = line.chars[idx];
        ch.bbox = { ...ch.bbox, h: ch.bbox.h * ratio };
    }
}

describe("buildParagraphText superscript-footnote collapse", () => {
    it("collapses a superscript digit run that follows a sentence-ending period", () => {
        // "factor.11 The factor" with the "11" rendered as superscripts.
        const line = makeLine("factor.11 The factor", 100);
        shrinkChars(line, [7, 8]);
        const pt = buildParagraphText([line]);
        // Run is replaced by a single injected space; the original space
        // after "11" remains, hence ".  The" (two spaces).
        expect(pt.text).toBe("factor.  The factor");
        expect(pt.source.length).toBe(pt.text.length);
        // Injected space has a null source.
        expect(pt.source[7]).toBeNull();
        // None of the surviving source entries point at a "1".
        for (const entry of pt.source) {
            if (entry !== null) {
                expect(line.chars[entry.charIndex].c).not.toBe("1");
            }
        }
    });

    it("collapses superscript runs after '!' and '?' too", () => {
        const exclam = makeLine("Yes!2 More", 100);
        shrinkChars(exclam, [4]);
        // Injected space + the original trailing space → two spaces.
        expect(buildParagraphText([exclam]).text).toBe("Yes!  More");

        const ques = makeLine("Why?3 Then", 100);
        shrinkChars(ques, [4]);
        expect(buildParagraphText([ques]).text).toBe("Why?  Then");
    });

    it("collapses traditional footnote glyphs (asterisk, dagger) after a period", () => {
        const line = makeLine("end.* Next", 100);
        shrinkChars(line, [4]);
        expect(buildParagraphText([line]).text).toBe("end.  Next");
    });

    it("keeps superscript digits that do NOT follow sentence-ending punctuation", () => {
        // Mid-sentence superscript like "Smith2 et al" — `2` is small but
        // the preceding char is a letter. Must not be stripped, so math
        // subscripts in inline notation survive.
        const line = makeLine("Smith2 et al", 100);
        shrinkChars(line, [5]);
        const pt = buildParagraphText([line]);
        expect(pt.text).toBe("Smith2 et al");
        expect(pt.source[5]).toEqual({ lineIndex: 0, charIndex: 5 });
    });

    it("does not collapse small letters after a period (ordinals like 1st)", () => {
        // Letters are not in the footnote-marker set, so a small "x"
        // following a period is left in place.
        const line = makeLine("Eq.x More", 100);
        shrinkChars(line, [3]);
        const pt = buildParagraphText([line]);
        expect(pt.text).toBe("Eq.x More");
        expect(pt.source[3]).toEqual({ lineIndex: 0, charIndex: 3 });
    });

    it("leaves a uniformly-sized line untouched (no superscripts present)", () => {
        // Defensive check: the median-based threshold must not mis-flag
        // chars when every char on the line is the same height.
        const line = makeLine("Sentence one. Sentence two.", 100);
        const pt = buildParagraphText([line]);
        expect(pt.text).toBe("Sentence one. Sentence two.");
    });

    it("collapses a mid-line superscript run that survives across multiple chars", () => {
        // Three-digit footnote like "factor.123 The".
        const line = makeLine("factor.123 The", 100);
        shrinkChars(line, [7, 8, 9]);
        const pt = buildParagraphText([line]);
        expect(pt.text).toBe("factor.  The");
    });
});
