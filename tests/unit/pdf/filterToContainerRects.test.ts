/**
 * Unit tests for `filterToContainerRects` — the worker-side filter that
 * keeps only `FillRect` events suitable for use as
 * column-detection zone boundaries (tinted aside boxes, callouts,
 * sidebars).
 *
 * The filter sits between `Page.collectFilledRects()` (raw fz_device
 * events) and `ColumnDetector` (which consumes plain bboxes). Catching
 * the wrong fill (page background, glyph paths, hairline rules) would
 * inject spurious zone boundaries and split body text into too many
 * columns; missing a real aside fill leaves the merge guard inactive.
 */
import { describe, it, expect } from 'vitest';
import { filterToContainerRects } from '../../../src/services/pdf/worker/docHelpers';
import type { FillRect } from '../../../src/services/pdf/worker/mupdfApi';

function fill(overrides: Partial<FillRect>): FillRect {
    return {
        bbox: [0, 0, 100, 100],
        color: [0.5],
        colorspaceType: 1, // Gray
        alpha: 1,
        isAxisAlignedRect: true,
        ...overrides,
    };
}

describe('filterToContainerRects', () => {
    const PAGE_W = 612;
    const PAGE_H = 792;

    it('keeps a tinted gray aside-shaped rect', () => {
        const f = fill({ bbox: [100, 100, 400, 300], color: [0.85] }); // light gray
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    });

    it('keeps a tinted RGB callout', () => {
        const f = fill({
            bbox: [50, 50, 300, 200],
            color: [0.95, 0.92, 0.85], // pale yellow
            colorspaceType: 2, // RGB
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(1);
    });

    it('keeps a separation-colorspace fill (motivating DDS69CQI shape)', () => {
        // Separation csType=7 with color=[1.0] is full ink saturation
        // of a plate — visually a tint, not white.
        const f = fill({
            bbox: [58, 73, 471, 270],
            color: [1.0],
            colorspaceType: 7,
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(1);
    });

    it('drops a pure-white gray rect (page background)', () => {
        const f = fill({ bbox: [0, 0, PAGE_W, PAGE_H], color: [1.0] });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('drops a pure-white RGB rect', () => {
        const f = fill({
            bbox: [50, 50, 300, 200],
            color: [1.0, 1.0, 1.0],
            colorspaceType: 2,
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('drops a CMYK "no ink" fill (all components zero)', () => {
        const f = fill({
            bbox: [50, 50, 300, 200],
            color: [0, 0, 0, 0],
            colorspaceType: 4,
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('keeps a CMYK fill with any ink', () => {
        const f = fill({
            bbox: [50, 50, 300, 200],
            color: [0.1, 0, 0, 0],
            colorspaceType: 4,
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(1);
    });

    it('drops a fill that covers ≥ 90 % of the page (page background)', () => {
        const f = fill({
            bbox: [0, 0, PAGE_W * 0.99, PAGE_H * 0.99],
            color: [0.8],
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('drops a tiny fill (icon / underline hairline)', () => {
        // 20×20 = 400pt² < 900pt² minimum.
        const f = fill({ bbox: [100, 100, 120, 120], color: [0.5] });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('drops zero-area degenerate fills (0×0 sentinel events)', () => {
        const f = fill({ bbox: [10, 10, 10, 10] });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('drops non-rect-shaped fills (curves, multi-subpath logos)', () => {
        // Path with curves / extra subpaths is unsafe to use as a zone
        // — its bbox would be much larger than the visible fill.
        const f = fill({
            bbox: [100, 100, 400, 300],
            color: [0.5],
            isAxisAlignedRect: false,
        });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('drops invisible fills (alpha ≤ 0)', () => {
        const f = fill({ bbox: [100, 100, 400, 300], alpha: 0 });
        const out = filterToContainerRects([f], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });

    it('returns multiple container fills when several pass the gates', () => {
        const a = fill({ bbox: [50, 50, 200, 200], color: [0.85] });
        const b = fill({ bbox: [300, 50, 500, 200], color: [0.85] });
        const out = filterToContainerRects([a, b], PAGE_W, PAGE_H);
        expect(out).toHaveLength(2);
    });
});
