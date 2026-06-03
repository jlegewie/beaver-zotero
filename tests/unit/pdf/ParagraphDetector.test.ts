/**
 * Unit tests for ParagraphDetector helpers.
 *
 * Focus: the CJK CID-subset body fallback added to `isHeaderStyle`.
 * The fallback short-circuits header classification for body-sized CJK
 * lines that use a font subset not yet seen in `bodyStyles[]`, but only
 * when bodyStyles itself shows the document already fragments that
 * (size, bold, italic) class across 2+ font subsets.
 *
 * The helper is pure and exported for testing only. We test it directly
 * rather than through `detectParagraphs` to keep the test focused on the
 * three guards (CJK content, no section prefix, fragmentation evidence).
 */

import { describe, it, expect } from 'vitest';
import {
    looksLikeFragmentedCJKBody,
    detectParagraphs,
} from '../../../src/beaver-extract/ParagraphDetector';
import type {
    PageLine,
    DetectedSpan,
    PageLineResult,
} from '../../../src/beaver-extract/LineDetector';
import type { TextStyle } from '../../../src/beaver-extract/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makePageLine(
    text: string,
    style: { size: number; font: string; bold?: boolean; italic?: boolean },
): PageLine {
    const span: DetectedSpan = {
        text,
        bbox: { x: 0, y: 0, w: text.length * 10, h: 12 },
        lineBBox: { l: 0, t: 0, r: text.length * 10, b: 12, width: text.length * 10, height: 12 },
        size: style.size,
        fontName: style.font,
        fontWeight: style.bold ? 'bold' : 'normal',
        fontStyle: style.italic ? 'italic' : 'normal',
    };
    return {
        spans: [span],
        bboxes: [span.lineBBox],
        bbox: span.lineBBox,
        text,
        fontSize: style.size,
    };
}

function bodyStyle(
    size: number,
    font: string,
    bold = false,
    italic = false,
): TextStyle {
    return { size, font, bold, italic };
}

const lineStyle = bodyStyle;

// CJK prose representative of the 2AXLSNS7 false-positive lines —
// continuation lines at the top of column bands.
const CJK_PROSE = '确切定义，但在国家特定行业的大气污染物和排放标准中使用';

describe('looksLikeFragmentedCJKBody', () => {
    describe('positive case: CJK subset continuation', () => {
        it('treats a body-sized CJK line in a new subset as body when bodyStyles is fragmented at that style class', () => {
            // bodyStyles already contains 2 distinct fonts at (size: 8, normal, normal).
            // The line uses a third subset at the same dimensions.
            const bodyStyles = [
                bodyStyle(7, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'FZSSK--GBK1-00+ZHNJFM-7'),
            ];
            const line = makePageLine(CJK_PROSE, { size: 8, font: 'FZSSK--GBK1-00+ZHNJFO-12' });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(8, 'FZSSK--GBK1-00+ZHNJFO-12'),
                bodyStyles,
            );
            expect(result).toBe(true);
        });
    });

    describe('guard 1: CJK content', () => {
        it('does NOT fire on Latin prose even when bodyStyles is fragmented at the same dims', () => {
            // Synthetic Latin "fragmentation": two body fonts at size 10.
            // A third same-size Latin font line must NOT be eaten — Rule 6
            // and other heading rules must remain reachable.
            const bodyStyles = [
                bodyStyle(10, 'Times-Roman'),
                bodyStyle(10, 'CMR10'),
            ];
            const line = makePageLine('This is normal English prose continuing.', {
                size: 10,
                font: 'Helvetica',
            });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(10, 'Helvetica'),
                bodyStyles,
            );
            expect(result).toBe(false);
        });

        it('fires on mixed CJK+Latin prose where CJK dominates', () => {
            // CJK papers routinely embed Latin tokens like "VOCs" or units;
            // the predicate must still recognize the line as CJK.
            const bodyStyles = [
                bodyStyle(8, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'FZSSK--GBK1-00+ZHNJFM-7'),
            ];
            const text = 'VOCs 浓度大于5% 时，处理效果较好，不适合处理低浓度';
            const line = makePageLine(text, { size: 8, font: 'C+Z-3' });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(8, 'C+Z-3'),
                bodyStyles,
            );
            expect(result).toBe(true);
        });
    });

    describe('guard 2: numeric-outline preservation (heading rules must still fire)', () => {
        // Each case in this block must pass `hasCJKContent` first so guard 1
        // doesn't short-circuit — otherwise the test would not actually
        // exercise the numeric-outline guard. We pick CJK-mixed headings
        // that the canonical SECTION_PREFIX_RE rejects (CJK characters are
        // \p{Lo}, not \p{Lu}) to verify the CJK-aware NUMERIC_OUTLINE_PREFIX
        // path inside `looksLikeFragmentedCJKBody`.

        it('does NOT fire on "2.1 冷凝法" (digit prefix → CJK ideograph)', () => {
            // Pure-CJK numbered subsection title: the most common CJK
            // section-heading shape. SECTION_PREFIX_RE alone would not
            // protect this because "冷" is \p{Lo}.
            const bodyStyles = [
                bodyStyle(8, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'FZSSK--GBK1-00+ZHNJFM-7'),
            ];
            const line = makePageLine('2.1 冷凝法', { size: 8, font: 'C+Z-3' });
            // Sanity-check guard 1 is satisfied — otherwise this test
            // doesn't actually exercise the numeric-outline guard.
            const cjkRatio = (line.text.match(/[一-鿿]/gu) || []).length /
                (line.text.match(/\p{L}/gu) || []).length;
            expect(cjkRatio).toBeGreaterThanOrEqual(0.5);
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(8, 'C+Z-3'),
                bodyStyles,
            );
            expect(result).toBe(false);
        });

        it('does NOT fire on "2. 概述" (digit prefix → CJK ideograph)', () => {
            const bodyStyles = [
                bodyStyle(8, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'FZSSK--GBK1-00+ZHNJFM-7'),
            ];
            const line = makePageLine('2. 概述', { size: 8, font: 'C+Z-3' });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(8, 'C+Z-3'),
                bodyStyles,
            );
            expect(result).toBe(false);
        });

        it('does NOT fire on "2 VOCs 挥发性有机物" (digit prefix → Latin uppercase, CJK content)', () => {
            // Mixed CJK+Latin numbered heading whose first non-prefix
            // character is a Latin uppercase letter — this case passes
            // hasCJKContent (CJK majority by count) AND would have passed
            // SECTION_PREFIX_RE on its own. Asserts we have not regressed
            // the original Latin-uppercase coverage in the CJK-aware regex.
            const bodyStyles = [
                bodyStyle(8, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'FZSSK--GBK1-00+ZHNJFM-7'),
            ];
            const line = makePageLine('2 VOCs 挥发性有机物', { size: 8, font: 'C+Z-3' });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(8, 'C+Z-3'),
                bodyStyles,
            );
            expect(result).toBe(false);
        });
    });

    describe('guard 3: fragmentation evidence', () => {
        it('does NOT fire when bodyStyles has only one font at the line dims', () => {
            // Single-body-font document: real same-size headings (Rule 6
            // territory) must not be pre-empted. distinctFonts.size === 1
            // here, so the fallback stays out.
            const bodyStyles = [bodyStyle(10, 'Times-Roman')];
            const line = makePageLine('这是正常的中文段落内容。', { size: 10, font: 'Helvetica' });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(10, 'Helvetica'),
                bodyStyles,
            );
            expect(result).toBe(false);
        });

        it('does NOT fire when sameDims is empty (heading at non-body size)', () => {
            // A larger-than-body heading: bodyStyles has nothing at size 14,
            // so distinctFonts is empty and fallback never applies. Rule 1
            // can detect this as a heading downstream.
            const bodyStyles = [
                bodyStyle(10, 'Times-Roman'),
                bodyStyle(10, 'Helvetica'),
            ];
            const line = makePageLine('引言', { size: 14, font: 'Helvetica-Bold' });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(14, 'Helvetica-Bold', true),
                bodyStyles,
            );
            expect(result).toBe(false);
        });

        it('respects bold/italic dimension mismatch', () => {
            // bodyStyles has two fonts at (size: 8, normal, normal) but our
            // line is bold. distinctFonts at (size: 8, BOLD, normal) is
            // empty, so fallback doesn't fire — bold same-size lines remain
            // available to Rule 2.
            const bodyStyles = [
                bodyStyle(8, 'E-BZ+ZHNJFM-5'),
                bodyStyle(8, 'FZSSK--GBK1-00+ZHNJFM-7'),
            ];
            const line = makePageLine(CJK_PROSE, { size: 8, font: 'C+Z-3', bold: true });
            const result = looksLikeFragmentedCJKBody(
                line,
                lineStyle(8, 'C+Z-3', true),
                bodyStyles,
            );
            expect(result).toBe(false);
        });
    });
});

// ---------------------------------------------------------------------------
// Hanging-indent leader suppression
// ---------------------------------------------------------------------------
//
// Tests below exercise the indent-break suppression in `startNewItem` for
// leader-led items (footnotes, numbered/lettered/symbol lists). Each case
// builds a single-column `PageLineResult` with several body-flush filler
// lines so the column's `leftEdgeMode` lands at l=0; the leader pair under
// test sits at the bottom. Without those filler lines the column mode could
// land on the continuation indent and the indent break would never trigger.

interface LeaderLineSpec {
    text: string;
    l: number;
    r?: number;
    gapAfter?: number;
    size?: number;
    font?: string;
    bold?: boolean;
    italic?: boolean;
    /**
     * Override the line bbox height (and the line.fontSize value) to a
     * value independent of the span size. Used to mimic the MuPDF marker-
     * aggregation artifact where a single span reports a tiny marker font
     * size (e.g. 4) but the visual line height matches the body text.
     */
    bboxHeight?: number;
    /**
     * Optional leading span (e.g. superscripted footnote marker) prepended
     * before the main text span. Used to verify that
     * `dominantSpanStyleByCharCount` ignores short marker spans when
     * comparing leader to continuation.
     */
    marker?: {
        text: string;
        size: number;
        font?: string;
        bold?: boolean;
        italic?: boolean;
    };
}

// Line bbox height tracks main span size so font-size + line-height shifts
// between body (10pt) and footnote (8pt) bands trigger the splitter's
// font-size break, mirroring real PDFs. Constant heights would collapse
// every band into the same paragraph.
function lineHeightFor(size: number): number {
    return size + 2;
}

function makeMultiSpanLine(spec: LeaderLineSpec, top: number): PageLine {
    const size = spec.size ?? 10;
    const font = spec.font ?? 'Times-Roman';
    const bold = spec.bold ?? false;
    const italic = spec.italic ?? false;
    const charWidth = size * 0.5;
    const lineHeight = spec.bboxHeight ?? lineHeightFor(size);

    const spans: DetectedSpan[] = [];
    let cursor = spec.l;

    if (spec.marker) {
        const mWidth = spec.marker.text.length * (spec.marker.size * 0.5);
        const markerSpan: DetectedSpan = {
            text: spec.marker.text,
            bbox: { x: cursor, y: top, w: mWidth, h: spec.marker.size },
            lineBBox: {
                l: cursor,
                t: top,
                r: cursor + mWidth,
                b: top + spec.marker.size,
                width: mWidth,
                height: spec.marker.size,
            },
            size: spec.marker.size,
            fontName: spec.marker.font ?? font,
            fontWeight: spec.marker.bold ? 'bold' : 'normal',
            fontStyle: spec.marker.italic ? 'italic' : 'normal',
        };
        spans.push(markerSpan);
        cursor += mWidth;
    }

    const mainText = spec.text;
    const mainWidth = mainText.length * charWidth;
    const mainSpan: DetectedSpan = {
        text: mainText,
        bbox: { x: cursor, y: top, w: mainWidth, h: size },
        lineBBox: {
            l: cursor,
            t: top,
            r: cursor + mainWidth,
            b: top + size,
            width: mainWidth,
            height: size,
        },
        size,
        fontName: font,
        fontWeight: bold ? 'bold' : 'normal',
        fontStyle: italic ? 'italic' : 'normal',
    };
    spans.push(mainSpan);

    const fullText = (spec.marker ? spec.marker.text : '') + mainText;
    const r = spec.r ?? cursor + mainWidth;
    return {
        spans,
        bboxes: spans.map(s => s.lineBBox),
        bbox: {
            l: spec.l,
            t: top,
            r,
            b: top + lineHeight,
            width: r - spec.l,
            height: lineHeight,
        },
        text: fullText,
        fontSize: size,
    };
}

function makeColumnPageResult(specs: LeaderLineSpec[]): PageLineResult {
    let cursorTop = 0;
    const lines: PageLine[] = specs.map(s => {
        const line = makeMultiSpanLine(s, cursorTop);
        // Standard leading: line height + small inter-line gap.
        cursorTop += line.bbox.height + (s.gapAfter ?? 2);
        return line;
    });
    const allLeft = Math.min(...lines.map(l => l.bbox.l));
    const allRight = Math.max(...lines.map(l => l.bbox.r));
    const allTop = Math.min(...lines.map(l => l.bbox.t));
    const allBottom = Math.max(...lines.map(l => l.bbox.b));
    return {
        pageIndex: 0,
        width: 612,
        height: 792,
        columnResults: [
            {
                column: {
                    x: allLeft,
                    y: allTop,
                    w: allRight - allLeft,
                    h: allBottom - allTop,
                },
                columnIndex: 0,
                lines,
            },
        ],
        allLines: lines,
    };
}

function paragraphTexts(
    pageResult: PageLineResult,
    bodyStyles: TextStyle[] | null
): string[] {
    const result = detectParagraphs(pageResult, bodyStyles);
    return result.items
        .filter(it => it.type === 'paragraph')
        .map(it => it.text.trim());
}

const BODY = bodyStyle(10, 'Times-Roman');
const FOOTNOTE_BODY = bodyStyle(8, 'Times-Roman');

// Filler body lines anchor the column's leftEdgeMode at l=0 so the
// continuation's +10 pt indent reliably triggers the indent break. Without
// enough fillers the median absolute deviation of left edges grows and the
// indent break may not fire — defeating the point of the test.
const FILLERS: LeaderLineSpec[] = Array.from({ length: 6 }, (_, i) => ({
    text: `Filler body line number ${i + 1} that anchors the column left edge.`,
    l: 0,
    size: 10,
    font: 'Times-Roman',
}));

// Test layout convention: every test layout consists of N filler body lines
// (size 10, l=0) followed by a leader-block (leader + 1-2 continuation lines).
// Expected paragraph counts depend on whether the leader-block style breaks
// from the filler band:
//   - When the leader-block matches the body style (size 10 same font), all
//     fillers + leader merge into a single body paragraph; the continuation
//     either joins it (suppression fires → 1 paragraph total) or splits off
//     (suppression does not fire → 2 paragraphs total).
//   - When the leader-block is a smaller footnote band (size 8), the size
//     change splits fillers from the leader (font-size break), so the leader
//     is its own paragraph that continuations either join (2 paragraphs total
//     with fillers as the first) or split from (3 paragraphs total).
describe('hanging-indent leader suppression', () => {
    describe('positives — leader and continuation merge', () => {
        it('numeric footnote leader with superscripted marker (multi-span)', () => {
            // Two-span leader: smaller-size "6  " marker span followed by a
            // longer body-text span. dominantSpanStyleByCharCount picks the
            // body-text span (size 8) over the marker span (size 4) so the
            // continuation (size 8) compares as same-style.
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: 'David Silver, Aja Huang, Chris J. Maddison, Arthur Guez,',
                    l: 0,
                    size: 8,
                    marker: { text: '6  ', size: 4 },
                },
                {
                    text: 'Marc Lanctot, Sander Dieleman, Dominik Grewe, John Nham,',
                    l: 10,
                    size: 8,
                },
                {
                    text: 'Graepel, and Demis Hassabis, Mastering the game of Go.',
                    l: 10,
                    size: 8,
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY, FOOTNOTE_BODY]);
            // 6 fillers (size 10) → one paragraph; the size 8 footnote splits
            // off via font-size break and then collapses into a single
            // paragraph because suppression fires on both continuations.
            expect(paragraphs.length).toBe(2);
            expect(paragraphs[1]).toContain('David Silver');
            expect(paragraphs[1]).toContain('Marc Lanctot');
            expect(paragraphs[1]).toContain('Graepel');
        });

        it('numeric footnote leader, single-span marker-aggregation artifact (WZVA5ZF2 shape)', () => {
            // MuPDF can emit a footnote leader as a SINGLE span and report
            // the small marker's font size for the whole span (observed on
            // WZVA5ZF2 page 10 footnote 6: line text "6  \x07David Silver…"
            // arrives as one span with size: 4 even though the body text
            // characters render at ~8pt). The dominant span style then
            // misrepresents the leader's body text. The marker-size-
            // discrepancy compensation kicks in: when fonts/bold/italic
            // agree but prev's reported size is significantly smaller than
            // the continuation, treat them as same-style.
            const FOOTNOTE_FONT = 'MissionGothic-Light';
            // Real WZVA5ZF2 RL32-RL34 all share bbox.height ≈ 9.55 even
            // though RL32's reported font.size is 4 and RL33/RL34 are 8 —
            // line height tracks the body text glyphs, not the marker.
            // Modeling that here keeps the splitter's font-size break
            // (which requires BOTH font-size and line-height to differ)
            // from firing between the leader and continuation.
            const FOOTNOTE_BBOX_H = 10;
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '6  \x07David Silver, Aja Huang, Chris J. Maddison,',
                    l: 0,
                    size: 4,
                    font: FOOTNOTE_FONT,
                    bboxHeight: FOOTNOTE_BBOX_H,
                },
                {
                    text: 'Marc Lanctot, Sander Dieleman, Dominik Grewe,',
                    l: 10,
                    size: 8,
                    font: FOOTNOTE_FONT,
                    bboxHeight: FOOTNOTE_BBOX_H,
                },
                {
                    text: 'Graepel, and Demis Hassabis, Mastering the game.',
                    l: 10,
                    size: 8,
                    font: FOOTNOTE_FONT,
                    bboxHeight: FOOTNOTE_BBOX_H,
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
            expect(paragraphs[1]).toContain('David Silver');
            expect(paragraphs[1]).toContain('Marc Lanctot');
            expect(paragraphs[1]).toContain('Graepel');
        });

        it('bracketed numeric list marker', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '[12] First entry that wraps onto a continuation', l: 0 },
                { text: 'and finishes here without a sentence break', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            // Leader matches body style → fillers + leader + continuation
            // collapse into a single paragraph.
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('[12]');
            expect(paragraphs[0]).toContain('finishes here');
        });

        it('lettered list leader with parenthesised lowercase letter', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '(a) First option that wraps to the next line', l: 0 },
                { text: 'and continues with more detail here', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('(a)');
            expect(paragraphs[0]).toContain('more detail');
        });

        it('lowercase Roman numeral leader', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: 'iii. Third option that wraps onto a continuation', l: 0 },
                { text: 'covering additional context here', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('iii.');
            expect(paragraphs[0]).toContain('additional context');
        });

        it('symbol footnote marker', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '* See note above for important details on the', l: 0 },
                { text: 'methodology used in this study and its limits', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('*');
            expect(paragraphs[0]).toContain('methodology');
        });

        it('icon-bullet body-style fallback (regression check)', () => {
            // Leader is icon-font bullet; continuation is in body font/size.
            // sameStyle is false (font differs), but matchesBodyStyle
            // succeeds — the icon-bullet path uses the body-style fallback.
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '• Bullet item that wraps to the next line',
                    l: 0,
                    size: 10,
                    font: 'Symbol',
                },
                {
                    text: 'and continues with body-styled wrap text',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            // Symbol-font leader merges with same-size body lines (icon
            // bullets are short-circuited as not-a-header), and the
            // continuation joins via the body-style fallback path.
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('Bullet item');
            expect(paragraphs[0]).toContain('continues with body');
        });

        it('standard bullet in Helvetica', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '• Bullet item in Helvetica that wraps',
                    l: 0,
                    size: 10,
                    font: 'Helvetica',
                },
                {
                    text: 'and continues in matching Helvetica style',
                    l: 10,
                    size: 10,
                    font: 'Helvetica',
                },
            ]);
            const paragraphs = paragraphTexts(result, [bodyStyle(10, 'Helvetica')]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('Bullet item in Helvetica');
            expect(paragraphs[0]).toContain('matching Helvetica style');
        });

        it('standard filled-circle bullet in serif body font', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '● Bullet item in serif text that wraps',
                    l: 0,
                    size: 10,
                    font: 'Times-Roman',
                },
                {
                    text: 'and continues in matching serif style',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('Bullet item in serif');
            expect(paragraphs[0]).toContain('matching serif style');
        });

        it('Wingdings glyph-substituted bullet leader', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: 'Ø Bullet via Wingdings that wraps',
                    l: 0,
                    size: 10,
                    font: 'AAAAAY+Wingdings-Regular',
                },
                {
                    text: 'and continues in regular body text',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('Bullet via Wingdings');
            expect(paragraphs[0]).toContain('regular body text');
        });

        it('AdvPi glyph-substituted bullet leader', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '. Limiting up-front expenditure',
                    l: 0,
                    size: 10,
                    font: 'FJBJNK+AdvPi1',
                },
                {
                    text: 'spect minimising risk money and exposure',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(1);
            expect(paragraphs[0]).toContain('Limiting up-front expenditure');
            expect(paragraphs[0]).toContain('minimising risk money');
        });

        it('same-indent continuation remains with a bullet item across a larger gap', () => {
            const result = makeColumnPageResult([
                ...FILLERS.slice(0, -1),
                { ...FILLERS[FILLERS.length - 1], gapAfter: 8 },
                {
                    text: '● Bullet item with several wrapped lines',
                    l: 0,
                    r: 420,
                },
                {
                    text: 'first continuation stays at the hanging indent',
                    l: 10,
                    gapAfter: 8,
                },
                {
                    text: 'second continuation should remain attached',
                    l: 10,
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
            expect(paragraphs[1]).toContain('several wrapped lines');
            expect(paragraphs[1]).toContain('second continuation');
        });
    });

    describe('positives — successive leaders are not cross-merged', () => {
        it('splits filled-circle bullet leaders after continuations', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '● First bullet item that wraps', l: 0 },
                { text: 'continuation of first bullet item', l: 10 },
                { text: '● Second bullet item that wraps', l: 0 },
                { text: 'continuation of second bullet item', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            const first = paragraphs.find(p => p.includes('First bullet item'));
            const second = paragraphs.find(p => p.includes('Second bullet item'));
            expect(first).toBeDefined();
            expect(second).toBeDefined();
            expect(first).not.toBe(second);
            expect(first).toContain('continuation of first');
            expect(first).not.toContain('Second bullet item');
            expect(second).toContain('continuation of second');
        });

        it('splits numbered list leaders after continuations', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '1. First numbered item that wraps', l: 0 },
                { text: 'continuation of first numbered item', l: 10 },
                { text: '2. Second numbered item that wraps', l: 0 },
                { text: 'continuation of second numbered item', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            const first = paragraphs.find(p => p.includes('First numbered item'));
            const second = paragraphs.find(p => p.includes('Second numbered item'));
            expect(first).toBeDefined();
            expect(second).toBeDefined();
            expect(first).not.toBe(second);
            expect(first).toContain('continuation of first');
            expect(first).not.toContain('Second numbered item');
            expect(second).toContain('continuation of second');
        });
    });

    describe('negatives — split is preserved', () => {
        it('quoted bullet marker in prose is not a leader continuation', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '"• as a marker is conventional," she said.', l: 0 },
                { text: 'A normally indented body line follows here', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('standard bullet does not use body-style fallback without icon font', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '• Bullet item in a non-body font',
                    l: 0,
                    size: 10,
                    font: 'Helvetica',
                },
                {
                    text: 'continuation set in another non-body font',
                    l: 10,
                    size: 10,
                    font: 'NotABodyFont',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('same-indent gap suppression is gated to leader-started items', () => {
            const result = makeColumnPageResult([
                ...FILLERS.slice(0, -1),
                { ...FILLERS[FILLERS.length - 1], gapAfter: 8 },
                {
                    text: 'Indented block quotation starts without a terminator',
                    l: 10,
                    r: 420,
                    gapAfter: 8,
                },
                {
                    text: 'Another indented paragraph starts after a visual gap',
                    l: 10,
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            const first = paragraphs.find(p =>
                p.includes('block quotation starts')
            );
            const second = paragraphs.find(p =>
                p.includes('Another indented paragraph')
            );
            expect(first).toBeDefined();
            expect(second).toBeDefined();
            expect(first).not.toBe(second);
        });

        it('MTSY equation lines do not merge through permissive icon handling', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '+ x = y', l: 0, size: 10, font: 'MTSY7' },
                { text: '+ z = w', l: 10, size: 10, font: 'MTSY7' },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('Symbol equation lines do not merge through permissive icon handling', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '+ α = β', l: 0, size: 10, font: 'AAAAAA+SymbolMT' },
                { text: '+ γ = δ', l: 10, size: 10, font: 'AAAAAA+SymbolMT' },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('leader line ends with a sentence terminator', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '1. First item.', l: 0 },
                { text: 'Indented next line that should not merge.', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            // Fillers + leader merge (same body style, no break); continuation
            // splits because the suppression's terminator gate blocks the merge.
            expect(paragraphs.length).toBe(2);
        });

        it('non-leader line followed by an indented continuation', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: 'This is body text without any leader marker', l: 0 },
                { text: 'And the next line is indented further right', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('4-digit year at line start (numeric regex caps at 3 digits)', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '2023 was a productive year for the team', l: 0 },
                { text: 'in many ways across the organization', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('bare digit + single space (numbered heading shape)', () => {
            // "2 Methods" — single space between digit and capital, so the
            // bare-numeric rule (which requires \s{2,}) does not fire.
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '2 Methods of analysis', l: 0 },
                { text: 'detailed in this section of the paper', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('common abbreviations like Dr. and Prof.', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: 'Dr. Smith and Prof. Jones', l: 0 },
                { text: 'collaborated extensively on this research', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('uppercase letter heading like "A. Methods"', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: 'A. Methods', l: 0 },
                { text: 'introduces the experimental approach', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('uppercase Roman numeral heading like "I. Introduction"', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: 'I. Introduction', l: 0 },
                { text: 'to the topic of this paper', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('bracketed numeric without trailing whitespace', () => {
            // "[12]Smith,..." — no space after `]`, so the numeric regex
            // does not match. Indent break is preserved.
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '[12]Smith, J., and Jones, K., a study', l: 0 },
                { text: 'with additional indented continuation text', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('section number "2.1 Methods" must not merge', () => {
            const result = makeColumnPageResult([
                ...FILLERS,
                { text: '2.1 Methods', l: 0 },
                { text: 'details the analytic procedure', l: 10 },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('different font on continuation (sameStyle false, not in bodyStyles)', () => {
            // Leader and continuation at the same size but different fonts,
            // and continuation's font is not present in bodyStyles, so
            // neither sameStyle nor the body-style fallback succeeds.
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '1. First leader line in body font',
                    l: 0,
                    size: 10,
                    font: 'Times-Roman',
                },
                {
                    text: 'continuation set in a different font',
                    l: 10,
                    size: 10,
                    font: 'Helvetica',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
        });

        it('text leader does NOT use the body-style fallback', () => {
            // Strict version of the previous test: leader is italic
            // Times-Roman size 10 (NOT a heading — same size and same font
            // as body), continuation is normal Times-Roman size 10 and
            // matches BODY exactly. sameStyle fails because italic differs;
            // matchesBodyStyle WOULD succeed for the continuation. The
            // text-pattern leader path forbids the body-style fallback, so
            // the suppression must NOT fire.
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '1. First leader line, italic body-sized',
                    l: 0,
                    size: 10,
                    font: 'Times-Roman',
                    italic: true,
                },
                {
                    text: 'continuation in plain body style',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                },
            ]);
            const paragraphs = paragraphTexts(result, [BODY]);
            expect(paragraphs.length).toBe(2);
            // The leader's italic line and the body continuation must be
            // in different paragraphs.
            const merged = paragraphs.find(
                p =>
                    p.includes('First leader line') &&
                    p.includes('continuation in plain body')
            );
            expect(merged).toBeUndefined();
        });

        it('heading-style text leader followed by body-style continuation', () => {
            // "2. Methods" rendered as a heading (bold size 14); continuation
            // in body style. sameStyle is false (size differs); the
            // body-style fallback would merge — but that fallback is gated
            // OFF for text-pattern leaders, so the split is preserved.
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: '2. Methods',
                    l: 0,
                    size: 14,
                    bold: true,
                    font: 'Times-Bold',
                },
                {
                    text: 'introduces the analytic procedure used here',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                },
            ]);
            // Inspect ALL items (paragraphs + headers) directly so the
            // assertion holds even though `paragraphTexts` would filter the
            // heading out. The continuation must be in its own item, not
            // the same item as the "2. Methods" heading.
            const detection = detectParagraphs(result, [BODY]);
            const headingItem = detection.items.find(it =>
                it.text.includes('2. Methods'),
            );
            const contItem = detection.items.find(it =>
                it.text.includes('analytic procedure'),
            );
            expect(headingItem).toBeDefined();
            expect(contItem).toBeDefined();
            expect(headingItem!.id).not.toBe(contItem!.id);
            expect(headingItem!.text).not.toContain('analytic procedure');
        });

        it('smaller multi-span text leader, larger same-font indented continuation', () => {
            // Smaller-text leader (size 8, two spans — marker + body) followed
            // by a larger same-font indented continuation (size 10). The
            // marker-aggregation safety net must NOT fire here because prev
            // has more than one span — the artifact only manifests when
            // MuPDF collapses the line into a single span. Without that
            // narrowing, the rule would silently merge a footnote-styled
            // leader with a body-styled wrap, which is not the layout we
            // want to handle.
            //
            // Leader and continuation share `bboxHeight` so the splitter's
            // font-size break (which requires BOTH font-size AND line-
            // height to differ) does not fire and silently rescue the
            // test. With the safety net narrowed, only `spans.length === 1`
            // separates a merge from a split here.
            const SHARED_LINE_HEIGHT = 12;
            const result = makeColumnPageResult([
                ...FILLERS,
                {
                    text: 'David Silver, Aja Huang, Chris J. Maddison,',
                    l: 0,
                    size: 8,
                    font: 'Times-Roman',
                    bboxHeight: SHARED_LINE_HEIGHT,
                    marker: { text: '6  ', size: 4, font: 'Times-Roman' },
                },
                {
                    text: 'a body-sized continuation that should not merge',
                    l: 10,
                    size: 10,
                    font: 'Times-Roman',
                    bboxHeight: SHARED_LINE_HEIGHT,
                },
            ]);
            const detection = detectParagraphs(result, [BODY]);
            const leaderItem = detection.items.find(it =>
                it.text.includes('David Silver'),
            );
            const contItem = detection.items.find(it =>
                it.text.includes('should not merge'),
            );
            expect(leaderItem).toBeDefined();
            expect(contItem).toBeDefined();
            expect(leaderItem!.id).not.toBe(contItem!.id);
        });
    });
});

// ---------------------------------------------------------------------------
// Superscript-marker font-size break
//
// MuPDF's JSON walk reports a single font/size per line, taken from the
// line's leading glyph. A footnote line that opens with a superscript marker
// ("12Body text…") reports the small marker size for the whole line while its
// bbox height still tracks the taller body glyphs — so the marker line reads
// as *smaller font but taller* than its wrapped continuation. The naive
// font-size break splits every footnote's first line into its own paragraph.
// The suppression is directional: a marker line merges with the continuation
// it introduces, but a fresh marker line still breaks from the previous note.
// ---------------------------------------------------------------------------
describe('superscript-marker font-size break', () => {
    // Model production output: the marker line carries a smaller reported
    // `fontSize` (the superscript size) but a TALLER bbox than its body-sized
    // continuation. Shared `r` keeps every line at the same right edge so no
    // early-end/indent break interferes. Markers are glued to the body text
    // ("11In…"), so they are not recognized as hanging-indent leaders.
    const MARKER_H = 8.7;
    const BODY_H = 7.25;

    function footnoteLine(text: string, isMarker: boolean): LeaderLineSpec {
        return {
            text,
            l: 0,
            r: 300,
            size: isMarker ? 5 : 7,
            bboxHeight: isMarker ? MARKER_H : BODY_H,
            font: 'Minion-Regular',
        };
    }

    it('keeps a footnote marker line merged with its wrapped continuation', () => {
        const result = makeColumnPageResult([
            ...FILLERS,
            footnoteLine('11In a given year the dataset included five values for the', true),
            footnoteLine('variable country of birth across the pooled survey waves used', false),
        ]);
        const paragraphs = paragraphTexts(result, [BODY, FOOTNOTE_BODY]);
        const note = paragraphs.find(p => p.includes('11In a given year'));
        expect(note).toBeDefined();
        // Marker line and its continuation are one paragraph.
        expect(note).toContain('variable country of birth');
    });

    it('still breaks between one footnote and the next note\'s marker line', () => {
        const result = makeColumnPageResult([
            ...FILLERS,
            footnoteLine('11In a given year the dataset included five values for the', true),
            footnoteLine('variable country of birth across the pooled survey waves used', false),
            footnoteLine('12I am not able to control for years since immigration for the', true),
            footnoteLine('immigrant population since both models must be analyzed alike', false),
        ]);
        const paragraphs = paragraphTexts(result, [BODY, FOOTNOTE_BODY]);
        const note11 = paragraphs.find(p => p.includes('11In a given year'));
        const note12 = paragraphs.find(p => p.includes('12I am not able'));
        expect(note11).toBeDefined();
        expect(note12).toBeDefined();
        // The two notes are distinct paragraphs, not fused.
        expect(note11).not.toBe(note12);
        expect(note11).not.toContain('12I am not able');
        expect(note12).not.toContain('11In a given year');
        // Each note still includes its own continuation line.
        expect(note11).toContain('variable country of birth');
        expect(note12).toContain('immigrant population');
    });

    it('still breaks a non-marker small line that is taller than the following body', () => {
        // The geometry (smaller reported size, comparable-or-taller bbox) is
        // also tripped by a small line made tall by brackets / sub- or
        // superscripts — but that line carries NO footnote/endnote/affiliation
        // marker at its start. Such a standalone small line (a caption /
        // callout / display fragment) must not be merged into the next
        // paragraph; the marker-shape gate keeps its break.
        const result = makeColumnPageResult([
            ...FILLERS,
            { text: 'small display fragment rendered tall by tall bracket glyphs', l: 0, r: 300, size: 5, bboxHeight: 8.7, font: 'Minion-Regular' },
            { text: 'ordinary body continuation line at the normal body size', l: 0, r: 300, size: 7, bboxHeight: 7.25, font: 'Minion-Regular' },
        ]);
        const paragraphs = paragraphTexts(result, [BODY, FOOTNOTE_BODY]);
        const frag = paragraphs.find(p => p.includes('small display fragment'));
        expect(frag).toBeDefined();
        // No leading marker → suppression must not fire → break preserved.
        expect(frag).not.toContain('ordinary body continuation');
    });

    it('still breaks when the smaller-reported line is dramatically taller (not a marker)', () => {
        // Upper bound: a superscript marker raises the top only a fraction of
        // an em. A line that reports a smaller size yet is far TALLER than the
        // next line is a different element (a misread heading / tall inline
        // glyph), not a marker artifact — the break must survive.
        const result = makeColumnPageResult([
            ...FILLERS,
            { text: 'Oversized leading element reported at a small font size', l: 0, r: 300, size: 5, bboxHeight: 20, font: 'Minion-Regular' },
            { text: 'ordinary body continuation line at the normal body size', l: 0, r: 300, size: 7, bboxHeight: 7.25, font: 'Minion-Regular' },
        ]);
        const paragraphs = paragraphTexts(result, [BODY, FOOTNOTE_BODY]);
        const tall = paragraphs.find(p => p.includes('Oversized leading element'));
        expect(tall).toBeDefined();
        expect(tall).not.toContain('ordinary body continuation');
    });

    it('still breaks to a genuinely smaller-and-shorter band (real size change)', () => {
        // Control: a real font-size drop (smaller size AND shorter bbox, no
        // marker artifact) must still split. Here the second line is both
        // smaller-size and shorter, so size and height agree — break stays.
        const result = makeColumnPageResult([
            ...FILLERS,
            { text: 'A full-measure body line that runs to the column right edge here', l: 0, r: 300, size: 10, bboxHeight: 12, font: 'Minion-Regular' },
            { text: 'tiny print disclaimer set distinctly smaller than the body text', l: 0, r: 300, size: 6, bboxHeight: 7, font: 'Minion-Regular' },
        ]);
        const paragraphs = paragraphTexts(result, [BODY]);
        const body = paragraphs.find(p => p.includes('A full-measure body line'));
        expect(body).toBeDefined();
        expect(body).not.toContain('tiny print disclaimer');
    });
});

// ---------------------------------------------------------------------------
// Header detection
//
// Two layout rules exercised here:
//   - Heading-capitalization guard: a candidate promoted by a same-size
//     font-difference rule (italic/bold/different-font, no size cue) must
//     begin like a heading — capital, digit, or opening quote/bracket. A
//     lowercase-leading line is body prose (MuPDF reports a whole line's
//     font as that of its leading run, so a paragraph beginning with an
//     italic word reads as "different font") or an equation fragment.
//   - Numbered section headings test the numeric outline prefix against
//     the joined item text, so a heading long enough to wrap across lines
//     is recognised even though only its first line carries the number.
// ---------------------------------------------------------------------------
describe('header detection', () => {
    // Filler body block whose last line carries the whitespace a section
    // heading sits above — without a real gap the header rules (which
    // require `gapCheckPasses`) never get a chance to fire in `startNewItem`.
    const FILLERS_BEFORE_HEADING: LeaderLineSpec[] = FILLERS.map((f, i) =>
        i === FILLERS.length - 1 ? { ...f, gapAfter: 14 } : f,
    );

    function items(specs: LeaderLineSpec[], bodyStyles: TextStyle[]) {
        return detectParagraphs(makeColumnPageResult(specs), bodyStyles).items;
    }

    describe('heading-capitalization guard', () => {
        it('does not promote an equation fragment in a math-italic font', () => {
            // Body-size italic in a font distinct from body — matches the
            // same-size-italic header rule — but the line is the numerator
            // of a fraction, beginning with a lowercase variable name.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'n(unemp | soc, s, t)', l: 0, size: 10, italic: true, font: 'Math-Italic' },
                ],
                [BODY],
            );
            const eq = all.find(it => it.text.includes('n(unemp'));
            expect(eq).toBeDefined();
            expect(eq!.type).toBe('paragraph');
            expect(eq!.text.startsWith('## ')).toBe(false);
        });

        it('does not promote a prose line that merely begins with an italic word', () => {
            // A hyphenated italic term ("congruence prin-/ciple") continues
            // onto this line, so MuPDF reports the whole line in the italic
            // font. The line is mid-paragraph body prose, lowercase-leading.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: 'ciple. This principle which holds that the data space should be the',
                        l: 0,
                        size: 10,
                        italic: true,
                        font: 'Times-Italic',
                    },
                ],
                [BODY],
            );
            const prose = all.find(it => it.text.includes('ciple. This principle'));
            expect(prose).toBeDefined();
            expect(prose!.type).toBe('paragraph');
        });

        it('still promotes a same-size italic heading that begins with a capital', () => {
            // The guard must not demote a genuine font-difference heading:
            // an italic subsection title set in a distinct font, capitalised.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'Materials and Methods', l: 0, size: 10, italic: true, font: 'Times-Italic' },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Materials and Methods'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });

        it('still promotes a bold heading whose wrapped continuation begins lowercase', () => {
            // A genuine bold heading long enough to wrap: the first line is
            // capitalised, the continuation begins with a lowercase word
            // ("and ..."). The guard is item-level — it judges the joined
            // item text, which starts with the capitalised first line — so
            // both lines stay in one heading item rather than the
            // continuation splitting off as body text.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'Exploring strain and stage distribution', l: 0, size: 10, bold: true, font: 'Heading-Bold' },
                    { text: 'and relatedness between strains within donors', l: 0, size: 10, bold: true, font: 'Heading-Bold' },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Exploring strain'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
            expect(heading!.text).toContain('and relatedness between strains');
        });
    });

    describe('numbered section headings', () => {
        it('promotes a single-line numbered heading in a distinct font', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: '3. Formulation of strategic objectives', l: 0, size: 10, font: 'Heading-Sans' },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Formulation of strategic'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });

        it('promotes a numbered heading that wraps across two lines', () => {
            // The numeric outline prefix ("3.3.") sits only on the first
            // line; the wrapped continuation carries no heading cue of its
            // own. Both lines share the heading font, so they form one item.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: '3.3. Key success factors for successful', l: 0, size: 10, font: 'Heading-Sans' },
                    { text: 'project management', l: 0, size: 10, font: 'Heading-Sans' },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Key success factors'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
            expect(heading!.text).toContain('project management');
        });
    });

    describe('Medium / Semibold weight headings', () => {
        // PostScript / OpenType faces in a Medium / Semibold / Demibold weight
        // carry the weight as a trailing `-Md` / `-Semibold` / `-Demi` token,
        // but MuPDF reports them with `weight: "normal"` (only the Bold style
        // flag counts). A subsection title set in such a display weight, same
        // size as a Regular body in a different family, must still promote via
        // the bold-different-font rule.
        it('promotes a heading set in a Medium-weight (-Md) font of a different family', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'Variables', l: 0, size: 10, font: 'HelveticaNeueLTStd-Md' },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Variables'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });

        it('promotes a heading set in a Semibold (-Semibold) font', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'Measures and Methods', l: 0, size: 10, font: 'MyriadPro-Semibold' },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Measures and Methods'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });

        it('does NOT promote a Regular-weight line in a different family with no other cue', () => {
            // Control: a same-size, different-family line carrying no weight,
            // italic, all-caps, or section-number cue stays body. This is what
            // keeps the Medium/Semibold extension from promoting every
            // font-different line (inline code, emphasis fragments).
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'Variables', l: 0, size: 10, font: 'HelveticaNeueLTStd-Roman' },
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Variables'));
            expect(item).toBeDefined();
            expect(item!.type).toBe('paragraph');
        });
    });
});

// ---------------------------------------------------------------------------
// Uniform-leading run protection
//
// A single detected column can stack two blocks with different line
// leading — most commonly a single-spaced figure caption above a
// double-spaced body paragraph. The per-column gap threshold is one
// median, so when the loosely-leaded block is the minority the threshold
// lands at the dense block's leading and every loose line is split into
// its own paragraph. `startNewItem` protects a run of near-equal gaps: a
// gap that does not notably exceed the surrounding leading is uniform
// intra-paragraph leading, not a paragraph break.
// ---------------------------------------------------------------------------
describe('uniform-leading run protection', () => {
    // Every wrapped-prose line is padded to the same width so it ends at the
    // same right edge: the run-protection guard treats only full-width lines
    // as wrapped. The pad ends with a word character, not punctuation — a
    // wrapped line ends mid-sentence, never with sentence-final punctuation.
    const WIDE = 88;
    const wide = (label: string) => (label + ' xx').padEnd(WIDE, ' xx').slice(0, WIDE);

    // Six tight caption lines (2pt gaps) dominate the column gap median, so
    // the per-column threshold lands well below the loose body block's own
    // 12pt double-spaced leading — the miscalibration the protection targets.
    const tightCaption: LeaderLineSpec[] = Array.from({ length: 6 }, (_, i) => ({
        text: wide(`Caption line ${i + 1}`),
        l: 0,
        size: 10,
        gapAfter: i === 5 ? 20 : 2, // 20pt break separates caption / body
    }));

    it('keeps a double-spaced body paragraph whole below a single-spaced caption', () => {
        // Without run protection each of the four 12pt-spaced body lines
        // becomes its own paragraph because the gap clears the (caption-
        // dominated) threshold.
        const specs: LeaderLineSpec[] = [
            ...tightCaption,
            { text: wide('Body line one of a double spaced paragraph'), l: 0, size: 10, gapAfter: 12 },
            { text: wide('Body line two of the same double spaced paragraph'), l: 0, size: 10, gapAfter: 12 },
            { text: wide('Body line three of the same double spaced paragraph'), l: 0, size: 10, gapAfter: 12 },
            { text: 'Body line four ends the paragraph.', l: 0, size: 10 },
        ];
        const paragraphs = paragraphTexts(makeColumnPageResult(specs), [BODY]);
        // One caption paragraph + one body paragraph.
        expect(paragraphs.length).toBe(2);
        const body = paragraphs.find(p => p.includes('Body line one'))!;
        expect(body).toBeDefined();
        expect(body).toContain('Body line two');
        expect(body).toContain('Body line three');
        expect(body).toContain('Body line four');
    });

    it('still splits a genuine paragraph break inside a double-spaced block', () => {
        // Same loose 12pt body leading, but a 24pt gap (a blank double-
        // spaced line) marks a real paragraph boundary. Run protection
        // suppresses only gaps that match the surrounding leading — a gap
        // that notably exceeds it must still split.
        const specs: LeaderLineSpec[] = [
            ...tightCaption,
            { text: wide('First body paragraph line one'), l: 0, size: 10, gapAfter: 12 },
            { text: wide('First body paragraph line two'), l: 0, size: 10, gapAfter: 24 },
            { text: wide('Second body paragraph line one'), l: 0, size: 10, gapAfter: 12 },
            { text: wide('Second body paragraph line two'), l: 0, size: 10, gapAfter: 12 },
            { text: 'Second body paragraph line three ends here.', l: 0, size: 10 },
        ];
        const paragraphs = paragraphTexts(makeColumnPageResult(specs), [BODY]);
        // Caption + two distinct body paragraphs.
        expect(paragraphs.length).toBe(3);
        const first = paragraphs.find(p => p.includes('First body paragraph line one'))!;
        expect(first).toBeDefined();
        expect(first).toContain('First body paragraph line two');
        expect(first).not.toContain('Second body paragraph');
        const second = paragraphs.find(p => p.includes('Second body paragraph line one'))!;
        expect(second).toBeDefined();
        expect(second).toContain('Second body paragraph line two');
        expect(second).toContain('Second body paragraph line three');
    });

    it('does not fuse short one-line items at uniform loose spacing', () => {
        // Four short one-line entries below the same caption, each ending
        // well short of the column right edge, at uniform 12pt gaps. They
        // are NOT wrapped prose — a wrapped line is full-width — so the
        // full-width guard keeps every entry its own paragraph even though
        // the gaps clear the miscalibrated threshold.
        const specs: LeaderLineSpec[] = [
            ...tightCaption,
            { text: 'Short entry one.', l: 0, size: 10, gapAfter: 12 },
            { text: 'Short entry two.', l: 0, size: 10, gapAfter: 12 },
            { text: 'Short entry three.', l: 0, size: 10, gapAfter: 12 },
            { text: 'Short entry four.', l: 0, size: 10 },
        ];
        const paragraphs = paragraphTexts(makeColumnPageResult(specs), [BODY]);
        // Caption + four separate short entries.
        expect(paragraphs.length).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// OCR text-layer heading false positives
//
// PDFs whose text is a synthetic OCR layer carry no reliable per-line size
// signal: OCRmyPDF / Tesseract render the invisible text in a single
// "GlyphLessFont" and size each line from the scanned glyph heights, so a
// body line lands 1-3pt above the body size and trips the larger-font
// heading rule. Because every glyph shares one font, the font-difference
// heading rules can never fire to check it. `processCurrentLinesAsItem`
// demotes a size-cued candidate whose lines all span the full body-text
// column measure — a wrapped body line, not a short title — but only on
// OCR-layer documents and only where the column has enough lines for its
// measure to be trustworthy.
// ---------------------------------------------------------------------------
describe('OCR text-layer heading false positives', () => {
    const items = (specs: LeaderLineSpec[], bodyStyles: TextStyle[]) =>
        detectParagraphs(makeColumnPageResult(specs), bodyStyles).items;

    // ~74-char running-prose line — spans the column measure the body
    // fillers establish, so it reads as a wrapped body line, not a title.
    const FULL_MEASURE_PROSE =
        'modern science but this is not so on the contrary this way of reasoning is';

    const ocrFillers = (): LeaderLineSpec[] =>
        Array.from({ length: 6 }, (_, i) => ({
            text: `body prose line number ${i} that anchors the column measure here today`,
            l: 0,
            size: 9,
            font: 'GlyphLessFont',
            gapAfter: i === 5 ? 14 : 2,
        }));

    it('demotes a full-measure size-cued line on an OCR-layer document', () => {
        const all = items(
            [
                ...ocrFillers(),
                { text: FULL_MEASURE_PROSE, l: 0, size: 10, font: 'GlyphLessFont' },
            ],
            [bodyStyle(9, 'GlyphLessFont')],
        );
        const candidate = all.find(it => it.text.includes('modern science'));
        expect(candidate).toBeDefined();
        expect(candidate!.type).toBe('paragraph');
    });

    it('keeps a short size-cued heading on an OCR-layer document', () => {
        // A real heading is set short — it does not fill the column measure.
        const all = items(
            [
                ...ocrFillers(),
                { text: 'Introduction', l: 0, size: 10, font: 'GlyphLessFont' },
            ],
            [bodyStyle(9, 'GlyphLessFont')],
        );
        const heading = all.find(it => it.text.includes('Introduction'));
        expect(heading).toBeDefined();
        expect(heading!.type).toBe('header');
    });

    it('leaves a full-measure size-cued line on a normal digital PDF alone', () => {
        // Same geometry, real embedded fonts: font sizes are exact, so a
        // larger-size line genuinely is a heading — the guard must not fire.
        const all = items(
            [
                ...Array.from({ length: 6 }, (_, i) => ({
                    text: `body prose line number ${i} that anchors the column measure here today`,
                    l: 0,
                    size: 9,
                    font: 'Times-Roman',
                    gapAfter: i === 5 ? 14 : 2,
                })),
                { text: FULL_MEASURE_PROSE, l: 0, size: 10, font: 'Times-Roman' },
            ],
            [bodyStyle(9, 'Times-Roman')],
        );
        const candidate = all.find(it => it.text.includes('modern science'));
        expect(candidate).toBeDefined();
        expect(candidate!.type).toBe('header');
    });
});

// ---------------------------------------------------------------------------
// Short CJK section headings
//
// `minHeaderLength` is a character count calibrated for Latin scripts. CJK
// section headings are routinely a single two-character word ("前言",
// "引言", "结论"), so `isHeaderStyle` allows a 2-character floor when the
// text is predominantly CJK. The candidate still has to clear a heading
// rule (here a larger font size) to be promoted.
// ---------------------------------------------------------------------------
describe('short CJK section headings', () => {
    const items = (specs: LeaderLineSpec[], bodyStyles: TextStyle[]) =>
        detectParagraphs(makeColumnPageResult(specs), bodyStyles).items;

    it('promotes a two-character CJK heading carrying a size cue', () => {
        const all = items(
            [
                ...Array.from({ length: 4 }, (_, i) => ({
                    text: '这是一行中文正文用来锚定页面的主体样式与栏宽度信息',
                    l: 0,
                    size: 15,
                    font: 'CJKBody',
                    gapAfter: i === 3 ? 20 : 2,
                })),
                { text: '前言', l: 0, size: 21, font: 'CJKHeading' },
            ],
            [bodyStyle(15, 'CJKBody')],
        );
        const heading = all.find(it => it.text.includes('前言'));
        expect(heading).toBeDefined();
        expect(heading!.type).toBe('header');
    });

    it('still rejects a two-character Latin candidate as too short', () => {
        // The 2-character floor is gated to CJK content: a 2-char Latin
        // line stays below minHeaderLength and is not a heading.
        const all = items(
            [
                ...Array.from({ length: 4 }, (_, i) => ({
                    text: 'A line of plain English body prose anchoring the column',
                    l: 0,
                    size: 15,
                    font: 'Body-Serif',
                    gapAfter: i === 3 ? 20 : 2,
                })),
                { text: 'Ab', l: 0, size: 21, font: 'Heading-Serif' },
            ],
            [bodyStyle(15, 'Body-Serif')],
        );
        const candidate = all.find(it => it.text.trim() === 'Ab');
        expect(candidate).toBeDefined();
        expect(candidate!.type).toBe('paragraph');
    });
});
