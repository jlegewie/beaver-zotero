/**
 * Unit tests for `sortForReadingOrder` (Phase 5 of `detectColumns`).
 *
 * These tests construct synthetic `RawPageData` pages with one
 * `RawBlock` per intended rectangle so that `extractFilteredBlocks`
 * preserves them as separate rects (the helper unions all lines of a
 * single block into one `validRect`). Each rect is tagged with a unique
 * `x` so the output ordering can be matched by inspecting the returned
 * `columns: Rect[]`.
 */
import { describe, it, expect } from 'vitest';
import { detectColumns } from '../../../src/services/pdf/ColumnDetector';
import type { Rect } from '../../../src/services/pdf/ColumnDetector';
import type { RawBlock, RawLine, RawPageData } from '../../../src/services/pdf/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractFilteredBlocks keeps a line if alnumCount >= 2, OR
// (alnumCount >= 1 AND length >= 3). "body text" satisfies both.
function makeTextBlock(rect: Rect, text = 'body text'): RawBlock {
    const line: RawLine = {
        wmode: 0,
        bbox: rect,
        font: { name: 'Body', family: 'Body', weight: 'normal', style: 'normal', size: 10 },
        x: rect.x,
        y: rect.y,
        text,
    };
    return { type: 'text', bbox: rect, lines: [line] };
}

// extractFilteredBlocks clips by headerMargin: 50 and footerMargin: 50,
// so all rects must satisfy y >= 60 and y + h <= height - 60. Page height
// is computed to leave a comfortable footer margin.
function makeColumnPage(rects: Rect[]): RawPageData {
    const blocks = rects.map(r => makeTextBlock(r));
    let maxX = 0;
    let maxY = 0;
    for (const r of rects) {
        if (r.x + r.w > maxX) maxX = r.x + r.w;
        if (r.y + r.h > maxY) maxY = r.y + r.h;
    }
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: maxX + 100,
        height: maxY + 100,
        blocks,
    };
}

function orderOf(rects: Rect[]): number[] {
    return rects.map(r => Math.round(r.x));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectColumns reading order', () => {
    it('1. clean 2-col, same y: left then right', () => {
        const left: Rect = { x: 100, y: 100, w: 200, h: 400 };
        const right: Rect = { x: 350, y: 100, w: 200, h: 400 };
        const result = detectColumns(makeColumnPage([right, left]));
        expect(orderOf(result.columns)).toEqual([100, 350]);
    });

    it('2. clean 2-col, right starts higher: left then right', () => {
        const left: Rect = { x: 100, y: 200, w: 200, h: 400 };
        const right: Rect = { x: 350, y: 100, w: 200, h: 500 };
        const result = detectColumns(makeColumnPage([right, left]));
        expect(orderOf(result.columns)).toEqual([100, 350]);
    });

    it('3. fragmented left + tall right (WTTCL9GH pattern): all left fragments before right', () => {
        // Left column split into 3 stacked rects of *differing widths* so
        // the Phase-2 merger (which fuses by similar edges or by
        // containment with width ratio > 0.8) leaves them as separate
        // rects entering Phase 5. Heights > maxBridgeHeight (50) so Phase
        // 4 doesn't fuse them via the bridge merger either.
        const lTop: Rect = { x: 100, y: 100, w: 100, h: 80 };  // right=200
        const lMid: Rect = { x: 100, y: 200, w: 180, h: 120 }; // right=280
        const lBot: Rect = { x: 100, y: 340, w: 140, h: 200 }; // right=240
        const right: Rect = { x: 350, y: 100, w: 200, h: 440 };
        // Pass them in interleaved order to verify sorting actually happens.
        const result = detectColumns(makeColumnPage([lMid, right, lBot, lTop]));
        expect(orderOf(result.columns)).toEqual([100, 100, 100, 350]);
        // And in y-order within the left column:
        const ys = result.columns.slice(0, 3).map(r => r.y);
        expect(ys).toEqual([...ys].sort((a, b) => a - b));
    });

    it('4. both columns fragmented; horizontal gap > vertical gutter (regression for "larger gap wins")', () => {
        // Vertical gutter ~20pt; horizontal gap between top and bottom ~30pt.
        // A "larger gap wins" XY-cut would produce TL, TR, BL, BR.
        // Vertical-first must produce TL, BL, TR, BR.
        // Differing widths within a column prevent Phase-2 merging by
        // containment (ratio 100/180 = 0.56 < 0.8).
        const tl: Rect = { x: 100, y: 100, w: 100, h: 100 }; // right=200
        const bl: Rect = { x: 100, y: 230, w: 180, h: 100 }; // right=280
        const tr: Rect = { x: 300, y: 100, w: 100, h: 100 }; // right=400
        const br: Rect = { x: 300, y: 230, w: 180, h: 100 }; // right=480
        const result = detectColumns(makeColumnPage([tr, bl, br, tl]));
        expect(orderOf(result.columns)).toEqual([100, 100, 300, 300]);
        // Y-order within each column:
        expect(result.columns[0].y).toBeLessThan(result.columns[1].y);
        expect(result.columns[2].y).toBeLessThan(result.columns[3].y);
    });

    it('5. 3-col body under wide title: title then L, M, R', () => {
        const title: Rect = { x: 100, y: 80, w: 500, h: 40 };
        const l: Rect = { x: 100, y: 150, w: 150, h: 400 };
        const m: Rect = { x: 270, y: 150, w: 150, h: 400 };
        const r: Rect = { x: 440, y: 150, w: 160, h: 400 };
        const result = detectColumns(makeColumnPage([r, m, l, title]));
        expect(orderOf(result.columns)).toEqual([100, 100, 270, 440]);
        // First rect must be the title (the only one at y=80).
        expect(result.columns[0].y).toBe(80);
    });

    it('6. title spans cols 1-2 + abstract on col 3 + 3-col body (QKFDM868 pattern)', () => {
        // Layout:
        //   [    title (cols 1-2)    ] [abstract (col 3)]
        //   [ L body ][ M body ][ R body                 ]
        // Expected: title, L, M, abstract, R.
        // Abstract (w=100) and right body (w=200) share x=440 but their
        // width ratio (0.5) keeps Phase-2 from merging by containment.
        const title: Rect = { x: 100, y: 80, w: 320, h: 40 };
        const abstract: Rect = { x: 440, y: 80, w: 100, h: 200 };
        const l: Rect = { x: 100, y: 150, w: 150, h: 400 };
        const m: Rect = { x: 270, y: 150, w: 150, h: 400 };
        const r: Rect = { x: 440, y: 300, w: 200, h: 250 };
        const result = detectColumns(makeColumnPage([r, abstract, m, l, title]));
        const xs = orderOf(result.columns);
        expect(xs).toEqual([100, 100, 270, 440, 440]);
        // The y=80 rect at x=440 (abstract) must come AFTER the y=150 rects
        // at x=100 and x=270 (left and middle body).
        const abstractIdx = result.columns.findIndex(c => c.x === 440 && c.y === 80);
        const rightBodyIdx = result.columns.findIndex(c => c.x === 440 && c.y === 300);
        expect(abstractIdx).toBe(3);
        expect(rightBodyIdx).toBe(4);
    });

    it('7. full-width footer after 2-col body: L, R, footer', () => {
        const l: Rect = { x: 100, y: 100, w: 200, h: 400 };
        const r: Rect = { x: 350, y: 100, w: 200, h: 400 };
        const footer: Rect = { x: 100, y: 530, w: 450, h: 40 };
        const result = detectColumns(makeColumnPage([footer, r, l]));
        expect(orderOf(result.columns)).toEqual([100, 350, 100]);
        // The full-width rect must be last.
        expect(result.columns[2].w).toBeGreaterThan(result.columns[0].w);
    });

    it('8. single-column page (varied widths): rects in y-order via recursive h-cut', () => {
        // All three rects share x=100 but have widths far enough apart
        // (ratios 0.5, 0.667, 0.75) that Phase-2 containment-merge skips
        // them. Phase-5 then walks the column top-to-bottom via h-cuts.
        const top: Rect = { x: 100, y: 100, w: 200, h: 100 };
        const mid: Rect = { x: 100, y: 230, w: 400, h: 100 };
        const bot: Rect = { x: 100, y: 360, w: 300, h: 100 };
        const result = detectColumns(makeColumnPage([bot, top, mid]));
        expect(result.columns.map(r => r.y)).toEqual([100, 230, 360]);
    });

    it('9. no clean cuts (mutually overlapping rects): falls back to (y, x) sort', () => {
        // Three rects that pairwise overlap on both axes — no clean cut
        // exists at any threshold. The fallback sorts by (y, x).
        const a: Rect = { x: 100, y: 100, w: 300, h: 300 };
        const b: Rect = { x: 200, y: 150, w: 300, h: 300 };
        const c: Rect = { x: 150, y: 250, w: 300, h: 300 };
        const result = detectColumns(makeColumnPage([c, b, a]));
        // After Phase 2-4 these may or may not get merged. What matters is
        // that whatever rects remain come out in (y, x) order.
        const ys = result.columns.map(r => r.y);
        const sortedYs = [...ys].sort((a, b) => a - b);
        expect(ys).toEqual(sortedYs);
    });
});
