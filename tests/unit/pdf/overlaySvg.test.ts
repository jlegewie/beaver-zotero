/**
 * Snapshot-style tests for the overlay SVG composite string.
 *
 * Runs in the unit tier (no PDF / WASM / sharp). Verifies that:
 *   - SVG dimensions match the requested image size
 *   - rect coords scale by image/page ratio
 *   - labels emit both their background rect and the text element
 *   - special XML chars are escaped
 */
import { describe, expect, it } from 'vitest';

import { buildOverlaySvg } from '../../../src/beaver-extract/debug/overlaySvg';
import type { OverlayRect } from '../../../src/beaver-extract/debug/overlayBuilders';
import { bboxFromXYWH } from '../../../src/beaver-extract/types';

describe('buildOverlaySvg', () => {
    it('emits a self-contained SVG with the requested image dimensions', () => {
        const svg = buildOverlaySvg({
            imageWidth: 400,
            imageHeight: 300,
            pageWidth: 200,
            pageHeight: 150,
            rects: [],
        });
        expect(svg.startsWith('<svg ')).toBe(true);
        expect(svg).toContain('width="400"');
        expect(svg).toContain('height="300"');
        expect(svg).toContain('viewBox="0 0 400 300"');
        expect(svg.endsWith('</svg>')).toBe(true);
    });

    it('scales rect coordinates by image/page ratio', () => {
        const rect: OverlayRect = {
            rect: bboxFromXYWH(10, 20, 30, 40, "top-left"),
            color: '#ff2d55',
            group: 0,
        };
        // Image is 2x the page in both dims, so coords double.
        const svg = buildOverlaySvg({
            imageWidth: 400,
            imageHeight: 300,
            pageWidth: 200,
            pageHeight: 150,
            rects: [rect],
        });
        expect(svg).toContain('x="20.00"');
        expect(svg).toContain('y="40.00"');
        expect(svg).toContain('width="60.00"');
        expect(svg).toContain('height="80.00"');
        expect(svg).toContain('stroke="#ff2d55"');
        expect(svg).toContain('stroke-width="1"');
    });

    it('emits a label background rect plus the text element', () => {
        const rect: OverlayRect = {
            rect: bboxFromXYWH(100, 100, 50, 30, "top-left"),
            color: '#34c759',
            label: 'P1',
            group: 0,
        };
        const svg = buildOverlaySvg({
            imageWidth: 200,
            imageHeight: 200,
            pageWidth: 200,
            pageHeight: 200,
            rects: [rect],
        });
        // The text element carries the literal label.
        expect(svg).toContain('>P1</text>');
        expect(svg).toContain('font-family="sans-serif"');
        expect(svg).toContain('font-weight="bold"');
        expect(svg).toContain('fill="#ffffff"');
    });

    it('escapes XML special characters in labels', () => {
        const svg = buildOverlaySvg({
            imageWidth: 100,
            imageHeight: 100,
            pageWidth: 100,
            pageHeight: 100,
            rects: [
                {
                    rect: bboxFromXYWH(0, 0, 10, 10, "top-left"),
                    color: '#000000',
                    label: '<S&1>',
                    group: 0,
                },
            ],
        });
        expect(svg).toContain('&lt;S&amp;1&gt;');
        expect(svg).not.toContain('<S&1>');
    });

    it('falls back to neutral gray when stroke color is malformed', () => {
        const svg = buildOverlaySvg({
            imageWidth: 100,
            imageHeight: 100,
            pageWidth: 100,
            pageHeight: 100,
            rects: [
                {
                    rect: bboxFromXYWH(0, 0, 10, 10, "top-left"),
                    color: 'not-a-hex',
                    group: 0,
                },
            ],
        });
        // hexToRgba returns rgba(128,128,128,0.18) — the stroke stays the
        // raw input string (CSS-tolerant), but the fill MUST be the
        // sanitized rgba.
        expect(svg).toContain('fill="rgba(128,128,128,0.18)"');
    });
});
