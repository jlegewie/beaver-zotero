/**
 * First sharp install / runtime check. Run this EARLY in development so
 * platform pain (libvips on Apple Silicon, missing libraries on CI)
 * surfaces before anything else.
 *
 * Builds a tiny synthetic PNG via sharp itself, paints two rects on it
 * via the Node overlay function, and asserts non-empty PNG output. No
 * real PDF needed.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { drawBBoxOverlayPNGNode } from '../../src/beaver-extract/node/overlayPng';
import type { OverlayRect } from '../../src/beaver-extract/debug/overlayBuilders';
import { bboxFromXYWH } from '../../src/beaver-extract/types';

async function makeBlankPng(width: number, height: number): Promise<Uint8Array> {
    const buf = await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
        },
    })
        .png()
        .toBuffer();
    return new Uint8Array(buf);
}

describe('drawBBoxOverlayPNGNode (smoke)', () => {
    it('composites rects onto a synthetic PNG via sharp', async () => {
        const png = await makeBlankPng(200, 100);
        const rects: OverlayRect[] = [
            {
                rect: bboxFromXYWH(10, 10, 50, 20, 'top-left'),
                color: '#ff2d55',
                label: 'A',
                group: 0,
            },
            {
                rect: bboxFromXYWH(80, 40, 60, 30, 'top-left'),
                color: '#00bbff',
                label: 'B',
                group: 1,
            },
        ];

        // Image space matches page space here (1:1), so the rects render at
        // their literal coordinates.
        const out = await drawBBoxOverlayPNGNode(png, 200, 100, 200, 100, rects);

        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.byteLength).toBeGreaterThan(100);
        // PNG signature bytes
        expect(Array.from(out.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

        // Round-trip the output through sharp to confirm it's a real PNG of
        // the expected dims, not just bytes that happen to start with PNG.
        const meta = await sharp(Buffer.from(out)).metadata();
        expect(meta.format).toBe('png');
        expect(meta.width).toBe(200);
        expect(meta.height).toBe(100);
    });
});
