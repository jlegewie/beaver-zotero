/**
 * Pixel budget for page rendering.
 *
 * MuPDF sizes the pixmap from the page's own dimensions times the requested
 * scale, so a small file declaring a large-format page can demand a
 * multi-gigabyte buffer at an ordinary DPI. Blowing the WASM heap there takes
 * the host process down (observed in production as an abnormal WebSocket
 * closure mid-render), so the scale is clamped before the pixmap is allocated.
 */
import { describe, it, expect } from 'vitest';

import { renderOnePage, DEFAULT_PAGE_IMAGE_OPTIONS } from '../../../src/beaver-extract/worker/docHelpers';
import { DEFAULT_MAX_RENDER_PIXELS } from '../../../src/beaver-extract/types';
import type { DocumentLike, MuPDFApi, MatrixTuple, RectTuple } from '../../../src/beaver-extract/worker/mupdfApi';

const A4_PT: RectTuple = [0, 0, 595, 842];
/** ~69x69in page — the shape of a scanned large-format plan. */
const LARGE_FORMAT_PT: RectTuple = [0, 0, 5000, 5000];

/** Records the matrix the page was actually asked to render at. */
function fakeRender(bounds: RectTuple) {
    const seen: { matrix: MatrixTuple | null } = { matrix: null };

    const pixmap = {
        // The fake reports the pixmap size the matrix implies, so the assertions
        // below reflect what MuPDF would really have allocated.
        getWidth: () => Math.ceil((bounds[2] - bounds[0]) * (seen.matrix?.[0] ?? 1)),
        getHeight: () => Math.ceil((bounds[3] - bounds[1]) * (seen.matrix?.[3] ?? 1)),
        asPNG: () => new Uint8Array([1]),
        asJPEG: () => new Uint8Array([1]),
        destroy: () => {},
    };

    const page = {
        getBounds: () => bounds,
        toPixmap: (matrix: MatrixTuple) => {
            seen.matrix = matrix;
            return pixmap;
        },
        destroy: () => {},
    };

    const api = {
        Matrix: { scale: (sx: number, sy: number): MatrixTuple => [sx, 0, 0, sy, 0, 0] },
        ColorSpace: { DeviceRGB: {} },
    } as unknown as MuPDFApi;

    const doc = { loadPage: () => page } as unknown as DocumentLike;

    return { api, doc, seen };
}

describe('renderOnePage pixel budget', () => {
    it('renders an ordinary page at the requested dpi', () => {
        const { api, doc } = fakeRender(A4_PT);

        const result = renderOnePage(api, doc, 0, {
            ...DEFAULT_PAGE_IMAGE_OPTIONS,
            dpi: 150,
        });

        // A4 at 150 dpi is ~2.1 Mpx — far under budget, so nothing is clamped.
        expect(result.dpi).toBe(150);
        expect(result.width * result.height).toBeLessThan(DEFAULT_MAX_RENDER_PIXELS);
    });

    it('clamps a large-format page to the pixel budget instead of allocating it', () => {
        const { api, doc } = fakeRender(LARGE_FORMAT_PT);

        const result = renderOnePage(api, doc, 0, {
            ...DEFAULT_PAGE_IMAGE_OPTIONS,
            dpi: 150,
        });

        // Unclamped this is 5000/72*150 squared ≈ 108 Mpx (~325 MB pixmap).
        expect(result.width * result.height).toBeLessThanOrEqual(DEFAULT_MAX_RENDER_PIXELS);
        // The page still renders — at a reduced dpi, which is reported back.
        expect(result.dpi).toBeLessThan(150);
        expect(result.dpi).toBeGreaterThan(0);
        expect(result.data.length).toBeGreaterThan(0);
    });

    it('keeps the aspect ratio when clamping', () => {
        const { api, doc } = fakeRender([0, 0, 8000, 2000]);

        const result = renderOnePage(api, doc, 0, {
            ...DEFAULT_PAGE_IMAGE_OPTIONS,
            dpi: 150,
        });

        expect(result.width * result.height).toBeLessThanOrEqual(DEFAULT_MAX_RENDER_PIXELS);
        expect(result.width / result.height).toBeCloseTo(4, 1);
    });

    it('honours maxPixels: 0 as "no budget"', () => {
        const { api, doc } = fakeRender(LARGE_FORMAT_PT);

        const result = renderOnePage(api, doc, 0, {
            ...DEFAULT_PAGE_IMAGE_OPTIONS,
            dpi: 150,
            maxPixels: 0,
        });

        expect(result.dpi).toBe(150);
        expect(result.width * result.height).toBeGreaterThan(DEFAULT_MAX_RENDER_PIXELS);
    });

    it('leaves degenerate bounds to MuPDF rather than clamping them', () => {
        const { api, doc } = fakeRender([0, 0, 0, 0]);

        const result = renderOnePage(api, doc, 0, {
            ...DEFAULT_PAGE_IMAGE_OPTIONS,
            dpi: 150,
        });

        expect(result.dpi).toBe(150);
    });

    // The budget is derived from the page area, never from the pixel count at
    // the requested scale — that product overflows to Infinity for an extreme
    // dpi, and a guard that bailed out on a non-finite count would disable
    // itself exactly on the inputs most likely to take the host process down.
    it.each([
        ['a dpi whose pixel count overflows to Infinity', { dpi: 1e200 }],
        ['an infinite dpi', { dpi: Number.POSITIVE_INFINITY }],
        ['an overflowing scale', { scale: Number.MAX_VALUE }],
        ['an infinite scale', { scale: Number.POSITIVE_INFINITY }],
    ])('still enforces the cap for %s', (_label, override) => {
        const { api, doc, seen } = fakeRender(A4_PT);

        const result = renderOnePage(api, doc, 0, {
            ...DEFAULT_PAGE_IMAGE_OPTIONS,
            dpi: 0, // let each case pick dpi or scale
            ...override,
        });

        expect(result.width * result.height).toBeLessThanOrEqual(DEFAULT_MAX_RENDER_PIXELS);
        // The matrix handed to MuPDF must be finite, not an enormous one.
        expect(Number.isFinite(seen.matrix?.[0] ?? NaN)).toBe(true);
        expect(result.dpi).toBeLessThan(1e200);
        expect(result.dpi).toBeGreaterThan(0);
    });
});
