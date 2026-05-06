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

describe('detectColumns tail/head/paragraph merge for ragged-right text', () => {
    // Phase 4.5 (post-bridge re-join with relaxed predicates) absorbs:
    //   1. narrow short trailing lines below a wider host (canJoinAsShortAdjacent)
    //   2. narrow short indented first lines above a wider host (canJoinAsShortAdjacent)
    //   3. two tall same-column paragraph blocks separated by a small gap
    //      (canJoinAsSameColumnParagraphs)
    // Each predicate is gated to keep multi-column layouts and headings
    // from collapsing.

    it('tail merges into host (CZAA39JT shape)', () => {
        // Body paragraph + short trailing ragged line "with these changes."
        // gap=10pt, tail.h=12pt → strict 10pt budget already covers it,
        // but right edges differ (469 vs 90) so only the relaxed path can
        // fire.
        const body: Rect = { x: 72, y: 100, w: 470, h: 400 };
        const tail: Rect = { x: 72, y: 510, w: 90, h: 12 };
        const result = detectColumns(makeColumnPage([body, tail]));
        expect(result.columns.length).toBe(1);
        expect(result.columns[0].x).toBe(72);
        expect(result.columns[0].y).toBe(100);
        expect(result.columns[0].y + result.columns[0].h).toBe(522);
    });

    it('tail merges with line-height-scaled gap (WUIJDNRF shape)', () => {
        // Body + trailing line; gap=12pt > maxVerticalGap=10pt but
        // ≤ 1.5 × tail.h (1.5 × 16 = 24pt). Verifies the height-scaled
        // gap budget catches looser line spacing.
        const body: Rect = { x: 108, y: 70, w: 436, h: 458 };
        const tail: Rect = { x: 108, y: 540, w: 172, h: 16 };
        const result = detectColumns(makeColumnPage([body, tail]));
        expect(result.columns.length).toBe(1);
        expect(result.columns[0].x).toBe(108);
        expect(result.columns[0].y).toBe(70);
        expect(result.columns[0].y + result.columns[0].h).toBe(556);
    });

    it('does NOT merge tall sidebar/abstract above body (QKFDM868 regression guard)', () => {
        // Tall abstract h=200 must not be mistaken for a tail of the right
        // body column. The maxBridgeHeight gate excludes it. (And the
        // "tail must sit below host" rule excludes it from the other
        // direction.)
        const abstract: Rect = { x: 440, y: 80, w: 100, h: 200 };
        const body: Rect = { x: 440, y: 300, w: 200, h: 250 };
        const result = detectColumns(makeColumnPage([abstract, body]));
        expect(result.columns.length).toBe(2);
        // Order is y-then-x: abstract first.
        expect(result.columns[0].y).toBe(80);
        expect(result.columns[1].y).toBe(300);
    });

    it('indented head merges into host (WUIJDNRF p4 dedication shape)', () => {
        // Paragraph-first-line indent (different left edge from body) sitting
        // just above the body should be absorbed. Without sameLeft as a hard
        // requirement, containment + short height + small gap is enough.
        const head: Rect = { x: 144, y: 170, w: 390, h: 16 };
        const body: Rect = { x: 108, y: 198, w: 434, h: 320 };
        const result = detectColumns(makeColumnPage([head, body]));
        expect(result.columns.length).toBe(1);
        expect(result.columns[0].x).toBe(108);
        expect(result.columns[0].y).toBe(170);
        expect(result.columns[0].y + result.columns[0].h).toBe(518);
    });

    it('two tall paragraphs same column merge across a small gap (WUIJDNRF p4 shape)', () => {
        // Mimics the Phase-2-can't-merge scenario: an "obstacle" indented
        // line between the two paragraphs that intersects either union, so
        // Phase 2's mergeBlocks gives up. After Phase 4 bridge absorbs the
        // obstacle into para1, Phase 4.5 must merge para1 + para2 across
        // the remaining ~12pt gap with right edges differing by a few pt.
        const para1: Rect = { x: 108, y: 200, w: 434, h: 280 };       // right=542
        const obstacle: Rect = { x: 144, y: 488, w: 398, h: 16 };     // x=144 indent, contained in para1's x-range, between paras
        const para2: Rect = { x: 108, y: 520, w: 430, h: 180 };       // right=538
        const result = detectColumns(makeColumnPage([para1, obstacle, para2]));
        expect(result.columns.length).toBe(1);
        expect(result.columns[0].x).toBe(108);
        expect(result.columns[0].y).toBe(200);
        // Spans para1 top through para2 bottom.
        expect(result.columns[0].y + result.columns[0].h).toBe(700);
    });

    it('does NOT merge tail across column boundary', () => {
        // Two side-by-side columns with the tail of the LEFT column at the
        // bottom. The right column shares neither a left edge with the
        // left column nor with the tail, so nothing relaxed can fire
        // across the gutter. Locks in the sameLeftEdge gate.
        const left: Rect = { x: 100, y: 100, w: 200, h: 400 };
        const right: Rect = { x: 350, y: 100, w: 200, h: 420 };
        const tail: Rect = { x: 100, y: 510, w: 80, h: 12 };
        const result = detectColumns(makeColumnPage([right, left, tail]));
        expect(result.columns.length).toBe(2);
        // Left column should now span 100..522 (absorbed tail).
        const leftCol = result.columns.find(c => c.x === 100)!;
        expect(leftCol.y + leftCol.h).toBe(522);
        // Right column unaffected.
        const rightCol = result.columns.find(c => c.x === 350)!;
        expect(rightCol.y).toBe(100);
        expect(rightCol.h).toBe(420);
    });
});

describe('detectColumns clipping respects custom header/footerMargin', () => {
    // Production callers (FilteredParagraphPipeline, worker/ops.ts) thread
    // their margins.{top,bottom} into ColumnDetectionOptions so the column
    // clip matches the upstream MarginFilter content area. These two tests
    // lock in that contract: a body line just inside the custom content
    // area is kept, while a line squarely inside the margin is dropped.

    it('keeps a body block whose top sits at pageHeight - 49 when footerMargin is 40', () => {
        const height = 800;
        const bodyTop: Rect = { x: 100, y: 100, w: 200, h: 400 };
        const bodyBottom: Rect = { x: 100, y: height - 49, w: 200, h: 8 };
        const page: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: 400,
            height,
            blocks: [makeTextBlock(bodyTop), makeTextBlock(bodyBottom)],
        };
        const result = detectColumns(page, { headerMargin: 40, footerMargin: 40 });
        const bottomMost = Math.max(...result.columns.map(c => c.y + c.h));
        // Default 50pt clip would have dropped the y=751 block; with 40pt
        // the bottom rect (y=751..759) survives and extends past 751.
        expect(bottomMost).toBeGreaterThan(height - 49);
    });

    it('still drops a footer entirely inside the bottom 40pt margin', () => {
        const height = 800;
        const body: Rect = { x: 100, y: 100, w: 200, h: 400 };
        const footer: Rect = { x: 100, y: height - 30, w: 200, h: 8 };
        const page: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: 400,
            height,
            blocks: [makeTextBlock(body), makeTextBlock(footer)],
        };
        const result = detectColumns(page, { headerMargin: 40, footerMargin: 40 });
        const bottomMost = Math.max(...result.columns.map(c => c.y + c.h));
        expect(bottomMost).toBeLessThanOrEqual(height - 40);
    });
});
