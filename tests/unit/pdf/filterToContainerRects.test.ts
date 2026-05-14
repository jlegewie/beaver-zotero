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
import { describe, it, expect, vi } from 'vitest';
import {
    extractFilledRectsFromDoc,
    extractGraphicsFromDoc,
    filterToDividerLines,
    filterToContainerRects,
} from '../../../src/beaver-extract/worker/docHelpers';
import {
    DEFAULT_MAX_FILL_RECTS,
    type DocumentLike,
    type DividerLine,
    type FillRect,
    isAxisAlignedRectanglePath,
    isAxisAlignedLineSegment,
    lineSegmentToTopLeftFrame,
    type PageLike,
} from '../../../src/beaver-extract/worker/mupdfApi';

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

function stroke(overrides: Partial<DividerLine>): DividerLine {
    return {
        a: [0, 100],
        b: [612, 100],
        thickness: 1,
        orientation: 'horizontal',
        color: [0],
        colorspaceType: 1,
        alpha: 1,
        ...overrides,
    };
}

describe('isAxisAlignedRectanglePath', () => {
    const identity = [1, 0, 0, 1, 0, 0] as const;

    it('accepts a four-corner axis-aligned rectangle path', () => {
        const out = isAxisAlignedRectanglePath([
            ['M', 0, 0],
            ['L', 100, 0],
            ['L', 100, 50],
            ['L', 0, 50],
            ['Z'],
        ], identity);

        expect(out).toBe(true);
    });

    it('rejects a closed triangle that repeats the start point', () => {
        const out = isAxisAlignedRectanglePath([
            ['M', 0, 0],
            ['L', 100, 0],
            ['L', 100, 100],
            ['L', 0, 0],
            ['Z'],
        ], identity);

        expect(out).toBe(false);
    });

    it('rejects four bbox corners visited in diagonal order', () => {
        const out = isAxisAlignedRectanglePath([
            ['M', 0, 0],
            ['L', 100, 100],
            ['L', 100, 0],
            ['L', 0, 100],
            ['Z'],
        ], identity);

        expect(out).toBe(false);
    });

    it('rejects a rectangle rotated off the page axes by the CTM', () => {
        const out = isAxisAlignedRectanglePath([
            ['M', 0, 0],
            ['L', 100, 0],
            ['L', 100, 50],
            ['L', 0, 50],
            ['Z'],
        ], [0.7071, 0.7071, -0.7071, 0.7071, 0, 0]);

        expect(out).toBe(false);
    });
});

describe('isAxisAlignedLineSegment', () => {
    const identity = [1, 0, 0, 1, 0, 0] as const;

    it('accepts a horizontal move-line path after CTM transform', () => {
        const out = isAxisAlignedLineSegment([
            ['M', 10, 20],
            ['L', 200, 20],
        ], identity);
        expect(out).toEqual({
            orientation: 'horizontal',
            a: [10, 20],
            b: [200, 20],
        });
    });

    it('accepts a vertical move-line path after CTM transform', () => {
        const out = isAxisAlignedLineSegment([
            ['M', 10, 20],
            ['L', 10, 200],
        ], identity);
        expect(out?.orientation).toBe('vertical');
    });

    it('rejects skew line segments', () => {
        const out = isAxisAlignedLineSegment([
            ['M', 10, 20],
            ['L', 200, 30],
        ], identity);
        expect(out).toBeNull();
    });
});

describe('lineSegmentToTopLeftFrame', () => {
    it('flips MuPDF y-up stroke endpoints into the extractor top-left frame', () => {
        const out = lineSegmentToTopLeftFrame({
            orientation: 'horizontal',
            a: [20, 692],
            b: [590, 692],
        }, 792);

        expect(out).toEqual({
            orientation: 'horizontal',
            a: [20, 100],
            b: [590, 100],
        });
    });
});

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

describe('filterToDividerLines', () => {
    const PAGE_W = 612;
    const PAGE_H = 792;

    it('keeps a thin horizontal rule spanning at least half the page', () => {
        const out = filterToDividerLines([stroke({ a: [20, 300], b: [590, 300] })], PAGE_W, PAGE_H);
        expect(out).toEqual([
            {
                orientation: 'horizontal',
                position: 300,
                start: 20,
                end: 590,
                thickness: 1,
            },
        ]);
    });

    it('keeps a thin vertical rule spanning at least half the page', () => {
        const out = filterToDividerLines([
            stroke({
                a: [300, 100],
                b: [300, 700],
                orientation: 'vertical',
            }),
        ], PAGE_W, PAGE_H);
        expect(out).toEqual([
            {
                orientation: 'vertical',
                position: 300,
                start: 100,
                end: 700,
                thickness: 1,
            },
        ]);
    });

    it('drops short, thick, invisible, and near-white strokes', () => {
        const out = filterToDividerLines([
            stroke({ a: [20, 300], b: [200, 300] }),
            stroke({ thickness: 3 }),
            stroke({ alpha: 0 }),
            stroke({ color: [1] }),
        ], PAGE_W, PAGE_H);
        expect(out).toHaveLength(0);
    });
});

describe('extractFilledRectsFromDoc — fill-budget plumbing', () => {
    // Verifies that `maxFills` reaches `Page.collectFilledRects` without
    // mutation, and that the default budget is taken from the API
    // module (one source of truth). The actual abort behavior lives
    // inside the WASM-backed Page implementation and is covered by the
    // live-PDF smoke run in the worktree's CLI test (page 0 of
    // DDS69CQI emits 1223 fill_path events; default budget → 0
    // returned, loose budget → 1223 returned).

    function makeDoc(
        captured: { lastArg?: number },
        fills: FillRect[] = [],
    ): DocumentLike {
        const page: PageLike = {
            pointer: 1,
            getBounds: () => [0, 0, 612, 792],
            getLabel: () => undefined,
            toStructuredText: vi.fn(),
            toPixmap: vi.fn(),
            search: vi.fn(),
            collectFilledRects: (maxFills?: number) => {
                captured.lastArg = maxFills;
                return fills;
            },
            collectGraphics: (opts) => {
                captured.lastArg = opts?.maxFills;
                return { fills, strokes: [] };
            },
            destroy: () => {},
        };
        return {
            pointer: 1,
            needsPassword: () => false,
            countPages: () => 1,
            getMetadata: () => undefined,
            loadPage: () => page,
            destroy: () => {},
        };
    }

    it('forwards an explicit maxFills argument to Page.collectFilledRects', () => {
        const captured: { lastArg?: number } = {};
        const doc = makeDoc(captured);
        extractFilledRectsFromDoc(doc, 0, 25);
        expect(captured.lastArg).toBe(25);
    });

    it('passes undefined when maxFills is omitted (Page picks DEFAULT_MAX_FILL_RECTS)', () => {
        const captured: { lastArg?: number } = {};
        const doc = makeDoc(captured);
        extractFilledRectsFromDoc(doc, 0);
        expect(captured.lastArg).toBeUndefined();
    });

    it('default budget is set to a generous content-page ceiling', () => {
        // Sanity: changing this constant changes user-visible
        // behavior on chart-heavy pages. The test pins the value so a
        // refactor that swaps default to e.g. 1 is caught.
        expect(DEFAULT_MAX_FILL_RECTS).toBeGreaterThanOrEqual(10);
        expect(DEFAULT_MAX_FILL_RECTS).toBeLessThanOrEqual(200);
    });
});

describe('extractGraphicsFromDoc', () => {
    it('loads the page once and collects fills and strokes in one device walk', () => {
        const captured: { loadCount: number; opts?: unknown } = { loadCount: 0 };
        const fills = [fill({})];
        const strokes = [stroke({})];
        const page: PageLike = {
            pointer: 1,
            getBounds: () => [0, 0, 612, 792],
            getLabel: () => undefined,
            toStructuredText: vi.fn(),
            toPixmap: vi.fn(),
            search: vi.fn(),
            collectFilledRects: vi.fn(),
            collectGraphics: (opts) => {
                captured.opts = opts;
                return { fills, strokes };
            },
            destroy: () => {},
        };
        const doc: DocumentLike = {
            pointer: 1,
            needsPassword: () => false,
            countPages: () => 1,
            getMetadata: () => undefined,
            loadPage: () => {
                captured.loadCount += 1;
                return page;
            },
            destroy: () => {},
        };

        const out = extractGraphicsFromDoc(doc, 0, { maxFills: 5, maxStrokes: 6 });

        expect(captured.loadCount).toBe(1);
        expect(captured.opts).toEqual({ maxFills: 5, maxStrokes: 6 });
        expect(out).toEqual({ fills, strokes });
    });
});
