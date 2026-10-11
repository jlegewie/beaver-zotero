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
    type ParagraphDetectionSettings,
} from '../../../src/beaver-extract/ParagraphDetector';
import type {
    PageLine,
    DetectedSpan,
    PageLineResult,
} from '../../../src/beaver-extract/LineDetector';
import { bboxHeight, type BoundingBox, type RawStyleRun, type TextStyle } from '@beaver/agent-core/extract/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function bbox(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: 'top-left' };
}

function makePageLine(
    text: string,
    style: { size: number; font: string; bold?: boolean; italic?: boolean },
): PageLine {
    const span: DetectedSpan = {
        text,
        bbox: bbox(0, 0, text.length * 10, 12),
        lineBBox: bbox(0, 0, text.length * 10, 12),
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
    };    /** Per-glyph style runs attached to the main span (see `RawLine.styleRuns`). */
    styleRuns?: RawStyleRun[];
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
            bbox: bbox(cursor, top, cursor + mWidth, top + spec.marker.size),
            lineBBox: bbox(cursor, top, cursor + mWidth, top + spec.marker.size),
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
        bbox: bbox(cursor, top, cursor + mainWidth, top + size),
        lineBBox: bbox(cursor, top, cursor + mainWidth, top + size),
        size,
        fontName: font,
        fontWeight: bold ? 'bold' : 'normal',
        fontStyle: italic ? 'italic' : 'normal',
        styleRuns: spec.styleRuns,
    };
    spans.push(mainSpan);

    const fullText = (spec.marker ? spec.marker.text : '') + mainText;
    const r = spec.r ?? cursor + mainWidth;
    return {
        spans,
        bboxes: spans.map(s => s.lineBBox),
        bbox: bbox(spec.l, top, r, top + lineHeight),
        text: fullText,
        fontSize: size,
    };
}

function makeColumnPageResult(specs: LeaderLineSpec[]): PageLineResult {
    let cursorTop = 0;
    const lines: PageLine[] = specs.map(s => {
        const line = makeMultiSpanLine(s, cursorTop);
        // Standard leading: line height + small inter-line gap.
        cursorTop += bboxHeight(line.bbox) + (s.gapAfter ?? 2);
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

    it('does not merge a numbered heading (1. Background) into the following body', () => {
        // A numbered section heading whose leading digit is reported at a
        // smaller size trips the marker-artifact GEOMETRY (smaller reported
        // size, comparable-or-taller bbox) just like a footnote marker — but
        // "1." is a section-number prefix, not a glued inline marker. The
        // marker gate must reject it (digit followed by a period, not a
        // letter); otherwise the suppression clears the font-size break and
        // swallows the heading into the first body line, demoting it.
        const detection = detectParagraphs(
            makeColumnPageResult([
                ...FILLERS,
                { text: '1. Background', l: 0, r: 300, size: 5, bboxHeight: 8.7, font: 'Heading-Sans' },
                { text: 'ordinary body text that follows the heading on the next line', l: 0, r: 300, size: 7, bboxHeight: 7.25, font: 'Minion-Regular' },
            ]),
            [BODY, FOOTNOTE_BODY],
        );
        const heading = detection.items.find(it => it.text.includes('1. Background'));
        const body = detection.items.find(it => it.text.includes('ordinary body text'));
        expect(heading).toBeDefined();
        expect(body).toBeDefined();
        // Heading is its own item, not fused with the body line.
        expect(heading!.id).not.toBe(body!.id);
        expect(heading!.text).not.toContain('ordinary body text');
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

    function items(specs: LeaderLineSpec[], bodyStyles: TextStyle[], settings: ParagraphDetectionSettings = {}) {
        return detectParagraphs(makeColumnPageResult(specs), bodyStyles, settings).items;
    }

    // Per-glyph style run (see `RawLine.styleRuns`).
    function run(
        font: string,
        chars: number,
        letters: number,
        opts: { size?: number; exactSize?: number; bold?: boolean; italic?: boolean } = {},
    ): RawStyleRun {
        return {
            font: {
                name: font,
                family: font,
                weight: opts.bold ? 'bold' : 'normal',
                style: opts.italic ? 'italic' : 'normal',
                size: opts.size ?? 10,
            },
            exactSize: opts.exactSize,
            chars,
            letters,
        };
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

    describe('majority styling veto', () => {
        // MuPDF reports a line's font from its first glyph. With per-glyph
        // style runs, a heading cue carried by the opening word alone no
        // longer makes the line a heading.
        function kindOf(spec: LeaderLineSpec, needle: string): string | undefined {
            return items([...FILLERS_BEFORE_HEADING, spec], [BODY]).find(it => it.text.includes(needle))?.type;
        }

        it('demotes a line whose bold cue is only the run-in label', () => {
            const spec: LeaderLineSpec = {
                text: 'Practice points: undocumented immigrant; stop and frisk',
                l: 0,
                size: 10,
                bold: true,
                font: 'Sans-Bold',
            };
            // Without style runs the first-glyph bold reads as a bold line.
            expect(kindOf(spec, 'Practice points:')).toBe('header');
            const runs = [run('Sans-Bold', 15, 14, { bold: true }), run('Sans', 39, 37)];
            expect(kindOf({ ...spec, styleRuns: runs }, 'Practice points:')).toBe('paragraph');
        });

        it('demotes a line whose italic cue is only the opening word', () => {
            const runs = [
                run('Times-Italic', 5, 4, { italic: true }),
                run('Times-Roman', 1, 0),
                run('Times-Italic', 1, 1, { italic: true }),
                run('Times-Roman', 6, 0),
                run('Times-Roman', 1, 0),
                run('Times-Italic', 1, 1, { italic: true }),
                run('Times-Roman', 6, 0),
            ];
            const spec: LeaderLineSpec = {
                text: 'Note: * p < 0.05; † p < 0.01.',
                l: 0,
                size: 10,
                italic: true,
                font: 'Times-Italic',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'Note:')).toBe('paragraph');
        });

        it('demotes a line whose semibold face covers only the run-in label', () => {
            // The semibold label has more glyphs than either plain face after
            // it, but a weight-named face must cover the majority share to
            // describe the line.
            const runs = [
                run('Graphik-Semibold', 21, 21, { bold: true }),
                run('Graphik-RegularItalic', 14, 14, { italic: true }),
                run('Graphik-Regular', 20, 19),
            ];
            const spec: LeaderLineSpec = {
                text: 'Peer review information Nature Medicine thanks Harald Kittler,',
                l: 0,
                size: 10,
                bold: true,
                font: 'Graphik-Semibold',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'Peer review information')).toBe('paragraph');
        });

        it('keeps a semibold heading with a short math run', () => {
            const runs = [run('Graphik-Semibold', 30, 30, { bold: true }), run('Graphik-Regular', 3, 2)];
            const spec: LeaderLineSpec = {
                text: 'Estimating the effect of X on outcomes',
                l: 0,
                size: 10,
                font: 'Graphik-Semibold',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'Estimating the effect')).toBe('header');
        });

        it('keeps a bold heading with a trailing footnote marker in another font', () => {
            const runs = [run('Heading-Bold', 19, 19, { bold: true }), run('Times-Roman', 1, 0, { size: 7 })];
            const spec: LeaderLineSpec = {
                text: 'Materials and Methods1',
                l: 0,
                size: 10,
                bold: true,
                font: 'Heading-Bold',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'Materials and Methods')).toBe('header');
        });

        it('keeps a fake small-caps heading set in two sizes of one font', () => {
            const runs = [run('Times-Roman', 3, 2, { size: 12 }), run('Times-Roman', 11, 11, { size: 9 })];
            const spec: LeaderLineSpec = {
                text: 'I. INTRODUCTION',
                l: 0,
                size: 12,
                font: 'Times-Roman',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'INTRODUCTION')).toBe('header');
        });

        it('does not let math-font glyphs outvote a bold heading', () => {
            const runs = [
                run('Heading-Bold', 12, 12, { bold: true }),
                run('CMMI10', 1, 1, { italic: true }),
                run('CMR10', 1, 0),
                run('CMMI10', 5, 5, { italic: true }),
                run('Heading-Bold', 4, 4, { bold: true }),
            ];
            const spec: LeaderLineSpec = {
                text: 'Bounds for the k = const case',
                l: 0,
                size: 10,
                bold: true,
                font: 'Heading-Bold',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'Bounds for the')).toBe('header');
        });

        it('keeps a heading separate from a following line that only opens in bold', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    // Both lines end at the column's right edge, so no early-line-end
                    // break separates them; only the style change does.
                    { text: 'Add a walrus', l: 0, r: 305, size: 10, bold: true, font: 'Georgia-Bold' },
                    {
                        text: 'Add a walrus is delightfully dumb. Upload an image to try it.',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Sans-Bold',
                        styleRuns: [run('Sans-Bold', 10, 10, { bold: true }), run('Sans', 42, 39)],
                    },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Add a walrus'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('delightfully');
            const body = all.find(it => it.text.includes('delightfully'));
            expect(body!.type).toBe('paragraph');
        });

        it('keeps a heading separate from a same-style run-in line set below it', () => {
            // A heading sits above its paragraph with extra space; the gap,
            // not the opening style, ends the heading.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: 'Materials and Methods',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-Bold',
                        gapAfter: 14,
                    },
                    {
                        text: 'Keywords: undocumented immigrant; stop and frisk; education',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-Bold',
                        styleRuns: [run('Heading-Bold', 9, 8, { bold: true }), run('Sans', 45, 44)],
                    },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Materials and Methods'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('Keywords');
            expect(all.find(it => it.text.includes('Keywords:'))!.type).toBe('paragraph');
        });

        it('keeps a larger heading separate from a same-font run-in line set one point smaller', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: 'Materials and Methods',
                        l: 0,
                        r: 305,
                        size: 11,
                        bold: true,
                        font: 'Heading-Bold',
                        styleRuns: [run('Heading-Bold', 19, 19, { size: 11, exactSize: 11, bold: true })],
                    },
                    {
                        text: 'Study design. Participants were recruited from twelve clinics',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-Bold',
                        styleRuns: [
                            run('Heading-Bold', 12, 11, { exactSize: 10, bold: true }),
                            run('Sans', 44, 42, { exactSize: 10 }),
                        ],
                    },
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Materials and Methods'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('Study design');
        });

        it('treats a one-point difference from size truncation as the same face', () => {
            // An italic reference title wrapping across lines whose sizes
            // truncate to 10 and 9 (exact 10.06 / 9.86) stays one paragraph.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: 'of Interior Immigration Enforcement on the Behaviors of',
                        l: 0,
                        r: 305,
                        size: 10,
                        italic: true,
                        font: 'Times-Italic',
                        styleRuns: [run('Times-Italic', 50, 48, { size: 10, exactSize: 10.06, italic: true })],
                    },
                    {
                        text: 'Immigrants. Report. La Jolla, CA: Policy Center and other places.',
                        l: 0,
                        r: 305,
                        size: 9,
                        italic: true,
                        font: 'Times-Italic',
                        styleRuns: [
                            run('Times-Italic', 11, 10, { size: 9, exactSize: 9.86, italic: true }),
                            run('Times-Roman', 46, 40, { size: 9, exactSize: 9.96 }),
                        ],
                    },
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('of Interior'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('Immigrants. Report.');
        });

        it('keeps a run-in heading that wraps onto its second line in one paragraph', () => {
            // Without a gap, a full-width bold line followed by a line that
            // opens in the same bold face is a wrapped run-in heading, not a
            // heading followed by a paragraph.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: 'Generation of Constructs for Expression in',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-Bold',
                    },
                    {
                        text: 'Mammalian Cells. We cloned the full-length coding sequence into',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-Bold',
                        styleRuns: [run('Heading-Bold', 15, 14, { bold: true }), run('Sans', 40, 39)],
                    },
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Generation of Constructs'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('Mammalian Cells. We cloned');
        });

        it('never promotes a line on its majority styling', () => {
            // An italic quotation whose opening quote mark is in the body
            // font: the first-glyph style rejects it, and the italic majority
            // must not override that.
            const runs = [
                run('Times-Roman', 1, 0),
                run('Times-Italic', 40, 38, { italic: true }),
                run('Times-Roman', 1, 0),
            ];
            const spec: LeaderLineSpec = {
                text: '“Quoted words in italic carry no heading signal at all.”',
                l: 0,
                size: 10,
                font: 'Times-Roman',
                styleRuns: runs,
            };
            expect(kindOf(spec, 'Quoted words')).toBe('paragraph');
        });
    });

    describe('numbered headings with the number in the body face', () => {
        // "2.4 Freeing Up Women's Time": the section number is set in the
        // body face and the title in italic.
        function numbered(text: string, titleChars: number, r: number, withRuns = true): LeaderLineSpec {
            const numberChars = text.split(' ')[0].length;
            return {
                text,
                l: 0,
                r,
                size: 10,
                font: 'Times-Roman',
                styleRuns: withRuns
                    ? [run('Times-Roman', numberChars, 0), run('Times-Italic', titleChars, titleChars, { italic: true })]
                    : undefined,
            };
        }
        const BODY_AFTER: LeaderLineSpec[] = FILLERS.slice(0, 2);

        it('promotes a numbered title set in a heading face', () => {
            const all = items(
                [...FILLERS_BEFORE_HEADING, numbered('2.4 Freeing Up Women’s Time', 22, 140), ...BODY_AFTER],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Freeing Up'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('Filler');
        });

        it('keeps a wrapped numbered title in one heading', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    numbered('2.1 Relaxing the Grip of Poverty through', 34, 200),
                    {
                        text: 'Economic Development',
                        l: 0,
                        r: 105,
                        size: 10,
                        italic: true,
                        font: 'Times-Italic',
                        styleRuns: [run('Times-Italic', 19, 19, { italic: true })],
                        gapAfter: 8,
                    },
                    ...BODY_AFTER,
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Relaxing the Grip'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).toContain('Economic Development');
        });

        it('does not promote a numbered line whose text opens in the body face', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: '2. The book Wealth of Nations is cited throughout.',
                        l: 0,
                        r: 250,
                        size: 10,
                        font: 'Times-Roman',
                        styleRuns: [
                            run('Times-Roman', 10, 8),
                            run('Times-Italic', 15, 15, { italic: true }),
                            run('Times-Roman', 17, 16),
                        ],
                    },
                    ...BODY_AFTER,
                ],
                [BODY],
            );
            expect(all.find(it => it.text.includes('Wealth of Nations'))!.type).toBe('paragraph');
        });

        it('keeps a numbered run-in heading that wraps into its paragraph', () => {
            // The title wraps onto a line that opens in the same bold face and
            // switches to body prose at normal leading.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: '2.4 Generation of Constructs for Expression in',
                        l: 0,
                        r: 305,
                        size: 10,
                        font: 'Times-Roman',
                        styleRuns: [run('Times-Roman', 3, 0), run('Times-Bold', 38, 38, { bold: true })],
                    },
                    {
                        text: 'Mammalian Cells. We cloned the full-length coding sequence into',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Times-Bold',
                        styleRuns: [run('Times-Bold', 15, 14, { bold: true }), run('Times-Roman', 48, 46)],
                    },
                    ...BODY_AFTER,
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Generation of Constructs'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('Mammalian Cells. We cloned');
        });

        it('does not promote a table row whose first cell is a numbered label', () => {
            // "1. Placebo treatment | 40 | 50": the label and the value cells
            // are separate spans; only the label is bold.
            const page = makeColumnPageResult([...FILLERS_BEFORE_HEADING, ...BODY_AFTER]);
            const lines = page.columnResults[0].lines;
            const top = lines[FILLERS_BEFORE_HEADING.length - 1].bbox.b + 14;
            const cell = (text: string, l: number, runs: RawStyleRun[]): DetectedSpan => ({
                text,
                bbox: bbox(l, top, l + text.length * 5, top + 10),
                lineBBox: bbox(l, top, l + text.length * 5, top + 10),
                size: 10,
                fontName: 'Times-Roman',
                fontWeight: 'normal',
                fontStyle: 'normal',
                styleRuns: runs,
            });
            const spans = [
                cell('1. Placebo treatment', 0, [run('Times-Roman', 2, 0), run('Times-Bold', 16, 16, { bold: true })]),
                cell('40', 200, [run('Times-Roman', 2, 0)]),
                cell('50', 260, [run('Times-Roman', 2, 0)]),
            ];
            const row: PageLine = {
                spans,
                bboxes: spans.map(s => s.lineBBox),
                bbox: bbox(0, top, 270, top + 12),
                text: '1. Placebo treatment 40 50',
                fontSize: 10,
            };
            // Shift the body lines below the row.
            for (const line of lines.slice(FILLERS_BEFORE_HEADING.length)) {
                const shift = 30;
                line.bbox = bbox(line.bbox.l, line.bbox.t + shift, line.bbox.r, line.bbox.b + shift);
            }
            lines.splice(FILLERS_BEFORE_HEADING.length, 0, row);
            page.allLines = lines;
            const all = detectParagraphs(page, [BODY]).items;
            expect(all.find(it => it.text.includes('Placebo'))!.type).toBe('paragraph');
        });

        it('promotes a numbered title that continues in a second span', () => {
            // The title is split across two spans, both in the title's face.
            const page = makeColumnPageResult([...FILLERS_BEFORE_HEADING, ...BODY_AFTER]);
            const lines = page.columnResults[0].lines;
            const top = lines[FILLERS_BEFORE_HEADING.length - 1].bbox.b + 14;
            const span = (text: string, l: number, font: string, runs: RawStyleRun[]): DetectedSpan => ({
                text,
                bbox: bbox(l, top, l + text.length * 5, top + 10),
                lineBBox: bbox(l, top, l + text.length * 5, top + 10),
                size: 10,
                fontName: font,
                fontWeight: 'normal',
                fontStyle: font.includes('Italic') ? 'italic' : 'normal',
                styleRuns: runs,
            });
            const spans = [
                span('4.2 Power absorption', 0, 'Times-Roman', [
                    run('Times-Roman', 3, 0),
                    run('Times-Italic', 15, 15, { italic: true }),
                ]),
                span('of particle suspensions', 105, 'Times-Italic', [run('Times-Italic', 21, 21, { italic: true })]),
            ];
            const heading: PageLine = {
                spans,
                bboxes: spans.map(s => s.lineBBox),
                bbox: bbox(0, top, 220, top + 12),
                text: '4.2 Power absorption of particle suspensions',
                fontSize: 10,
            };
            for (const line of lines.slice(FILLERS_BEFORE_HEADING.length)) {
                line.bbox = bbox(line.bbox.l, line.bbox.t + 30, line.bbox.r, line.bbox.b + 30);
            }
            lines.splice(FILLERS_BEFORE_HEADING.length, 0, heading);
            page.allLines = lines;
            const all = detectParagraphs(page, [BODY]).items;
            expect(all.find(it => it.text.includes('Power absorption'))!.type).toBe('header');
        });

        it('promotes a numbered title with a math-font span', () => {
            const page = makeColumnPageResult([...FILLERS_BEFORE_HEADING, ...BODY_AFTER]);
            const lines = page.columnResults[0].lines;
            const top = lines[FILLERS_BEFORE_HEADING.length - 1].bbox.b + 14;
            const span = (text: string, l: number, font: string, runs: RawStyleRun[]): DetectedSpan => ({
                text,
                bbox: bbox(l, top, l + text.length * 5, top + 10),
                lineBBox: bbox(l, top, l + text.length * 5, top + 10),
                size: 10,
                fontName: font,
                fontWeight: 'normal',
                fontStyle: 'italic',
                styleRuns: runs,
            });
            const spans = [
                span('2. Case of the entangled state', 0, 'Times-Roman', [
                    run('Times-Roman', 2, 0),
                    run('Times-Italic', 24, 24, { italic: true }),
                ]),
                span('Ψ', 155, 'CMMI10', [run('CMMI10', 1, 1, { italic: true })]),
            ];
            const heading: PageLine = {
                spans,
                bboxes: spans.map(s => s.lineBBox),
                bbox: bbox(0, top, 160, top + 12),
                text: '2. Case of the entangled state Ψ',
                fontSize: 10,
            };
            for (const line of lines.slice(FILLERS_BEFORE_HEADING.length)) {
                line.bbox = bbox(line.bbox.l, line.bbox.t + 30, line.bbox.r, line.bbox.b + 30);
            }
            lines.splice(FILLERS_BEFORE_HEADING.length, 0, heading);
            page.allLines = lines;
            const all = detectParagraphs(page, [BODY]).items;
            expect(all.find(it => it.text.includes('entangled state'))!.type).toBe('header');
        });

        it('does not promote a bare page number before a running head', () => {
            const all = items(
                [...FILLERS_BEFORE_HEADING, { ...numbered('90 Aoife O’Donoghue and Adam Rowe', 25, 180), gapAfter: 12 }, ...BODY_AFTER],
                [BODY],
            );
            expect(all.find(it => it.text.includes('Aoife'))!.type).toBe('paragraph');
        });

        it('does not promote an affiliation behind a smaller marker number', () => {
            const spec = { ...numbered('2. Center for Anxiety and Traumatic Stress Disorders', 46, 260), gapAfter: 12 };
            spec.styleRuns = [run('Times-Roman', 2, 0, { size: 6, exactSize: 6 }), run('Times-Italic', 46, 46, { italic: true })];
            const all = items([...FILLERS_BEFORE_HEADING, spec, ...BODY_AFTER], [BODY]);
            expect(all.find(it => it.text.includes('Center for Anxiety'))!.type).toBe('paragraph');
        });

        it('does not promote a contents entry with dot leaders', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { ...numbered('12.9.5. Grupo familiar . . . . . . . . . 45', 30, 300), gapAfter: 12 },
                    ...BODY_AFTER,
                ],
                [BODY],
            );
            expect(all.find(it => it.text.includes('Grupo familiar'))!.type).toBe('paragraph');
        });

        it('does not promote a numbered entry set smaller than the body', () => {
            const spec: LeaderLineSpec = {
                text: '89. Sandhu S, Lemmon ME, Eisenson H, Crowder C',
                l: 0,
                r: 230,
                size: 8,
                font: 'Times-Roman',
                styleRuns: [run('Times-Roman', 3, 0, { size: 8 }), run('Times-Bold', 36, 30, { size: 8, bold: true })],
                gapAfter: 12,
            };
            const all = items([...FILLERS_BEFORE_HEADING, spec, ...BODY_AFTER], [BODY]);
            expect(all.find(it => it.text.includes('Sandhu'))!.type).toBe('paragraph');
        });

        it('leaves the line alone without style runs', () => {
            const all = items(
                [...FILLERS_BEFORE_HEADING, numbered('2.4 Freeing Up Women’s Time', 22, 140, false), ...BODY_AFTER],
                [BODY],
            );
            expect(all.find(it => it.text.includes('Freeing Up'))!.type).toBe('paragraph');
        });
    });

    describe('size differences within one font', () => {
        // Style runs in one font at different sizes: fake small caps,
        // superscripts and subscripts, size-truncation jitter, and text set
        // larger in the body font for emphasis.
        function kindOf(spec: LeaderLineSpec, needle: string): string | undefined {
            return items([...FILLERS_BEFORE_HEADING, spec, ...FILLERS.slice(0, 2)], [BODY]).find(it =>
                it.text.includes(needle),
            )?.type;
        }

        it('demotes a line whose run-in label is set larger in the body font', () => {
            // "Speed: Translation by…": the label is emphasized by size, not
            // by a bold face, so the first glyph reads larger than the body.
            const spec: LeaderLineSpec = {
                text: 'Speed: Translation by or with the aid of machines can be faster.',
                l: 0,
                size: 11,
                font: 'Times-Roman',
            };
            expect(kindOf({ ...spec, gapAfter: 12 }, 'Speed:')).toBe('header');
            const runs = [
                run('Times-Roman', 6, 5, { size: 11, exactSize: 10.8 }),
                run('Times-Roman', 49, 44, { size: 10, exactSize: 10 }),
            ];
            expect(kindOf({ ...spec, gapAfter: 12, styleRuns: runs }, 'Speed:')).toBe('paragraph');
        });

        it('demotes prose around a larger operator glyph', () => {
            const runs = [
                run('Times-Roman', 2, 2, { size: 13, exactSize: 13.6 }),
                run('Times-Roman', 16, 14, { size: 10, exactSize: 10 }),
                run('Times-Roman', 1, 0, { size: 13, exactSize: 13.6 }),
                run('Times-Roman', 20, 18, { size: 10, exactSize: 10 }),
            ];
            const spec: LeaderLineSpec = {
                text: 'If x is part of y, then x = ab is a substring of y here',
                l: 0,
                size: 13,
                font: 'Times-Roman',
                styleRuns: runs,
                gapAfter: 12,
            };
            expect(kindOf(spec, 'If x is part')).toBe('paragraph');
        });

        it('keeps a heading whose acronyms are set in small caps', () => {
            // Capital letters set smaller in the heading's own font.
            const runs = [
                run('Sans', 10, 10, { size: 12, exactSize: 12 }),
                run('Sans', 5, 5, { size: 10, exactSize: 9.6 }),
                run('Sans', 3, 3, { size: 12, exactSize: 12 }),
                run('Sans', 4, 4, { size: 10, exactSize: 9.6 }),
            ];
            const spec: LeaderLineSpec = {
                text: 'Estimating NAIRU for OECD',
                l: 0,
                size: 12,
                font: 'Sans',
                styleRuns: runs,
                gapAfter: 12,
            };
            expect(kindOf(spec, 'Estimating NAIRU')).toBe('header');
        });

        it('keeps a heading with lowercase subscripts', () => {
            // "2. Case 2h2m": the subscripts are set much smaller than the
            // italic title, in the title's own font.
            const runs = [
                run('Times-Roman', 2, 0, { exactSize: 10 }),
                run('Times-Italic', 4, 4, { exactSize: 10, italic: true }),
                run('Times-Roman', 1, 0, { size: 6, exactSize: 6 }),
                run('Times-Italic', 1, 1, { size: 6, exactSize: 6, italic: true }),
                run('Times-Roman', 1, 0, { size: 6, exactSize: 6 }),
                run('Times-Italic', 1, 1, { size: 6, exactSize: 6, italic: true }),
            ];
            const spec: LeaderLineSpec = {
                text: '2. Case 2h2m',
                l: 0,
                size: 10,
                font: 'Times-Roman',
                styleRuns: runs,
                gapAfter: 12,
            };
            expect(kindOf(spec, 'Case 2h2m')).toBe('header');
        });
    });

    describe('numbered titles split from their section number', () => {
        // A wide space after the section number makes the number a span of
        // its own; the number and the title read as two styles when their
        // sizes truncate differently (11.94 → 11, 12.0 → 12).
        function lineOf(parts: { text: string; font: string; size: number; runs: RawStyleRun[] }[]): {
            page: PageLineResult;
            text: string;
        } {
            const page = makeColumnPageResult([...FILLERS_BEFORE_HEADING, ...FILLERS.slice(0, 2)]);
            const lines = page.columnResults[0].lines;
            const top = lines[FILLERS_BEFORE_HEADING.length - 1].bbox.b + 14;
            let l = 0;
            const spans: DetectedSpan[] = parts.map(part => {
                const r = l + part.text.length * 5;
                const span: DetectedSpan = {
                    text: part.text,
                    bbox: bbox(l, top, r, top + part.size),
                    lineBBox: bbox(l, top, r, top + part.size),
                    size: part.size,
                    fontName: part.font,
                    fontWeight: part.font.includes('Bold') ? 'bold' : 'normal',
                    fontStyle: part.font.includes('Italic') ? 'italic' : 'normal',
                    styleRuns: part.runs,
                };
                l = r + 15;
                return span;
            });
            const text = parts.map(p => p.text).join(' ');
            const line: PageLine = {
                spans,
                bboxes: spans.map(s => s.lineBBox),
                bbox: bbox(0, top, l, top + 13),
                text,
                fontSize: parts[0].size,
            };
            for (const below of lines.slice(FILLERS_BEFORE_HEADING.length)) {
                below.bbox = bbox(below.bbox.l, below.bbox.t + 30, below.bbox.r, below.bbox.b + 30);
            }
            lines.splice(FILLERS_BEFORE_HEADING.length, 0, line);
            page.allLines = lines;
            return { page, text };
        }

        it('promotes a numbered title whose number is set in its face at a jittered size', () => {
            const { page } = lineOf([
                {
                    text: '2.1.1',
                    font: 'Sans-Bold',
                    size: 11,
                    runs: [run('Sans-Bold', 5, 0, { size: 11, exactSize: 11.94, bold: true })],
                },
                {
                    text: 'Levels of Linguistic Description',
                    font: 'Sans-Bold',
                    size: 12,
                    runs: [run('Sans-Bold', 29, 29, { size: 12, exactSize: 12, bold: true })],
                },
            ]);
            const all = detectParagraphs(page, [BODY]).items;
            expect(all.find(it => it.text.includes('Levels of Linguistic'))!.type).toBe('header');
        });

        it('does not read another subset of the number’s font as a title face', () => {
            // A numbered reference entry set larger than the body: the
            // author names need a glyph from a second subset of the same face.
            const { page } = lineOf([
                { text: '27.', font: 'AAAAAA+Calibri', size: 11, runs: [run('AAAAAA+Calibri', 3, 0, { size: 11 })] },
                {
                    text: 'Henyš P and Čapek L. Individual yarn fibre extraction',
                    font: 'BBBBBB+Calibri',
                    size: 11,
                    runs: [run('BBBBBB+Calibri', 46, 42, { size: 11 })],
                },
            ]);
            const all = detectParagraphs(page, [BODY]).items;
            expect(all.find(it => it.text.includes('Henyš'))!.type).toBe('paragraph');
        });

        it('does not describe a line by an italic face that covers only part of it', () => {
            // A numbered question: an italic question, then its roman gloss.
            // The italic face has the most glyphs but doesn't make the line
            // italic.
            const { page } = lineOf([
                { text: '2.', font: 'Garamond', size: 10, runs: [run('Garamond', 2, 0)] },
                {
                    text: 'Was sind Medienveränderungen im Netzwerk? Konkret: Was sind die',
                    font: 'Garamond-Italic',
                    size: 10,
                    runs: [run('Garamond-Italic', 37, 35, { italic: true }), run('Garamond', 25, 22)],
                },
            ]);
            const all = detectParagraphs(page, [bodyStyle(10, 'Garamond')]).items;
            expect(all.find(it => it.text.includes('Medienveränderungen'))!.type).toBe('paragraph');
        });
    });

    describe('heading followed by a flush-left paragraph', () => {
        // The column's right edge sits at 305 (filler lines). A long heading
        // that stops short of it by less than the early-line-end threshold
        // is followed by a paragraph at normal leading: no gap, indent or
        // early-end break separates them.
        const BODY_LINES: LeaderLineSpec[] = [
            'The first paragraph after the heading starts flush left here.',
            'and it continues at the same leading as the rest of the text.',
        ].map(text => ({
            text,
            l: 0,
            r: 305,
            size: 10,
            font: 'Times-Roman',
            styleRuns: [run('Times-Roman', 50, 48)],
        }));

        function headingSpec(text: string, r: number, withRuns = true): LeaderLineSpec {
            return {
                text,
                l: 0,
                r,
                size: 10,
                bold: true,
                font: 'Heading-BoldItalic',
                styleRuns: withRuns ? [run('Heading-BoldItalic', 60, 58, { bold: true })] : undefined,
            };
        }

        it('ends a long heading at the first body line', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    headingSpec('Neighborhood racial boundaries versus other forms of spatial interdependence', 270),
                    ...BODY_LINES,
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('Neighborhood racial boundaries'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('first paragraph');
            expect(all.find(it => it.text.includes('first paragraph'))!.type).toBe('paragraph');
        });

        it('keeps the heading merged when lines carry no style runs', () => {
            // Without per-glyph runs a prose line opening with a bold phrase
            // can't be told from a heading line, so the boundary needs them.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    headingSpec('Neighborhood racial boundaries versus other forms of spatial interdependence', 270, false),
                    ...BODY_LINES.map(spec => ({ ...spec, styleRuns: undefined })),
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Neighborhood racial boundaries'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('first paragraph');
        });

        it('does not split a bold line that fills the column from the text it wraps into', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: 'Applications of single-cell transcriptomics in tumour biology. One major',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-Bold',
                        styleRuns: [run('Heading-Bold', 55, 52, { bold: true }), run('Times-Roman', 9, 8)],
                    },
                    ...BODY_LINES,
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Applications of single-cell'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('first paragraph');
        });

        it('keeps a ragged run-in heading that wraps into its paragraph', () => {
            // The first line ends short of the right edge, as in ragged-right
            // text; the second line opens in the same bold face and switches
            // to the body face.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    headingSpec('Generation of Constructs for Expression in', 270),
                    {
                        text: 'Mammalian Cells. We cloned the full-length coding sequence into',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-BoldItalic',
                        styleRuns: [
                            run('Heading-BoldItalic', 15, 14, { bold: true }),
                            run('Times-Roman', 48, 46),
                        ],
                    },
                    ...BODY_LINES,
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Generation of Constructs'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('Mammalian Cells. We cloned');
        });

        it('ends a heading above a paragraph that opens with its own run-in lead', () => {
            // Same bold face as the heading, but set slightly apart (4pt
            // against 2pt leading, still below the paragraph-gap threshold).
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { ...headingSpec('A.5.2 Effect of k on answer consistency in the ablation', 280), gapAfter: 4 },
                    {
                        text: 'Accuracy. Small values of k stop the search too early and hurt',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-BoldItalic',
                        styleRuns: [
                            run('Heading-BoldItalic', 9, 8, { bold: true }),
                            run('Times-Roman', 45, 43),
                        ],
                    },
                    ...BODY_LINES,
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('A.5.2 Effect of k'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('Accuracy.');
        });

        it('ends an all-caps heading set in the body face at the first body line', () => {
            const caps = (text: string, r: number): LeaderLineSpec => ({
                text,
                l: 0,
                r,
                size: 10,
                font: 'Times-Roman',
                styleRuns: [run('Times-Roman', text.replace(/\s/g, '').length, text.replace(/\W/g, '').length)],
            });
            const all = items(
                [...FILLERS_BEFORE_HEADING, caps('INTERNATIONAL HUMAN RIGHTS COMMUNICATION AS LEGAL', 250), ...BODY_LINES],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('INTERNATIONAL HUMAN RIGHTS'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).not.toContain('first paragraph');
        });

        it('keeps a wrapped all-caps heading together', () => {
            // Set in the body face: the single-word last line fails the
            // multi-word caps test on its own but continues the heading.
            const caps = (text: string, r: number): LeaderLineSpec => ({
                text,
                l: 0,
                r,
                size: 10,
                font: 'Times-Roman',
                styleRuns: [run('Times-Roman', text.replace(/\s/g, '').length, text.replace(/\W/g, '').length)],
            });
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    caps('INTERNATIONAL HUMAN RIGHTS COMMUNICATION AS LEGAL', 250),
                    caps('PREFIGURATION?', 70),
                    ...BODY_LINES,
                ],
                [BODY],
            );
            const heading = all.find(it => it.text.includes('INTERNATIONAL HUMAN RIGHTS'));
            expect(heading!.type).toBe('header');
            expect(heading!.text).toContain('PREFIGURATION?');
        });

        it('keeps a heading-styled line with the lowercase text that continues it', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    headingSpec('Accuracy verification and data cleaning: the', 240),
                    { ...BODY_LINES[1], text: 'accuracy and consistency of the extracted data were verified.' },
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('Accuracy verification'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('accuracy and consistency');
        });

        it('keeps a heading-styled line with a parenthesised note below it', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    headingSpec('S1 Appendix. Medline search strategy.', 200),
                    { ...BODY_LINES[1], text: '(DOCX)', r: 30 },
                ],
                [BODY],
            );
            expect(all.find(it => it.text.includes('S1 Appendix'))!.text).toContain('(DOCX)');
        });

        it('does not end a label that introduces the text below it', () => {
            const all = items(
                [...FILLERS_BEFORE_HEADING, headingSpec('Contact information for the program office:', 240), ...BODY_LINES],
                [BODY],
            );
            expect(all.find(it => it.text.includes('Contact information'))!.text).toContain('first paragraph');
        });

        it('does not split table rows', () => {
            // Column gaps of a table: a header row in a heading face over a
            // data row in the body face.
            function row(cells: string[], spec: LeaderLineSpec, top: number): PageLine {
                const line = makeMultiSpanLine({ ...spec, text: cells.join('') }, top);
                let x = 0;
                line.bboxes = cells.map(cell => {
                    const box = bbox(x, top, x + cell.length * 5, top + 10);
                    x += cell.length * 5 + 40;
                    return box;
                });
                line.text = cells.join(' ');
                return line;
            }
            const page = makeColumnPageResult([...FILLERS_BEFORE_HEADING]);
            const lines = page.columnResults[0].lines;
            const top = lines[lines.length - 1].bbox.b + 14;
            const header = row(['Source of variance', 'F', 'df', 'p'], headingSpec('', 250), top);
            const data = row(['Group effect', '89.9', '2,97', '0.000'], BODY_LINES[0], top + 14);
            lines.push(header, data);
            page.allLines = lines;
            const all = detectParagraphs(page, [BODY]).items;
            expect(all.find(it => it.text.includes('Source of variance'))!.text).toContain('Group effect');
        });

        it('keeps an italic journal name with its citation tail at the top of a column', () => {
            const all = items(
                [
                    {
                        text: 'International Journal of Environmental Research and Public Health',
                        l: 0,
                        r: 250,
                        size: 10,
                        italic: true,
                        font: 'Times-Italic',
                        styleRuns: [run('Times-Italic', 58, 58, { italic: true })],
                    },
                    {
                        text: '21, 1234–1248 (2024).',
                        l: 0,
                        r: 105,
                        size: 10,
                        font: 'Times-Roman',
                        styleRuns: [run('Times-Roman', 19, 0)],
                        gapAfter: 14,
                    },
                    ...FILLERS,
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('International Journal'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('1234–1248');
        });

        it('keeps a numbered italic journal name with its citation tail', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    {
                        text: '2. International Journal of Environmental Research and Public Health',
                        l: 0,
                        r: 250,
                        size: 10,
                        font: 'Times-Roman',
                        styleRuns: [run('Times-Roman', 2, 0), run('Times-Italic', 58, 58, { italic: true })],
                    },
                    {
                        text: '21, 1234–1248 (2024).',
                        l: 0,
                        r: 105,
                        size: 10,
                        font: 'Times-Roman',
                        styleRuns: [run('Times-Roman', 19, 0)],
                        gapAfter: 14,
                    },
                    ...FILLERS,
                ],
                [BODY],
            );
            const item = all.find(it => it.text.includes('International Journal'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('1234–1248');
        });

        it('judges a run-in continuation by its own leading on a mixed-leading page', () => {
            // A dense reference column pulls the page's median gap to 1pt;
            // the body column is set with 13pt gaps.
            function column(specs: LeaderLineSpec[], left: number, index: number): ColumnLineResult {
                let top = 0;
                const lines = specs.map(s => {
                    const line = makeMultiSpanLine({ ...s, l: s.l + left, r: s.r !== undefined ? s.r + left : undefined }, top);
                    top += bboxHeight(line.bbox) + (s.gapAfter ?? 2);
                    return line;
                });
                return {
                    column: { x: left, y: 0, w: 305, h: top },
                    columnIndex: index,
                    lines,
                };
            }
            const refs: LeaderLineSpec[] = Array.from({ length: 30 }, (_, i) => ({
                text: `Reference entry number ${i + 1} set densely in the side column.`,
                l: 0,
                r: 305,
                size: 10,
                font: 'Times-Roman',
                gapAfter: 1,
            }));
            const loose = (spec: LeaderLineSpec): LeaderLineSpec => ({ ...spec, gapAfter: 13 });
            const body = column(
                [
                    ...FILLERS.map(loose).map((f, i) => (i === FILLERS.length - 1 ? { ...f, gapAfter: 30 } : f)),
                    loose(headingSpec('Generation of Constructs for Expression in', 270)),
                    loose({
                        text: 'Mammalian Cells. We cloned the full-length coding sequence into',
                        l: 0,
                        r: 305,
                        size: 10,
                        bold: true,
                        font: 'Heading-BoldItalic',
                        styleRuns: [run('Heading-BoldItalic', 15, 14, { bold: true }), run('Times-Roman', 48, 46)],
                    }),
                    ...BODY_LINES.map(loose),
                ],
                0,
                0,
            );
            const side = column(refs, 330, 1);
            const page: PageLineResult = {
                pageIndex: 0,
                width: 700,
                height: 900,
                columnResults: [body, side],
                allLines: [...body.lines, ...side.lines],
            };
            const all = detectParagraphs(page, [BODY]).items;
            const item = all.find(it => it.text.includes('Generation of Constructs'));
            expect(item!.type).toBe('paragraph');
            expect(item!.text).toContain('Mammalian Cells. We cloned');
        });

        it('does not cut a paragraph after a diagonal watermark line', () => {
            // The watermark's box runs far down across the body lines that
            // follow it.
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { ...headingSpec('For Peer Review', 200), bboxHeight: 120, gapAfter: -110 },
                    ...BODY_LINES,
                ],
                [BODY],
            );
            expect(all.find(it => it.text.includes('For Peer Review'))!.text).toContain('first paragraph');
        });
    });

    describe('figure and table labels', () => {
        it('does not promote extended-data and supplementary caption titles', () => {
            for (const text of [
                'Extended Data Fig. 2 | MITOMICS profiles suggest new protein functions',
                'Supplementary Table 5: PCR conditions and primers used for validation',
            ]) {
                const all = items(
                    [...FILLERS_BEFORE_HEADING, { text, l: 0, size: 10, bold: true, font: 'Heading-Bold' }],
                    [BODY],
                );
                expect(all.find(it => it.text.includes(text.slice(0, 15)))!.type).toBe('paragraph');
            }
        });

        it('keeps extended-data and supplementary caption titles as headings without heading label filters', () => {
            const text = 'Supplementary Table 5: PCR conditions and primers used for validation';
            const all = items(
                [...FILLERS_BEFORE_HEADING, { text, l: 0, size: 10, bold: true, font: 'Heading-Bold' }],
                [BODY],
                { headingLabelFilters: false },
            );
            expect(all.find(it => it.text.includes(text.slice(0, 15)))!.type).toBe('header');
        });
    });

    describe('run-in labels', () => {
        function kindOf(text: string, settings: ParagraphDetectionSettings = {}): string | undefined {
            const all = items(
                [...FILLERS_BEFORE_HEADING, { text, l: 0, size: 10, bold: true, font: 'Heading-Bold' }],
                [BODY],
                settings,
            );
            return all.find(it => it.text.includes(text.slice(0, 12)))?.type;
        }

        it('keeps run-in label lines as headings without heading label filters', () => {
            const off = { headingLabelFilters: false };
            expect(kindOf('Received: 5 May 2020; Accepted: 2 June 2020', off)).toBe('header');
            expect(kindOf('Keywords Peer influence · Adolescence · Substance use', off)).toBe('header');
            expect(
                kindOf('Results: We found that the treatment improved outcomes in most of the enrolled patients', off),
            ).toBe('header');
        });

        it('demotes a front-matter label line set entirely in a heading face', () => {
            expect(kindOf('Received: 5 May 2020; Accepted: 2 June 2020')).toBe('paragraph');
            expect(kindOf('Conflict of interest: None declared')).toBe('paragraph');
            expect(kindOf('To cite this article: Smith J (2020) A study of things')).toBe('paragraph');
        });

        it('demotes a keywords line without a colon', () => {
            expect(kindOf('Keywords Peer influence · Adolescence · Substance use')).toBe('paragraph');
        });

        it('demotes a structured-abstract label followed by prose', () => {
            expect(
                kindOf('Results: We found that the treatment improved outcomes in most of the enrolled patients'),
            ).toBe('paragraph');
        });

        it('keeps a structured-abstract word heading with a subtitle', () => {
            expect(kindOf('Conclusion: Future Directions')).toBe('header');
        });

        it('keeps a long sentence-case subtitle that has no prose signal', () => {
            expect(kindOf('Results: Effects of the intervention on the quality of life in older adults')).toBe('header');
        });

        it('keeps a question subtitle', () => {
            // Ten words with auxiliaries and pronouns, past the prose-word check's floor.
            expect(
                kindOf('Conclusions: are there viable alternatives to the profit-maximising model of business?'),
            ).toBe('header');
        });

        it('keeps a question subtitle containing an initialism', () => {
            expect(
                kindOf(
                    'Conclusions: Are there viable alternatives to the profit-maximising model of business in the U.S. and Europe?',
                ),
            ).toBe('header');
        });

        it('keeps a long subtitle whose only prose-like feature is a number', () => {
            expect(
                kindOf('Results: Effects of the COVID-19 pandemic on the quality of life in older adults'),
            ).toBe('header');
        });

        it('demotes a run-in that asks a question and goes on in prose', () => {
            expect(
                kindOf('Objective: Does peer support improve outcomes? We conducted a randomized trial in schools'),
            ).toBe('paragraph');
        });

        it('demotes a run-in line that wraps before its sentence ends', () => {
            expect(
                kindOf('Results: We found that high basal area of very large trees, high volumes of standing'),
            ).toBe('paragraph');
        });

        it('keeps a label word standing alone as a heading', () => {
            expect(kindOf('Abstract')).toBe('header');
            expect(kindOf('Keywords')).toBe('header');
        });
    });

    describe('equations and web addresses', () => {
        // Display equations and link lines pass the style rules when set in
        // a larger face; a heading names its section in words.
        function kindOf(text: string, settings: ParagraphDetectionSettings = {}): string | undefined {
            const all = items(
                [...FILLERS_BEFORE_HEADING, { text, l: 0, size: 12, font: 'Times-Italic', italic: true }],
                [BODY],
                settings,
            );
            return all.find(it => it.text.includes(text.slice(0, 8)))?.type;
        }

        it('demotes a display equation', () => {
            expect(kindOf('Σ* = {0, a, b, aa, ab, aabb, abab, ... }')).toBe('paragraph');
            expect(kindOf('P(A, B) = P(A)P(B)')).toBe('paragraph');
            expect(kindOf('T = {(x,a,y),(x,b,z),(y,a,x),(y,b,z)}')).toBe('paragraph');
        });

        it('keeps a heading that mentions an equation', () => {
            expect(kindOf('4.3 Proving the efficiency for the k = const case')).toBe('header');
            expect(kindOf('B.3 PROOF FOR EQUATION ∆PK0(K0)T = 0')).toBe('header');
        });

        it('keeps a short mathematical title that names its subject in words', () => {
            expect(kindOf('2.1.1 Case n = 1')).toBe('header');
            expect(kindOf('3. Proof of a² + b² = c²')).toBe('header');
            expect(kindOf('3. Case 1: x = y')).toBe('header');
            expect(kindOf('3. Proof: a² + b² = c²')).toBe('header');
            expect(kindOf('Theorem 3.1 (n = 2)')).toBe('header');
        });

        it('demotes a numbered equation', () => {
            expect(kindOf('3. P(A U B) = P(A) + P(B) if A ∩ B = {}')).toBe('paragraph');
        });

        it('demotes an equation whose function arguments are words', () => {
            expect(kindOf('P(can | N) = 0.9 P(can | V) = 0.1')).toBe('paragraph');
        });

        it('demotes a line of web addresses', () => {
            expect(kindOf('www.aclweb.org')).toBe('paragraph');
            expect(kindOf('babel.uoregon.edu/yamada/guides.html')).toBe('paragraph');
            expect(kindOf('https://doi.org/10.1353/gsr.2014.0029')).toBe('paragraph');
            expect(kindOf('ftp://ftp.ora.com/pub/examples/nutshell/ujip/ doc/cjk.inf')).toBe('paragraph');
        });

        it('keeps a heading that names a site or a slash pair', () => {
            expect(kindOf('Booking.com')).toBe('header');
            expect(kindOf('Input/Output Systems')).toBe('header');
            expect(kindOf('Resources at www.aclweb.org')).toBe('header');
        });

        it('keeps equations and web addresses as headings without heading label filters', () => {
            const off = { headingLabelFilters: false };
            expect(kindOf('P(A, B) = P(A)P(B)', off)).toBe('header');
            expect(kindOf('www.aclweb.org', off)).toBe('header');
        });

        it('demotes a lone identifier: a wrapped link tail, an e-mail address, a rule', () => {
            expect(kindOf('071d4a94-28a8-11e4-8593-da634b334390_story.html')).toBe('paragraph');
            expect(kindOf('/content/333/6042/627.full.html')).toBe('paragraph');
            expect(kindOf('3f2a9c1e7b4d5a6c8e9f0a1b2c3d4e5f6a7b8c9d')).toBe('paragraph');
            expect(kindOf('9B2E4F1A-7C3D-4E5F-8A9B-0C1D2E3F4A5B')).toBe('paragraph');
            expect(kindOf('ophir.klein@ucsf.edu')).toBe('paragraph');
            expect(kindOf('______________________________')).toBe('paragraph');
        });

        it('keeps one-word headings, slash pairs and CJK headings', () => {
            expect(kindOf('ABCC10-Mediated-Chemoresistance')).toBe('header');
            expect(kindOf('Phosphatidylinositol-3-Kinase')).toBe('header');
            expect(kindOf('17β-Hydroxysteroid-Dehydrogenase')).toBe('header');
            expect(kindOf('Acknowledgements')).toBe('header');
            expect(kindOf('Literaturverzeichnis')).toBe('header');
            expect(kindOf('Metabolism/Elimination')).toBe('header');
            expect(kindOf('一、中国共产党纪律体系的历史演进2021')).toBe('header');
        });
    });

    describe('page body styles', () => {
        // A page appended in another face ("This article has been cited by:"
        // in Times under a New Caledonia article): its numbered entries fit
        // Rule 6 (same size, different font, section-number prefix) against
        // the document body, but on their own page that face is the body.
        const DOC_BODY = bodyStyle(10, 'NewCaledonia');
        const ENTRIES: LeaderLineSpec[] = Array.from({ length: 8 }, (_, i): LeaderLineSpec[] => [
            {
                text: `${i + 1}. A. Author, B. Author. 2011. A study of something that matters a great deal to`,
                l: 0,
                size: 10,
                font: 'Times-Roman',
            },
            { text: 'Economic Perspectives and Policy 3: 1-9.', l: 10, size: 10, font: 'Times-Roman', gapAfter: 14 },
        ]).flat();

        function types(specs: LeaderLineSpec[], settings: ParagraphDetectionSettings) {
            return items(specs, [DOC_BODY], settings).map(it => it.type);
        }

        it('reads the page style as body on a page set in another face', () => {
            expect(types(ENTRIES, { pageBodyStyles: true })).not.toContain('header');
        });

        it('keeps the document-wide reading without page body styles (PDF schema 4)', () => {
            expect(types(ENTRIES, { pageBodyStyles: false })).toContain('header');
        });

        it('keeps a heading that stands out on its page', () => {
            const heading: LeaderLineSpec = {
                text: 'This article has been cited by:',
                l: 0,
                size: 10,
                font: 'Times-Bold',
                bold: true,
                gapAfter: 10,
            };
            const all = items([heading, ...ENTRIES], [DOC_BODY], { pageBodyStyles: true });
            expect(all.filter(it => it.type === 'header').map(it => it.text)).toEqual([
                '## This article has been cited by:',
            ]);
        });

        it('keeps an all-caps heading set in the page body face', () => {
            // An appendix page set in Times under a New Caledonia document.
            const prose = (n: number): LeaderLineSpec[] =>
                Array.from({ length: n }, (_, i) => ({
                    text: `Appendix prose in the page face, line ${i + 1} of a paragraph that runs across the page.`,
                    l: 0,
                    size: 10,
                    font: 'Times-Roman',
                }));
            const before = prose(6);
            before[5] = { ...before[5], gapAfter: 14 };
            const heading: LeaderLineSpec = { text: 'APPENDIX METHODS', l: 0, size: 10, font: 'Times-Roman' };
            for (const pageBodyStyles of [false, true]) {
                const all = items([...before, heading, ...prose(6)], [DOC_BODY], { pageBodyStyles });
                expect(all.find(it => it.text.includes('APPENDIX METHODS'))?.type, String(pageBodyStyles)).toBe('header');
            }
        });

        it('keeps an all-caps heading that qualifies by the document body on a page with its own', () => {
            // Document body 11pt, the page's own body 9pt, the heading 10pt,
            // all in one face: not larger than the document body, it is a
            // heading as it would be without the page's body style.
            const docBody = bodyStyle(11, 'Times-Bold', true);
            const prose = (n: number): LeaderLineSpec[] =>
                Array.from({ length: n }, (_, i) => ({
                    text: `Reference list text set smaller, line ${i + 1} of an entry that runs across the page.`,
                    l: 0,
                    size: 9,
                    font: 'Times-Bold',
                    bold: true,
                }));
            const before = prose(6);
            before[5] = { ...before[5], gapAfter: 14 };
            const heading: LeaderLineSpec = { text: 'REFERENCES', l: 0, size: 10, font: 'Times-Bold', bold: true };
            for (const pageBodyStyles of [false, true]) {
                const all = items([...before, heading, ...prose(6)], [docBody], { pageBodyStyles });
                expect(all.find(it => it.text.includes('REFERENCES'))?.type, String(pageBodyStyles)).toBe('header');
            }
        });

        it('keeps a CJK heading on a page set in another body face at the body size', () => {
            // A 10pt SimSun document with an appendix page in NotoSansCJK: the
            // page's body face is no evidence that the document's body font is
            // split across subsets.
            const prose = (n: number): LeaderLineSpec[] =>
                Array.from({ length: n }, () => ({
                    text: '本附录说明研究所使用的数据来源样本构成以及变量的测量方式和处理过程',
                    l: 0,
                    size: 10,
                    font: 'NotoSansCJK-Regular',
                }));
            const before = prose(12);
            before[11] = { ...before[11], gapAfter: 14 };
            const heading: LeaderLineSpec = { text: '研究方法', l: 0, size: 10, font: 'NotoSansCJK-Medium' };
            for (const pageBodyStyles of [false, true]) {
                const all = items([...before, heading, ...prose(12)], [bodyStyle(10, 'SimSun')], { pageBodyStyles });
                expect(all.find(it => it.text.includes('研究方法'))?.type, String(pageBodyStyles)).toBe('header');
            }
        });

        it('leaves a page with document body text to the document-wide rules', () => {
            const body: LeaderLineSpec[] = Array.from({ length: 12 }, (_, i) => ({
                text: `Ordinary body text in the document face, line ${i + 1} of the section that continues.`,
                l: 0,
                size: 10,
                font: 'NewCaledonia',
            }));
            const heading: LeaderLineSpec = { text: '2.1 Methods and Data', l: 0, size: 10, font: 'Helvetica' };
            const all = items(
                [...body.slice(0, 6), { ...body[5], gapAfter: 14 }, heading, ...body.slice(6)],
                [DOC_BODY],
                { pageBodyStyles: true },
            );
            expect(all.find(it => it.text.includes('Methods'))?.type).toBe('header');
        });
    });

    describe('numbered CJK headings styled only by their number', () => {
        function run(font: string, chars: number, letters: number, size: number, bold = false): RawStyleRun {
            const weight = bold ? 'bold' : 'normal';
            return { font: { name: font, family: font, weight, style: 'normal', size }, chars, letters };
        }

        function kindOf(text: string, runs: RawStyleRun[], size: number, bold: boolean): string | undefined {
            const all = items(
                [...FILLERS_BEFORE_HEADING, { text, l: 0, size, bold, font: runs[0].font.name, styleRuns: runs }],
                [BODY],
            );
            return all.find(it => it.text.includes(text.slice(0, 3)))?.type;
        }

        it('keeps a heading whose larger number is its only styled part', () => {
            const runs = [run('Digits', 1, 0, 12), run('Digits', 1, 0, 12), run('Digits', 1, 0, 12), run('SimHei', 16, 16, 10)];
            expect(kindOf('２．２ 明确对党忠诚的科学内涵及判断标准', runs, 12, false)).toBe('header');
        });

        it('keeps a heading whose bold Latin number precedes CJK heading text', () => {
            const runs = [run('Times-Bold', 1, 0, 10, true), run('SimHei', 17, 16, 10)];
            expect(kindOf('5．突出质量导向，实现教学评价一体化', runs, 10, true)).toBe('header');
        });

        it('keeps a heading whose bold ASCII number precedes Latin and CJK text', () => {
            const runs = [run('Times-Bold', 2, 0, 10, true), run('Times-Roman', 4, 4, 10), run('SimSun', 5, 5, 10)];
            expect(kindOf('2. VOCs 挥发性有机物', runs, 10, true)).toBe('header');
        });

        it('does not keep a numbered CJK footnote set smaller than the body', () => {
            const runs = [run('Times-Bold', 2, 0, 10, true), run('SimSun', 14, 13, 8)];
            expect(kindOf('3. 这是一个较长的脚注内容说明来源', runs, 10, true)).toBe('paragraph');
        });

        it('does not keep numbered CJK prose ending in a quoted sentence', () => {
            const runs = [run('Times-Bold', 2, 0, 10, true), run('SimSun', 27, 23, 10)];
            expect(kindOf('2. 研究表明，这一结果可以解释为“社会环境影响个体行为。”', runs, 10, true)).toBe('paragraph');
        });

        it('does not keep a numbered Latin line', () => {
            const runs = [run('Times-Bold', 2, 0, 10, true), run('Times-Roman', 30, 30, 10)];
            expect(kindOf('2. Promote open discussion about the topic', runs, 10, true)).toBe('paragraph');
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

    });

    // Bare font-difference is deliberately NOT a heading signal. A same-size,
    // different-font, heading-cased line with no bold / italic / all-caps /
    // section-number cue is promoted by Rules 1-6 only with that extra cue. On
    // real documents the bare difference fires throughout figure axis labels,
    // equation lead-ins, table headers, and author bylines (all set in a
    // distinct face at body size), so it is left as body text. Missing such a
    // heading is preferred to mislabelling body/figure/table text.
    // A section heading set directly over a subsection heading in the same
    // face ("RESULTS" / "Summary Statistics"): the paragraph-sized gap
    // between them makes two headings, while a heading wrapped over two
    // lines keeps its own (small) leading and stays one.
    describe('stacked headings in one style', () => {
        const SECTION_FACE = { size: 10, font: 'SerifGothic-Bold', bold: true };
        const BODY_AFTER: LeaderLineSpec[] = FILLERS.slice(0, 3);
        const ISOLATED: ParagraphDetectionSettings = { isolatedHeadings: true };

        it('keeps stacked same-style headings as one heading without isolatedHeadings (PDF schema 4)', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'RESULTS', l: 0, ...SECTION_FACE, gapAfter: 14 },
                    { text: 'Summary Statistics', l: 0, ...SECTION_FACE, gapAfter: 8 },
                    ...BODY_AFTER,
                ],
                [BODY],
            );
            const headers = all.filter(it => it.type === 'header').map(it => it.text.trim());
            expect(headers).toEqual(['## RESULTS Summary Statistics']);
        });

        it('splits two same-style headings separated by a paragraph gap', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'RESULTS', l: 0, ...SECTION_FACE, gapAfter: 14 },
                    { text: 'Summary Statistics', l: 0, ...SECTION_FACE, gapAfter: 8 },
                    ...BODY_AFTER,
                ],
                [BODY],
                ISOLATED,
            );
            const headers = all.filter(it => it.type === 'header').map(it => it.text.trim());
            expect(headers).toEqual(['## RESULTS', '## Summary Statistics']);
        });

        it('keeps a heading wrapped at normal leading as one heading', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'School Resource Officers and', l: 0, ...SECTION_FACE },
                    { text: 'School Discipline in Texas', l: 0, ...SECTION_FACE, gapAfter: 8 },
                    ...BODY_AFTER,
                ],
                [BODY],
                ISOLATED,
            );
            const headers = all.filter(it => it.type === 'header').map(it => it.text.trim());
            expect(headers).toEqual(['## School Resource Officers and School Discipline in Texas']);
        });

        it('keeps a loosely leaded display title as one heading', () => {
            // 16pt title lines 6pt apart: more than the body's paragraph-gap
            // threshold, but well under the title's own line height.
            const title = { size: 16, font: 'SerifGothic-Bold', bold: true };
            const all = items(
                [
                    { text: 'Patrolling Public Schools: The', l: 0, ...title, gapAfter: 6 },
                    { text: 'Impact of Funding for School', l: 0, ...title, gapAfter: 6 },
                    { text: 'Police on Student Discipline', l: 0, ...title, gapAfter: 14 },
                    ...FILLERS,
                ],
                [BODY],
                ISOLATED,
            );
            const headers = all.filter(it => it.type === 'header').map(it => it.text.trim());
            expect(headers).toEqual([
                '## Patrolling Public Schools: The Impact of Funding for School Police on Student Discipline',
            ]);
        });

        it.each([
            ['the next line opens in lowercase', 'Academic and Wellness Outcomes Associated', 'with Use of Anki in Medical School'],
            ['the first line ends on a function word', 'A Systematic Review of Social Media Use to', 'Discuss and View Self-Harm Acts'],
            ['the first line ends on joining punctuation', 'Massage and Cancer:', 'Practice Guidelines'],
            ['the first line runs to the column edge', 'Filler body line number 9 that anchors the column left edge.', 'Practice Guidelines'],
        ])('keeps a loosely leaded heading together when %s', (_, first, second) => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: first, l: 0, ...SECTION_FACE, gapAfter: 14 },
                    { text: second, l: 0, ...SECTION_FACE, gapAfter: 14 },
                    ...BODY_AFTER,
                ],
                [BODY],
                ISOLATED,
            );
            const headers = all.filter(it => it.type === 'header').map(it => it.text.trim());
            expect(headers).toEqual([`## ${first} ${second}`]);
        });

        it('splits stacked headings when the first ends in a label letter', () => {
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING,
                    { text: 'APPENDIX A', l: 0, ...SECTION_FACE, gapAfter: 14 },
                    { text: 'Data Timeline', l: 0, ...SECTION_FACE, gapAfter: 8 },
                    ...BODY_AFTER,
                ],
                [BODY],
                ISOLATED,
            );
            const headers = all.filter(it => it.type === 'header').map(it => it.text.trim());
            expect(headers).toEqual(['## APPENDIX A', '## Data Timeline']);
        });

        it('does not split a run of lines in the heading face into one heading per line', () => {
            // Bold list items spaced like headings: a run longer than an
            // isolated heading stays one item, as it was.
            const list = ['Convenient online submission', 'Thorough peer review', 'No space constraints',
                'Immediate publication on acceptance'].map(
                (text, i, all): LeaderLineSpec => ({ text, l: 0, ...SECTION_FACE, gapAfter: i === all.length - 1 ? 8 : 14 }),
            );
            const all = items([...FILLERS_BEFORE_HEADING, ...list, ...BODY_AFTER], [BODY], ISOLATED);
            expect(all.filter(it => it.type === 'header').length).toBeLessThanOrEqual(1);
        });

        it('does not split a loosely leaded block set in a heading face into lines', () => {
            // A block of short lines in the heading face, in a column piece of
            // its own beside tightly leaded body text: a run of heading-styled
            // lines, whose gaps are its own leading, not section spacing.
            const block = makeColumnPageResult(
                ['Convenient online submission', 'Thorough peer review', 'No space constraints',
                    'Immediate publication on acceptance', 'Inclusion in indexing services'].map(
                    (text): LeaderLineSpec => ({ text, l: 0, ...SECTION_FACE, bboxHeight: 9, gapAfter: 7 }),
                ),
            ).columnResults[0];
            const body = makeColumnPageResult(FILLERS).columnResults[0];
            const page: PageLineResult = {
                pageIndex: 0,
                width: 612,
                height: 792,
                columnResults: [body, { ...block, columnIndex: 1 }],
                allLines: [...body.lines, ...block.lines],
            };
            const headers = detectParagraphs(page, [BODY], ISOLATED).items.filter(it => it.type === 'header');
            expect(headers.length).toBeLessThanOrEqual(1);
        });

        it('keeps a title apart from the author line below it in a short front-matter piece', () => {
            // Title, authors and affiliations in a column piece of their own,
            // spaced as on a real cover page. The gap under the title is
            // section spacing, but the piece's median gap is leading, so the
            // piece keeps its own threshold and the title stays a heading.
            // (Taking the page's lower threshold here lets the uniform-leading
            // protection read the title gap as leading, and the two lines'
            // equally tall boxes give no size break.)
            const piece = makeColumnPageResult([
                { text: 'Natural course of posterior subcapsular cataract over a short time', l: 0, r: 470, size: 14, font: 'Title-Sans', bboxHeight: 10, gapAfter: 11.3 },
                { text: 'Thomas Neumayer, Nino Hirnschall, Michael Georgopoulos and Oliver Findl', l: 0, r: 400, size: 10, font: 'Author-Serif', bboxHeight: 10, gapAfter: 8.8 },
                { text: 'Vienna Institute for Research in Ocular Surgery, A Karl Landsteiner Institute, Hanusch', l: 0, r: 500, size: 10, font: 'Times-Roman', gapAfter: 1.5 },
                { text: 'Ophthalmology, Medical University of Vienna, Vienna, Austria', l: 0, r: 300, size: 10, font: 'Times-Roman' },
            ]).columnResults[0];
            const body = makeColumnPageResult(FILLERS).columnResults[0];
            const offset = piece.column.y + piece.column.h + 20;
            const bodyLines = body.lines.map(line => ({
                ...line,
                bbox: { ...line.bbox, t: line.bbox.t + offset, b: line.bbox.b + offset },
            }));
            const page: PageLineResult = {
                pageIndex: 0,
                width: 612,
                height: 792,
                columnResults: [piece, { ...body, columnIndex: 1, lines: bodyLines }],
                allLines: [...piece.lines, ...bodyLines],
            };
            const headers = detectParagraphs(page, [BODY], ISOLATED).items
                .filter(it => it.type === 'header')
                .map(it => it.text.trim());
            expect(headers).toEqual(['## Natural course of posterior subcapsular cataract over a short time']);
        });

        it('keeps body lines together in a short piece holding a caption, a heading and a paragraph', () => {
            // The gaps left once the heading's are set aside mix the caption's
            // tight leading with the body's; the piece takes the page's
            // threshold instead of their median.
            const piece = makeColumnPageResult([
                { text: 'Figure 11. Mean number of cloud-free observations per tile in the', l: 0, r: 480, size: 9, font: 'Times-Bold', bold: true, gapAfter: -1 },
                { text: 'corresponding mosaics, computed over the Planet NICFI tiles. Only', l: 0, r: 480, size: 9, font: 'Times-Roman', gapAfter: 1 },
                { text: 'pixels greater than zero were considered in the computation.', l: 0, r: 300, size: 9, font: 'Times-Roman', gapAfter: 27 },
                { text: '3.9. Amazon forest canopy height', l: 0, r: 200, ...SECTION_FACE, gapAfter: 13 },
                { text: 'We found that the mean canopy height of the Amazon forest was 22.09 m, with', l: 0, r: 480, size: 10, font: 'Times-Roman', gapAfter: 5.3 },
                { text: 'a median of 22.25 m and a 97.5th percentile of 32.10 m (Table 1).', l: 0, r: 330, size: 10, font: 'Times-Roman' },
            ]).columnResults[0];
            const body = makeColumnPageResult(
                FILLERS.map((f): LeaderLineSpec => ({ ...f, gapAfter: 5.3 })),
            ).columnResults[0];
            const offset = piece.column.y + piece.column.h + 20;
            const bodyLines = body.lines.map(line => ({
                ...line,
                bbox: { ...line.bbox, t: line.bbox.t + offset, b: line.bbox.b + offset },
            }));
            const page: PageLineResult = {
                pageIndex: 0,
                width: 612,
                height: 792,
                columnResults: [piece, { ...body, columnIndex: 1, lines: bodyLines }],
                allLines: [...piece.lines, ...bodyLines],
            };
            const texts = detectParagraphs(page, [BODY], ISOLATED).items.map(it => it.text.trim());
            expect(texts).toContain(
                'We found that the mean canopy height of the Amazon forest was 22.09 m, with a median of 22.25 m and a 97.5th percentile of 32.10 m (Table 1).',
            );
        });

        it('never raises a short piece threshold to a looser page leading', () => {
            // The piece's median gap borders the heading, but the page's
            // double-spaced body sets a higher threshold than the piece's own:
            // section gaps only inflate a median, so the lower value stands.
            const piece = makeColumnPageResult([
                { text: 'In conclusion, our results suggest that the interventions have a lasting', l: 0, r: 480, size: 10, font: 'Times-Roman', gapAfter: 2 },
                { text: 'effect on the outcomes we measured.', l: 0, r: 200, size: 10, font: 'Times-Roman', gapAfter: 11 },
                { text: 'Conclusions', l: 0, ...SECTION_FACE, gapAfter: 8 },
                { text: 'Taken together, these findings extend earlier work on the topic.', l: 0, r: 400, size: 10, font: 'Times-Roman' },
            ]).columnResults[0];
            const body = makeColumnPageResult(
                FILLERS.map((f): LeaderLineSpec => ({ ...f, gapAfter: 12 })),
            ).columnResults[0];
            const offset = piece.column.y + piece.column.h + 20;
            const bodyLines = body.lines.map(line => ({
                ...line,
                bbox: { ...line.bbox, t: line.bbox.t + offset, b: line.bbox.b + offset },
            }));
            const page: PageLineResult = {
                pageIndex: 0,
                width: 612,
                height: 792,
                columnResults: [piece, { ...body, columnIndex: 1, lines: bodyLines }],
                allLines: [...piece.lines, ...bodyLines],
            };
            const headers = detectParagraphs(page, [BODY], ISOLATED).items
                .filter(it => it.type === 'header')
                .map(it => it.text.trim());
            expect(headers).toEqual(['## Conclusions']);
        });

        it('finds stacked headings in a short column piece cut off above the body', () => {
            // The column detector can cut a single-column page at its
            // headings, leaving a piece with a paragraph's last lines and two
            // stacked headings. Their gaps are section spacing; they must not
            // set the piece's own paragraph-gap threshold.
            const piece = makeColumnPageResult([
                { text: 'types partially account for interest in alternate security aims, such as', l: 0, size: 10, font: 'Times-Roman' },
                { text: 'security equipment and technology.', l: 0, r: 180, size: 10, font: 'Times-Roman', gapAfter: 16 },
                { text: 'RESULTS', l: 0, ...SECTION_FACE, gapAfter: 14 },
                { text: 'Summary Statistics', l: 0, ...SECTION_FACE },
            ]).columnResults[0];
            const body = makeColumnPageResult(FILLERS).columnResults[0];
            const offset = piece.column.y + piece.column.h + 8;
            const bodyLines = body.lines.map(line => ({
                ...line,
                bbox: { ...line.bbox, t: line.bbox.t + offset, b: line.bbox.b + offset },
            }));
            const page: PageLineResult = {
                pageIndex: 0,
                width: 612,
                height: 792,
                columnResults: [piece, { ...body, columnIndex: 1, lines: bodyLines }],
                allLines: [...piece.lines, ...bodyLines],
            };
            const headers = detectParagraphs(page, [BODY], ISOLATED).items
                .filter(it => it.type === 'header')
                .map(it => it.text.trim());
            expect(headers).toEqual(['## RESULTS', '## Summary Statistics']);
        });
    });

    describe('bare font-difference is not a heading signal', () => {
        it('does NOT promote a Regular-weight, different-family line with no other cue', () => {
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

    // Subset-tag-insensitive body matching. PDF producers split one logical
    // font into several embedded subsets, each with a random six-letter tag
    // (`WHFMUD+CMR12`, `FSAPEC+CMR12`). A body-font subset used in an appendix
    // or figure must be treated as body, not as a heading candidate.
    describe('subset-tag-insensitive body matching', () => {
        it('treats a body-font alternate subset as body text', () => {
            const SUBSET_BODY = bodyStyle(10, 'WHFMUD+CMR12');
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING.map(f => ({ ...f, font: 'WHFMUD+CMR12' })),
                    { text: 'Consider an establishment that allocates tasks', l: 0, size: 10, font: 'FSAPEC+CMR12' },
                ],
                [SUBSET_BODY],
            );
            const item = all.find(it => it.text.includes('Consider an establishment'));
            expect(item).toBeDefined();
            expect(item!.type).toBe('paragraph');
        });

        it('still promotes an all-caps title in a genuinely different base font', () => {
            // A real heading face has a different base name (tag stripped), so
            // subset-insensitive matching does not swallow it: the all-caps
            // title in a distinct face is still a heading (Rule 5).
            const SUBSET_BODY = bodyStyle(10, 'WHFMUD+CMR12');
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING.map(f => ({ ...f, font: 'WHFMUD+CMR12' })),
                    { text: 'RESEARCH APPROACH', l: 0, size: 10, font: 'AABBCC+Helvetica' },
                ],
                [SUBSET_BODY],
            );
            const heading = all.find(it => it.text.includes('RESEARCH APPROACH'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });
    });

    // All-caps headings with no usable font cue (Tier 1). On PDFs whose
    // embedded fonts MuPDF cannot resolve, every line reports the same font
    // (e.g. "unknown") at the same size with no bold flag, so the
    // font-difference rules can never fire. The all-caps multi-word phrase is
    // then the only heading signal.
    describe('all-caps headings without a font cue', () => {
        it('promotes an all-caps title sharing the body font and size', () => {
            // Heading and body are the same (unresolved) font, same size, no
            // bold flag — only the all-caps shape distinguishes the title.
            const UNKNOWN_BODY = bodyStyle(10, 'unknown');
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING.map(f => ({ ...f, font: 'unknown' })),
                    { text: 'RESEARCH APPROACH', l: 0, size: 10, font: 'unknown' },
                ],
                [UNKNOWN_BODY],
            );
            const heading = all.find(it => it.text.includes('RESEARCH APPROACH'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });

        it('does NOT promote a title-cased line sharing the body font', () => {
            // Without the all-caps cue and without a font difference there is
            // no signal, so a title-cased subheading in an unresolved font
            // stays body — the limit of what is recoverable here.
            const UNKNOWN_BODY = bodyStyle(10, 'unknown');
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING.map(f => ({ ...f, font: 'unknown' })),
                    { text: 'Time Perception', l: 0, size: 10, font: 'unknown' },
                ],
                [UNKNOWN_BODY],
            );
            const item = all.find(it => it.text.includes('Time Perception'));
            expect(item).toBeDefined();
            expect(item!.type).toBe('paragraph');
        });

        it('promotes an all-caps section-letter heading (single enumerator)', () => {
            // A lone section letter ("APPENDIX A. METHODS") must not be mistaken
            // for an author initial — it is a legitimate all-caps heading even
            // though its font is indistinct from body.
            const UNKNOWN_BODY = bodyStyle(10, 'unknown');
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING.map(f => ({ ...f, font: 'unknown' })),
                    { text: 'APPENDIX A. METHODS', l: 0, size: 10, font: 'unknown' },
                ],
                [UNKNOWN_BODY],
            );
            const heading = all.find(it => it.text.includes('APPENDIX A. METHODS'));
            expect(heading).toBeDefined();
            expect(heading!.type).toBe('header');
        });

        it('does NOT promote an all-caps author list (two or more initials)', () => {
            // Multiple stacked initials mark an author byline / reference entry,
            // not a section title.
            const UNKNOWN_BODY = bodyStyle(10, 'unknown');
            const all = items(
                [
                    ...FILLERS_BEFORE_HEADING.map(f => ({ ...f, font: 'unknown' })),
                    { text: 'STOLLE, D., S. SOROKA, AND R. JOHNSTON', l: 0, size: 10, font: 'unknown' },
                ],
                [UNKNOWN_BODY],
            );
            const item = all.find(it => it.text.includes('STOLLE'));
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

// ---------------------------------------------------------------------------
// Font-expansion size jitter
//
// LaTeX `microtype` scales each line's glyphs by up to about 2%, so 10pt
// body lines report truncated sizes of 9 (9.96pt) or 10 (10.04pt) at random.
// The exact sizes in the style runs show they are one size.
// ---------------------------------------------------------------------------
describe('font-expansion size jitter', () => {
    const BODY9 = bodyStyle(9, 'Times-Roman');

    function run(
        font: string,
        chars: number,
        exactSize: number,
        opts: { size?: number; italic?: boolean } = {},
    ): RawStyleRun {
        return {
            font: {
                name: font,
                family: font,
                weight: 'normal',
                style: opts.italic ? 'italic' : 'normal',
                size: opts.size ?? Math.trunc(exactSize),
            },
            exactSize,
            chars,
            letters: chars,
        };
    }

    // A paragraph whose lines alternate between the two truncated sizes.
    const JITTERED_BODY: LeaderLineSpec[] = Array.from({ length: 6 }, (_, i) => {
        const exact = i % 2 === 0 ? 9.96 : 10.04;
        return {
            text: `Body line number ${i + 1} of a paragraph that runs on across the`,
            l: 0,
            r: 305,
            size: Math.trunc(exact),
            bboxHeight: 12,
            font: 'Times-Roman',
            styleRuns: [run('Times-Roman', 55, exact)],
        };
    });

    function items(specs: LeaderLineSpec[]) {
        return detectParagraphs(makeColumnPageResult(specs), [BODY9]).items;
    }

    it('does not read an italic line expanded past the next point as a larger heading', () => {
        const all = items([
            ...JITTERED_BODY,
            {
                text: 'Proficient in English, More Educated Than a Decade Ago. Report.',
                l: 0,
                r: 305,
                size: 10,
                bboxHeight: 12,
                italic: true,
                font: 'Times-Italic',
                styleRuns: [
                    run('Times-Italic', 46, 10.04, { italic: true }),
                    run('Times-Roman', 8, 10.04),
                ],
            },
            {
                text: 'Washington, DC: Pew Research Center.',
                l: 0,
                size: 9,
                bboxHeight: 12,
                font: 'Times-Roman',
                styleRuns: [run('Times-Roman', 31, 9.96)],
            },
        ]);
        expect(all).toHaveLength(1);
        expect(all[0].type).toBe('paragraph');
    });

    it('keeps a wrapped italic statement together when its lines land on either side of a point', () => {
        const all = items([
            ...JITTERED_BODY,
            {
                text: 'if the Laplacian maximum eigenvalues of the non-regular',
                l: 0,
                r: 305,
                size: 10,
                bboxHeight: 12,
                italic: true,
                font: 'Times-Italic',
                styleRuns: [run('Times-Italic', 48, 10.06, { italic: true })],
            },
            {
                text: 'graphs to be compared are not the same. Otherwise it is not.',
                l: 0,
                size: 9,
                bboxHeight: 12,
                italic: true,
                font: 'Times-Italic',
                styleRuns: [run('Times-Italic', 48, 9.86, { italic: true })],
            },
        ]);
        const statement = all.find(it => it.text.includes('if the Laplacian'));
        expect(statement?.text).toContain('graphs to be compared');
    });

    it('still reads a line set a full point larger as a heading', () => {
        const all = items([
            ...JITTERED_BODY,
            {
                text: 'Results',
                l: 0,
                size: 11,
                bboxHeight: 13,
                font: 'Times-Roman',
                styleRuns: [run('Times-Roman', 7, 11.0)],
            },
            {
                text: 'Washington, DC: Pew Research Center.',
                l: 0,
                size: 9,
                bboxHeight: 12,
                font: 'Times-Roman',
                styleRuns: [run('Times-Roman', 31, 9.96)],
            },
        ]);
        expect(all.find(it => it.text.includes('Results'))?.type).toBe('header');
    });
});

// ---------------------------------------------------------------------------
// Numbered entries
// ---------------------------------------------------------------------------
describe('consecutive numbered entries', () => {
    // Part of the hanging-block reading, so enabled with it.
    const texts = (result: PageLineResult, hangingIndentBlocks = true) =>
        detectParagraphs(result, [BODY], { hangingIndentBlocks }).items
            .filter(it => it.type === 'paragraph')
            .map(it => it.text.trim());

    it('starts a new entry at the next number even when the previous entry fills its line', () => {
        const result = makeColumnPageResult([
            ...FILLERS,
            { text: '46. Goadsby, P. J. & Edvinsson, L. Human in vivo evidence for the', l: 0, r: 305 },
            { text: 'trigeminovascular system. Brain 117, 427–434 (1994).', l: 12, r: 250 },
            { text: '47. Lang, J. Clinical Anatomy of the Head Neurocranium and Orbit.', l: 0, r: 305 },
            { text: '48. Holton, P. Antidromic vasodilatation in the isolated perfused ear.', l: 0, r: 305 },
            { text: '49. Jancso, G. Neurogenic Inflammation in Health and Disease (2008).', l: 0, r: 300 },
        ]);
        const paragraphs = texts(result);
        for (const n of ['46.', '47.', '48.', '49.']) {
            expect(paragraphs.filter(p => p.includes(`${n} `))).toHaveLength(1);
        }
        expect(paragraphs.find(p => p.startsWith('47.'))).not.toContain('48.');
        expect(paragraphs.find(p => p.startsWith('48.'))).not.toContain('49.');
        expect(texts(result, false).find(p => p.includes('47.'))).toContain('48.');
    });

    it('does not split a line that opens with any other number', () => {
        const result = makeColumnPageResult([
            ...FILLERS,
            { text: '47. Lang, J. Clinical Anatomy of the Head Neurocranium and Orbit,', l: 0, r: 305 },
            { text: '12. Auflage. Springer, Berlin and Heidelberg and New York (1983).', l: 0, r: 305 },
        ]);
        expect(texts(result).find(p => p.includes('47.'))).toContain('12. Auflage');
    });
});
