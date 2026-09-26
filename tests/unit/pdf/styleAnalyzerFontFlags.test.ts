/**
 * `resolveFontFlags` decides bold/italic from a font name plus the weight
 * and style MuPDF reports. It feeds both the document style profile (via
 * `extractStyle`) and the span-level typography features, so the two must
 * keep agreeing; this pins the rules they share.
 */
import { describe, expect, it } from 'vitest';

import { extractStyle, resolveFontFlags } from '../../../src/beaver-extract/StyleAnalyzer';
import type { RawLine } from '@beaver/agent-core/extract/types';

describe('resolveFontFlags', () => {
    it.each([
        // [fontName, weight, style, bold, italic]
        ['Times-Roman', undefined, undefined, false, false],
        ['Times-Roman', 'bold', undefined, true, false],
        ['Times-Roman', undefined, 'italic', false, true],
        ['Helvetica-Bold', undefined, undefined, true, false],
        ['Helvetica-BoldOblique', undefined, undefined, true, true],
        ['Arial Black', undefined, undefined, true, false],
        ['Roboto-Heavy', undefined, undefined, true, false],
        ['Minion-Italic', undefined, undefined, false, true],
        ['ABCDEF+NimbusRomNo9L.B', undefined, undefined, true, false],
        ['ABCDEF+NimbusRomNo9L.Bd', undefined, undefined, true, false],
        ['ABCDEF+NimbusRomNo9L.I', undefined, undefined, false, true],
        ['ABCDEF+NimbusRomNo9L.Obl', undefined, undefined, false, true],
        ['ABCDEF+NimbusRomNo9L.BI', undefined, undefined, true, true],
        ['ABCDEF+NimbusRomNo9L.IB', undefined, undefined, true, true],
        // The suffix rule is anchored: an interior ".B" does not count.
        ['Foo.Bar-Regular', undefined, undefined, false, false],
        ['unknown', undefined, undefined, false, false],
    ] as const)('%s / %s / %s → bold=%s italic=%s', (fontName, weight, style, bold, italic) => {
        expect(resolveFontFlags(fontName, weight, style)).toEqual({ bold, italic });
    });

    it('is the rule extractStyle applies to a raw line', () => {
        const line = {
            text: 'x',
            bbox: { l: 0, t: 0, r: 10, b: 10, origin: 'top-left' },
            font: { name: 'Helvetica-BoldOblique', size: 9.6, weight: 'normal', style: 'normal' },
        } as unknown as RawLine;
        expect(extractStyle(line)).toEqual({
            size: 10,
            font: 'Helvetica-BoldOblique',
            bold: true,
            italic: true,
        });
        expect(extractStyle({ text: 'x', bbox: line.bbox } as unknown as RawLine)).toEqual({
            size: 12,
            font: 'unknown',
            bold: false,
            italic: false,
        });
    });
});
