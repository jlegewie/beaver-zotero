/**
 * Placement of hover cards (a citation's passage card, a tag's tip) next to
 * their anchor: a card never covers the element it describes.
 */

import { describe, expect, it } from 'vitest';
import { placeCard, type CardPlacement } from '@beaver/agent-ui/primitives/HoverLayer';

const view = { width: 1000, height: 800 };
const anchorAt = (top: number, left = 100) => ({ top, bottom: top + 20, left, right: left + 40 });

/** The card's vertical extent at its natural height, bounded by its placement. */
function extent(placement: CardPlacement, height: number): { top: number; bottom: number } {
    const shown = Math.min(height, placement.maxHeight);
    if (placement.top !== undefined) return { top: placement.top, bottom: placement.top + shown };
    const bottom = view.height - placement.bottom!;
    return { top: bottom - shown, bottom };
}

const overlapsVertically = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
    a.top < b.bottom && b.top < a.bottom;

describe('placeCard', () => {
    it('puts a card that fits under its anchor', () => {
        const placement = placeCard(anchorAt(100), { width: 300, height: 300 }, view);
        expect(placement).toEqual({ left: 100, top: 124, maxHeight: 800 - 8 - 120 - 4 });
    });

    it('puts a card above when only above has room, held by its bottom edge so it grows away from the anchor', () => {
        const anchor = anchorAt(600);
        const placement = placeCard(anchor, { width: 300, height: 400 }, view);
        expect(placement.top).toBeUndefined();
        expect(placement.bottom).toBe(800 - 600 + 4);
        expect(placement.maxHeight).toBe(600 - 4 - 8);
        expect(overlapsVertically(extent(placement, 400), anchor)).toBe(false);
    });

    it('bounds a card taller than either side to the roomier side instead of covering the anchor', () => {
        for (const top of [300, 380, 460]) {
            const anchor = anchorAt(top);
            const placement = placeCard(anchor, { width: 300, height: 780 }, view);
            const room = Math.max(view.height - 8 - anchor.bottom - 4, anchor.top - 4 - 8);
            expect(placement.maxHeight).toBe(room);
            expect(overlapsVertically(extent(placement, 780), anchor)).toBe(false);
        }
    });

    it('goes beside the anchor when the window is too short for a card above or below', () => {
        const short = { width: 1000, height: 280 };
        const anchor = anchorAt(130, 100);
        const placement = placeCard(anchor, { width: 300, height: 260 }, short);
        expect(placement.left).toBe(anchor.right + 4);
        // Lifted from the anchor's top only as far as the bottom edge requires.
        expect(placement.top).toBe(280 - 8 - 260);
        expect(placement.maxHeight).toBe(260);
    });

    it('goes to the left of an anchor near the right edge when the window is short', () => {
        const short = { width: 1000, height: 280 };
        const anchor = anchorAt(130, 900);
        const placement = placeCard(anchor, { width: 300, height: 260 }, short);
        expect(placement.left).toBe(900 - 4 - 300);
    });

    it('keeps the card inside the window horizontally', () => {
        expect(placeCard(anchorAt(100, 850), { width: 300, height: 100 }, view).left).toBe(1000 - 300 - 8);
        expect(placeCard(anchorAt(100, 2), { width: 300, height: 100 }, view).left).toBe(8);
    });
});
