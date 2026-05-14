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
import {
    buildParagraphText,
    extractPageSentences,
} from "../../../src/beaver-extract/ParagraphSentenceMapper";
import { simpleRegexSentenceSplit } from "../../../src/beaver-extract/SentenceMapper";
import {
    bboxFromXYWH,
    bboxHeight,
    type QuadPoint,
    type RawBlockDetailed,
    type RawChar,
    type RawLineDetailed,
    type RawPageDataDetailed,
} from "../../../src/beaver-extract/types";

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
            bbox: bboxFromXYWH(x, yTop, 10, charH, "top-left"),
        });
    }
    return {
        wmode: 0,
        bbox: bboxFromXYWH(xStart, yTop, text.length * 10, charH, "top-left"),
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
        ch.bbox = bboxFromXYWH(
            ch.bbox.l,
            ch.bbox.t,
            ch.bbox.r - ch.bbox.l,
            bboxHeight(ch.bbox) * ratio,
            ch.bbox.origin,
        );
    }
}

function makePage(lines: RawLineDetailed[]): RawPageDataDetailed {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of lines) {
        if (l.bbox.l < minX) minX = l.bbox.l;
        if (l.bbox.t < minY) minY = l.bbox.t;
        if (l.bbox.r > maxX) maxX = l.bbox.r;
        if (l.bbox.b > maxY) maxY = l.bbox.b;
    }
    const block: RawBlockDetailed = {
        type: "text",
        bbox: bboxFromXYWH(minX, minY, maxX - minX, maxY - minY, "top-left"),
        lines,
    };
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: maxX + 50,
        height: maxY + 50,
        blocks: [block],
    };
}

/**
 * Walk the source map and assert that no entry references the given
 * (line, charIndex) — i.e. the marker char was dropped, not just hidden.
 * Compares by referential identity of `pt.lines[entry.lineIndex]`
 * against the supplied line so multi-line paragraphs work.
 */
function assertNoSourceForChar(
    pt: ReturnType<typeof buildParagraphText>,
    line: RawLineDetailed,
    charIndex: number,
) {
    for (const entry of pt.source) {
        if (entry === null) continue;
        if (pt.lines[entry.lineIndex] === line && entry.charIndex === charIndex) {
            throw new Error(
                `expected no source entry for charIndex=${charIndex} ` +
                `(char='${line.chars[charIndex].c}'), but found one`,
            );
        }
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

describe("buildParagraphText whitespace-tolerant precondition", () => {
    it("collapses a same-line marker run separated from the period by a space", () => {
        // "factor. 11 The" — period + real space + footnote. Without the
        // whitespace-tolerant tracker, lastReal would be ' ' and the
        // collapse would fail. Expected: period + original space +
        // collapsed-run space + real space after "11" = three spaces.
        const line = makeLine("factor. 11 The", 100);
        shrinkChars(line, [8, 9]);
        const pt = buildParagraphText([line]);
        expect(pt.text).toBe("factor.   The");
        expect(pt.source.length).toBe(pt.text.length);
        assertNoSourceForChar(pt, line, 8);
        assertNoSourceForChar(pt, line, 9);
    });

    it("collapses a marker run at the start of the next line (no trailing space on line N)", () => {
        // line N = "factor.", line N+1 = "11 The"
        // → "factor." + interline-filler " " + collapsed " " + real " " after 11 + "The"
        const lineA = makeLine("factor.", 100);
        const lineB = makeLine("11 The", 115);
        shrinkChars(lineB, [0, 1]);
        const pt = buildParagraphText([lineA, lineB]);
        expect(pt.text).toBe("factor.   The");
        expect(pt.source.length).toBe(pt.text.length);
        assertNoSourceForChar(pt, lineB, 0);
        assertNoSourceForChar(pt, lineB, 1);
    });

    it("collapses a marker run at the start of the next line when line N has trailing whitespace", () => {
        // line N = "factor. " (trailing space), line N+1 = "11 The"
        // → real trailing space + interline filler + collapsed-run + real space after 11 = 4 spaces
        const lineA = makeLine("factor. ", 100);
        const lineB = makeLine("11 The", 115);
        shrinkChars(lineB, [0, 1]);
        const pt = buildParagraphText([lineA, lineB]);
        expect(pt.text).toBe("factor.    The");
        expect(pt.source.length).toBe(pt.text.length);
        assertNoSourceForChar(pt, lineB, 0);
        assertNoSourceForChar(pt, lineB, 1);
    });

    it("collapses a marker run that ends a line (run + line break + body)", () => {
        // line N = "factor.11", line N+1 = "The"
        // → "factor." + collapsed-run " " + interline-filler " " + "The" = two spaces
        const lineA = makeLine("factor.11", 100);
        shrinkChars(lineA, [7, 8]);
        const lineB = makeLine("The", 115);
        const pt = buildParagraphText([lineA, lineB]);
        expect(pt.text).toBe("factor.  The");
        expect(pt.source.length).toBe(pt.text.length);
        assertNoSourceForChar(pt, lineA, 7);
        assertNoSourceForChar(pt, lineA, 8);
    });

    it("collapses a load-bearing marker but preserves a mid-sentence marker on the same line", () => {
        // "factor.11 The. Smith2 et al."
        //  indices: 0..6=factor., 7,8="11", 9=' ', 10..12="The", 13='.', 14=' ',
        //           15..19="Smith", 20='2', 21..=" et al."
        const line = makeLine("factor.11 The. Smith2 et al.", 100);
        shrinkChars(line, [7, 8]); // load-bearing footnote
        shrinkChars(line, [20]);   // mid-sentence superscript ("Smith2")
        const pt = buildParagraphText([line]);
        // "factor."  + collapsed " " + " The. Smith2 et al."
        expect(pt.text).toBe("factor.  The. Smith2 et al.");
        // The "1"s have no source entries.
        assertNoSourceForChar(pt, line, 7);
        assertNoSourceForChar(pt, line, 8);
        // The "2" still has a source entry — it is preserved.
        const sourceFor20 = pt.source.find(
            (e) => e !== null && e.lineIndex === 0 && e.charIndex === 20,
        );
        expect(sourceFor20).toBeDefined();
    });

    it("preserves mid-sentence markers across a line break when another marker is load-bearing", () => {
        // line N = "factor.11 The factor.", line N+1 = "Smith2 et al found."
        const lineA = makeLine("factor.11 The factor.", 100);
        shrinkChars(lineA, [7, 8]);
        const lineB = makeLine("Smith2 et al found.", 115);
        shrinkChars(lineB, [5]);
        const pt = buildParagraphText([lineA, lineB]);
        expect(pt.text).toBe(
            "factor.  The factor. Smith2 et al found.",
        );
        // load-bearing markers dropped
        assertNoSourceForChar(pt, lineA, 7);
        assertNoSourceForChar(pt, lineA, 8);
        // mid-sentence "2" preserved (preceding non-WS real char is 'h')
        const sourceFor5OnB = pt.source.find(
            (e) =>
                e !== null &&
                pt.lines[e.lineIndex] === lineB &&
                e.charIndex === 5,
        );
        expect(sourceFor5OnB).toBeDefined();
    });
});

describe("end-to-end: cross-line marker is absent from final SentenceItem", () => {
    it("splits at the line break and excludes the marker chars from sentence text + bboxes", () => {
        // Synthetic single-paragraph page. Two lines with a small vertical
        // gap so the paragraph detector groups them. Line N ends with a
        // period, line N+1 starts with a superscript footnote, then "The".
        const xStart = 50;
        const lineA = makeLine("belong to the same factor.", 100, xStart);
        // Line B: small "11" then space then "The factor score"
        const lineB = makeLine("11 The factor score", 113, xStart);
        shrinkChars(lineB, [0, 1]);
        // 'T' is at lineB.chars[3] (after "11 "). Capture its expected x.
        const expectedTx = lineB.chars[3].bbox.l;
        const page = makePage([lineA, lineB]);

        const result = extractPageSentences(page, {
            splitter: simpleRegexSentenceSplit,
        });

        // Pipeline did not degrade.
        expect(result.degradation).toBeUndefined();

        // We expect at least two sentences. The relevant ones are the
        // first ending at "factor." and the next starting with "The".
        const sentences = result.sentences;
        expect(sentences.length).toBeGreaterThanOrEqual(2);

        const first = sentences.find((s) => s.text.includes("factor."));
        expect(first).toBeDefined();
        expect(first!.text).not.toContain("1");
        for (const f of first!.fragments ?? []) {
            expect(f.text).not.toContain("1");
        }

        const second = sentences.find(
            (s) => s !== first && s.text.includes("The factor score"),
        );
        expect(second).toBeDefined();
        expect(second!.text).not.toContain("1");
        for (const f of second!.fragments ?? []) {
            expect(f.text).not.toContain("1");
        }
        // The second sentence's first fragment bbox should start at the
        // 'T' x-coordinate, not at the smaller '1' x-coordinate. This
        // pins the bbox-exclusion claim via the synthetic geometry.
        expect(second!.fragments![0].bbox.l).toBeCloseTo(expectedTx, 5);
    });
});
