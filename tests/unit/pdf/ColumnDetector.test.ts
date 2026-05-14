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
import {
    bboxFromXYWH,
    type RawBlock,
    type RawLine,
    type RawPageData,
    type TextStyle,
} from '../../../src/services/pdf/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractFilteredBlocks keeps a line if alnumCount >= 2, OR
// (alnumCount >= 1 AND length >= 3). "body text" satisfies both.
function makeTextBlock(rect: Rect, text = 'body text'): RawBlock {
    const bbox = bboxFromXYWH(rect.x, rect.y, rect.w, rect.h, "top-left");
    const line: RawLine = {
        wmode: 0,
        bbox,
        font: { name: 'Body', family: 'Body', weight: 'normal', style: 'normal', size: 10 },
        x: rect.x,
        y: rect.y,
        text,
    };
    return { type: 'text', bbox, lines: [line] };
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

    it('4b. horizontal divider biases fragmented two-column order to top row before bottom row', () => {
        const tl: Rect = { x: 100, y: 100, w: 100, h: 100 };
        const bl: Rect = { x: 100, y: 230, w: 180, h: 100 };
        const tr: Rect = { x: 300, y: 100, w: 100, h: 100 };
        const br: Rect = { x: 300, y: 230, w: 180, h: 100 };
        const result = detectColumns(makeColumnPage([tr, bl, br, tl]), {
            dividerLines: [{
                orientation: 'horizontal',
                position: 215,
                start: 90,
                end: 500,
                thickness: 1,
            }],
        });
        expect(result.columns.map((c) => [c.x, c.y])).toEqual([
            [100, 100],
            [300, 100],
            [100, 230],
            [300, 230],
        ]);
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

    // -----------------------------------------------------------------
    // Standalone-heading guard for canJoinAsShortAdjacent.
    //
    // The relaxed pass must not absorb a short narrow block that sits
    // between two body-shaped blocks separated by a section-sized gap,
    // because that pattern is a section heading at the start of a new
    // section, not a paragraph fragment. The guard fires only when the
    // small block is ABOVE the candidate host (heading-then-body) — see
    // ColumnDetector.ts comments on canJoinAsShortAdjacent.
    // -----------------------------------------------------------------

    it('keeps a standalone Methods-shape heading separate from the body below (3WBRN8M8 p6)', () => {
        // Geometry mirrors the failing fixture: bodyAbove ends well before
        // a single-word heading, then body resumes just below the heading.
        // Without the guard, Phase 4.5 absorbs Methods into bodyBelow.
        const bodyAbove: Rect = { x: 72, y: 100, w: 425, h: 270 }; // bottom = 370
        const methods:   Rect = { x: 72, y: 456, w: 48,  h: 16  }; // gap above ≈ 86
        const bodyBelow: Rect = { x: 72, y: 490, w: 454, h: 200 }; // gap below = 18
        const result = detectColumns(makeColumnPage([bodyAbove, methods, bodyBelow]));
        // The three blocks must remain three distinct rects.
        expect(result.columns.length).toBe(3);
        // Stronger structural assertion: no single rect spans both Methods
        // and the bottom of bodyBelow (would mean they merged).
        for (const c of result.columns) {
            const merged = c.y <= methods.y && c.y + c.h >= bodyBelow.y + bodyBelow.h;
            expect(merged).toBe(false);
        }
    });

    it('keeps a numbered ~60% width heading separate when sandwiched with section gap above', () => {
        // "2. Methods" / "Results and discussion" shapes — too wide for
        // the bridge merger's 2× gate but still well under 0.65 of the
        // host. Section-sized gap above is the discriminator.
        const bodyAbove: Rect = { x: 72, y: 100, w: 450, h: 270 }; // bottom = 370
        const heading:   Rect = { x: 72, y: 456, w: 270, h: 16  }; // 270/450 = 0.6
        const bodyBelow: Rect = { x: 72, y: 490, w: 454, h: 200 };
        const result = detectColumns(makeColumnPage([bodyAbove, heading, bodyBelow]));
        expect(result.columns.length).toBe(3);
        for (const c of result.columns) {
            const merged = c.y <= heading.y && c.y + c.h >= bodyBelow.y + bodyBelow.h;
            expect(merged).toBe(false);
        }
    });

    it('still merges a wide indented head when no section gap precedes it (regression for dedication shape)', () => {
        // ~0.9 width head sits at the top of the column with no prior
        // body block. The heading-width gate excludes it from the guard
        // and the merge proceeds (locks in WUIJDNRF p4 dedication).
        const head: Rect = { x: 144, y: 170, w: 390, h: 16 };       // 390/434 = 0.90
        const body: Rect = { x: 108, y: 198, w: 434, h: 320 };
        const result = detectColumns(makeColumnPage([head, body]));
        expect(result.columns.length).toBe(1);
        expect(result.columns[0].y).toBe(170);
        expect(result.columns[0].y + result.columns[0].h).toBe(518);
    });

    it('still merges a narrow indented head when preceding block is offset (title-then-indented-paragraph)', () => {
        // A section starts with an indented short first line directly
        // beneath a wide title separated by a section-sized gap. The
        // indented head shares NO left edge with its body, so the guard
        // must NOT fire — otherwise we'd regress a common layout. Locks
        // in the same-left-edge gate that distinguishes section headings
        // (column-aligned) from indented paragraph heads (offset).
        const title: Rect = { x: 72, y: 100, w: 450, h: 16 };  // wide
        const head:  Rect = { x: 108, y: 200, w: 120, h: 16 }; // indented, narrow
        const body:  Rect = { x: 72, y: 226, w: 450, h: 200 };
        const result = detectColumns(makeColumnPage([title, head, body]));
        // head + body must merge into one column; title stays separate.
        expect(result.columns.length).toBe(2);
        const titleCol = result.columns.find(c => c.y === 100)!;
        expect(titleCol.h).toBe(16);
        const bodyCol = result.columns.find(c => c.y === 200)!;
        expect(bodyCol.y + bodyCol.h).toBe(426); // covers head + body
    });

    it('still merges a body + ragged tail before a wide next-section block', () => {
        // body / short tail / large gap / wide next-section block. The
        // away-side block is below the tail; the guard direction is
        // "small above large" only, so the body+tail merge proceeds and
        // the next section stays separate.
        const body:    Rect = { x: 72, y: 100, w: 470, h: 200 };  // bottom = 300
        const tail:    Rect = { x: 72, y: 310, w: 90,  h: 12  };  // small below body, gap=10
        const nextSec: Rect = { x: 72, y: 380, w: 470, h: 100 };  // wide block, gap=58
        const result = detectColumns(makeColumnPage([body, tail, nextSec]));
        expect(result.columns.length).toBe(2);
        const bodyCol = result.columns.find(c => c.y === 100)!;
        expect(bodyCol.y + bodyCol.h).toBe(322); // covers tail
        const nextCol = result.columns.find(c => c.y === 380)!;
        expect(nextCol.h).toBe(100);
    });
});

describe('detectColumns fillBoundaries zone guard (Phase 2)', () => {
    // `fillBoundaries` carries the bboxes of tinted display containers
    // (sidebar boxes, callouts, "facts" boxes) discovered by walking
    // the PDF content stream's fill_path events. Each rect defines a
    // zone — a text block inside the rect cannot merge in Phase 2 with
    // a text block outside it, even when they share an x-range.
    //
    // The motivating layout is DDS69CQI page 33: a grey-tinted aside
    // sits at the same x-range as the body column underneath it, with
    // no intervening text block. Phase 2's `canMergeBlocks` would
    // otherwise fuse them and the box content would interleave with
    // body text in the final reading order.

    it('keeps an aside-box block separate from same-x body block below when a fill zone marks the box', () => {
        // Two same-shape blocks in the right column with a 41pt vertical
        // gap. Without the fill rect they'd fuse via canMergeBlocks (same
        // widths, no intervening block); with the fill rect bounding the
        // upper block they stay distinct.
        const asideBox: Rect = { x: 273, y: 97,  w: 198, h: 145 };  // inside fill
        const body:     Rect = { x: 273, y: 283, w: 198, h: 200 };  // outside fill
        // Fill rect encloses the aside box (with a few-pt padding around
        // the text — typical for tinted backgrounds whose padding
        // extends past the text bbox).
        const fillRect = { x: 270, y: 90, w: 204, h: 160 };
        const result = detectColumns(makeColumnPage([asideBox, body]), {
            fillBoundaries: [fillRect],
        });
        expect(result.columns.length).toBe(2);
        for (const c of result.columns) {
            const spansBoth = c.y <= asideBox.y && c.y + c.h >= body.y + body.h;
            expect(spansBoth).toBe(false);
        }
    });

    it('still fuses two inside-the-same-fill blocks (e.g. paragraphs inside one aside)', () => {
        // Both blocks sit inside the same fill rect → same zone → eligible
        // to merge. Locks in that the zone guard is symmetric (it doesn't
        // unconditionally reject merges inside a fill).
        const para1: Rect = { x: 80, y: 100, w: 200, h: 80 };
        const para2: Rect = { x: 80, y: 190, w: 200, h: 80 }; // 10pt gap
        const fillRect = { x: 70, y: 90, w: 220, h: 200 };
        const result = detectColumns(makeColumnPage([para1, para2]), {
            fillBoundaries: [fillRect],
        });
        expect(result.columns.length).toBe(1);
        expect(result.columns[0].y).toBe(100);
        expect(result.columns[0].y + result.columns[0].h).toBe(270);
    });

    it('still fuses two outside-all-fills blocks (regression guard for plain layouts)', () => {
        // Empty `fillBoundaries` ≡ "no zones" ≡ behavior identical to
        // the un-gated detector. Verifies the guard is a no-op when no
        // fill rects exist.
        const para1: Rect = { x: 80, y: 100, w: 200, h: 80 };
        const para2: Rect = { x: 80, y: 190, w: 200, h: 80 };
        const result = detectColumns(makeColumnPage([para1, para2]), {
            fillBoundaries: [],
        });
        expect(result.columns.length).toBe(1);
    });

    it('keeps a short heading INSIDE a fill from bridging to body OUTSIDE the fill (DDS69CQI p8 shape)', () => {
        // Concretely: a body paragraph sits above a tinted "About this
        // report"-style box. The box's first line ("About this
        // report" heading, h≈12) is short, and Phase 4's bridge
        // merger has same-right-edge + small-gap to both the body
        // above and the box-content paragraph below. Without a fill-
        // zone guard in Phase 4 the bridge merges body + heading +
        // box-paragraph into one column rect, undoing Phase 2's zone
        // split.
        const bodyAbove:    Rect = { x: 147, y: 343, w: 195, h: 56 };  // outside fill
        const insideHeading:Rect = { x: 147, y: 428, w: 101, h: 12 };  // short, INSIDE fill
        const insideBody:   Rect = { x: 159, y: 447, w: 184, h: 109 }; // INSIDE fill
        // Fill rect wraps the heading + insideBody (typical aside
        // padding extends a few pt past the text bbox).
        const fillRect = { x: 144, y: 419, w: 418, h: 252 };
        const result = detectColumns(
            makeColumnPage([bodyAbove, insideHeading, insideBody]),
            { fillBoundaries: [fillRect] },
        );
        // No single rect should span from bodyAbove through to insideBody.
        for (const c of result.columns) {
            const spans = c.y <= bodyAbove.y && c.y + c.h >= insideBody.y + insideBody.h;
            expect(spans).toBe(false);
        }
        // bodyAbove (outside) must be its own column rect, not absorbed
        // into the inside-fill column flow.
        const aboveCol = result.columns.find((c) => c.y === bodyAbove.y);
        expect(aboveCol).toBeTruthy();
        expect(aboveCol!.y + aboveCol!.h).toBeLessThan(insideHeading.y);
    });

    it('picks the innermost fill when zones nest (smallest containing rect wins)', () => {
        // Nested-aside layout: outer card with an inner highlight box.
        // A text block inside the inner box should be in the inner zone,
        // not the outer one — otherwise it might merge with an outer-
        // zone neighbor that shouldn't be in its scope.
        const innerBox: Rect = { x: 80, y: 100, w: 100, h: 30 };  // inside inner fill
        const outerOnly: Rect = { x: 80, y: 200, w: 100, h: 30 }; // inside outer only
        const innerFill = { x: 70, y: 90, w: 120, h: 50 };
        const outerFill = { x: 60, y: 60, w: 200, h: 200 };
        const result = detectColumns(
            makeColumnPage([innerBox, outerOnly]),
            { fillBoundaries: [outerFill, innerFill] },
        );
        // Different zones (innerFill vs outerFill) → no merge despite
        // matching shape.
        expect(result.columns.length).toBe(2);
    });

    it('does not require fillBoundaries (option is optional)', () => {
        // Default behavior when option is omitted matches the legacy
        // detector — the guard only activates when explicit rects are
        // provided.
        const para1: Rect = { x: 80, y: 100, w: 200, h: 80 };
        const para2: Rect = { x: 80, y: 190, w: 200, h: 80 };
        const result = detectColumns(makeColumnPage([para1, para2]));
        expect(result.columns.length).toBe(1);
    });
});

describe('detectColumns dividerLines merge guard', () => {
    it('keeps vertically adjacent same-column blocks separate across a horizontal rule', () => {
        const para1: Rect = { x: 80, y: 100, w: 200, h: 80 };
        const para2: Rect = { x: 80, y: 190, w: 200, h: 80 };
        const result = detectColumns(makeColumnPage([para1, para2]), {
            dividerLines: [{
                orientation: 'horizontal',
                position: 185,
                start: 60,
                end: 320,
                thickness: 1,
            }],
        });
        expect(result.columns.length).toBe(2);
        expect(result.columns.map((c) => c.y)).toEqual([100, 190]);
    });
});

describe('detectColumns zone-aware reading order (Phase 5)', () => {
    // When a fill zone exists, the reading-order sort treats it as a
    // single virtual block in the outer xy-cut. The motivating shape is
    // DDS69CQI p36: top body text wraps left→right across the page,
    // then a tinted "box" below it splits into two columns. Without
    // zone awareness, xy-cut takes the inner-box gutter first and reads
    // top-L → box-L → top-R → box-R. With zone awareness the outer cut
    // sees the box as a unit and reads top-L → top-R → box-L → box-R.

    it('reads top-body L→R before a tinted box that splits into 2 inner columns', () => {
        // Page geometry (approximating the p36 shape):
        //   topL  | topR     y=70..140    (above box)
        //   ╔════════════════╗
        //   ║ boxL  |  boxR  ║  y=200..600 (inside fill zone)
        //   ╚════════════════╝
        const topL: Rect  = { x: 100, y: 70,  w: 200, h: 70 };
        const topR: Rect  = { x: 320, y: 70,  w: 200, h: 70 };
        const boxL: Rect  = { x: 120, y: 200, w: 180, h: 400 };
        const boxR: Rect  = { x: 320, y: 200, w: 180, h: 400 };
        // Fill rect wraps the box's two columns.
        const fillRect = { x: 110, y: 190, w: 400, h: 420 };
        const result = detectColumns(
            makeColumnPage([boxR, topR, boxL, topL]),
            { fillBoundaries: [fillRect] },
        );
        const xs = result.columns.map(c => c.x);
        // Expected sequence: topL, topR, boxL, boxR.
        expect(xs).toEqual([100, 320, 120, 320]);
    });

    it('reading-order baseline without zones still flows column-major (regression guard)', () => {
        // Same x-positions but use widths that *don't* trigger Phase 2's
        // containment-merge (ratios < 0.8). This isolates the Phase-5
        // reading-order behavior: legacy xy-cut takes the inner V-gutter
        // first → column-major flow (top-L → box-L → top-R → box-R).
        const topL: Rect  = { x: 100, y: 70,  w: 80,  h: 70 };  // narrow
        const topR: Rect  = { x: 320, y: 70,  w: 80,  h: 70 };
        const boxL: Rect  = { x: 100, y: 200, w: 180, h: 400 }; // wide
        const boxR: Rect  = { x: 320, y: 200, w: 180, h: 400 };
        const result = detectColumns(makeColumnPage([boxR, topR, boxL, topL]));
        const xs = result.columns.map(c => c.x);
        expect(xs).toEqual([100, 100, 320, 320]);
        // Column-major: y=70 (topL) → y=200 (boxL) → y=70 (topR) → y=200 (boxR).
        const ys = result.columns.map(c => c.y);
        expect(ys).toEqual([70, 200, 70, 200]);
    });

    it('keeps the zone\'s own multi-column gutter for inside-zone ordering', () => {
        // Only the box's content (no outside blocks). The zone is the
        // only "world" — the inner V-cut should still apply so the
        // left box-column is read before the right.
        const boxL: Rect  = { x: 120, y: 200, w: 180, h: 400 };
        const boxR: Rect  = { x: 320, y: 200, w: 180, h: 400 };
        const fillRect = { x: 110, y: 190, w: 400, h: 420 };
        const result = detectColumns(
            makeColumnPage([boxR, boxL]),
            { fillBoundaries: [fillRect] },
        );
        const xs = result.columns.map(c => c.x);
        expect(xs).toEqual([120, 320]);
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

// ---------------------------------------------------------------------------
// Body-style spare in the header/footer clip
//
// Tight-margin journal/magazine layouts place body text within ~20–30pt of
// the page edge.
// ---------------------------------------------------------------------------

function makeBlockWithFont(
    rect: Rect,
    fontName: string,
    fontSize: number,
    text = 'body text',
): RawBlock {
    const bbox = bboxFromXYWH(rect.x, rect.y, rect.w, rect.h, "top-left");
    const line: RawLine = {
        wmode: 0,
        bbox,
        font: {
            name: fontName,
            family: fontName,
            weight: 'normal',
            style: 'normal',
            size: fontSize,
        },
        x: rect.x,
        y: rect.y,
        text,
    };
    return { type: 'text', bbox, lines: [line] };
}

const BODY_STYLE: TextStyle = {
    size: 9,
    font: 'MinionPro-Regular',
    bold: false,
    italic: false,
};

describe('detectColumns body-style spare on header/footer clip', () => {
    it('keeps a body-styled block whose bbox sits entirely below the footer clip', () => {
        // Page height 647pt with footerMargin 40 → clip.y1 = 607. The block
        // at y=609 is entirely below the clip. Without `bodyStyles` the
        // clip drops it (the existing behavior for non-body blocks);
        // with `bodyStyles` it is kept.
        const height = 647;
        const body: Rect = { x: 45, y: 100, w: 360, h: 400 };
        const tailBody: Rect = { x: 45, y: 609, w: 360, h: 19 };
        const page: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: 432,
            height,
            blocks: [
                makeBlockWithFont(body, 'MinionPro-Regular', 9),
                makeBlockWithFont(tailBody, 'MinionPro-Regular', 9),
            ],
        };

        const withoutSpare = detectColumns(page, {
            headerMargin: 40,
            footerMargin: 40,
        });
        const withoutBottom = Math.max(
            ...withoutSpare.columns.map((c) => c.y + c.h),
        );
        expect(withoutBottom).toBeLessThan(609);

        const withSpare = detectColumns(page, {
            headerMargin: 40,
            footerMargin: 40,
            bodyStyles: [BODY_STYLE],
        });
        const withBottom = Math.max(...withSpare.columns.map((c) => c.y + c.h));
        expect(withBottom).toBeGreaterThanOrEqual(609);
    });

    it('still drops a non-body-styled block entirely inside the footer margin', () => {
        // A small-font footnote / page number block below the clip whose
        // style differs from body should remain dropped even when the
        // caller supplies bodyStyles.
        const height = 647;
        const body: Rect = { x: 45, y: 100, w: 360, h: 400 };
        const pageNumber: Rect = { x: 396, y: 615, w: 9, h: 8 };
        const page: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: 432,
            height,
            blocks: [
                makeBlockWithFont(body, 'MinionPro-Regular', 9),
                // Smaller font → not a body style → clip still drops it.
                makeBlockWithFont(pageNumber, 'MinionPro-Regular', 6, '45'),
            ],
        };
        const result = detectColumns(page, {
            headerMargin: 40,
            footerMargin: 40,
            bodyStyles: [BODY_STYLE],
        });
        const bottomMost = Math.max(...result.columns.map((c) => c.y + c.h));
        expect(bottomMost).toBeLessThan(615);
    });

    it('drops a body-font page number block below the clip (substance gate)', () => {
        // Page number rendered in the body font size at the very bottom
        // of the page. Style alone would falsely spare it via the body-
        // style rule; the substance gate (≥2 words AND ≥8 alnum chars)
        // keeps it out of column detection.
        const height = 841;
        const body: Rect = { x: 45, y: 100, w: 360, h: 600 };
        const pageNumber: Rect = { x: 292, y: 808, w: 10, h: 9 };
        const page: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: 595,
            height,
            blocks: [
                makeBlockWithFont(body, 'MinionPro-Regular', 9),
                // Body font + body size but a single token "17" → not body content.
                makeBlockWithFont(pageNumber, 'MinionPro-Regular', 9, '17'),
            ],
        };
        const result = detectColumns(page, {
            headerMargin: 40,
            footerMargin: 40,
            bodyStyles: [BODY_STYLE],
        });
        const bottomMost = Math.max(...result.columns.map((c) => c.y + c.h));
        expect(bottomMost).toBeLessThan(808);
    });
});
