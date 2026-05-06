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
import { looksLikeFragmentedCJKBody } from '../../../src/services/pdf/ParagraphDetector';
import type { PageLine, DetectedSpan } from '../../../src/services/pdf/LineDetector';
import type { TextStyle } from '../../../src/services/pdf/types';

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
