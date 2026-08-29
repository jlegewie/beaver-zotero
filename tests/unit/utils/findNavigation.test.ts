/**
 * The find-in-chat navigation arithmetic: which hit a fresh query lands on, and
 * where a step from the current one goes.
 */
import { describe, expect, it } from 'vitest';
import { findFirstHitAtOrBelow, stepMatchIndex } from '../../../react/utils/findNavigation';

describe('findFirstHitAtOrBelow', () => {
    it('reports no hit for an empty result set', () => {
        expect(findFirstHitAtOrBelow([], 500)).toBe(-1);
    });

    it('lands on the first hit at or below the current scroll position', () => {
        expect(findFirstHitAtOrBelow([100, 400, 900, 1600], 500)).toBe(2);
    });

    it('counts a hit exactly at the top of the viewport as below it', () => {
        expect(findFirstHitAtOrBelow([100, 400, 900], 400)).toBe(1);
    });

    it('falls back to the first hit when every hit is above the viewport', () => {
        expect(findFirstHitAtOrBelow([100, 400, 900], 2000)).toBe(0);
    });

    it('lands on the first hit when the thread has not been scrolled', () => {
        expect(findFirstHitAtOrBelow([100, 400, 900], 0)).toBe(0);
    });
});

describe('stepMatchIndex', () => {
    it('reports no hit for an empty result set', () => {
        expect(stepMatchIndex(-1, 0, 1)).toBe(-1);
        expect(stepMatchIndex(2, 0, -1)).toBe(-1);
    });

    it('steps forward and backward', () => {
        expect(stepMatchIndex(1, 4, 1)).toBe(2);
        expect(stepMatchIndex(2, 4, -1)).toBe(1);
    });

    it('wraps around both ends', () => {
        expect(stepMatchIndex(3, 4, 1)).toBe(0);
        expect(stepMatchIndex(0, 4, -1)).toBe(3);
    });

    it('starts at the first hit going forward and the last going backward', () => {
        expect(stepMatchIndex(-1, 4, 1)).toBe(0);
        expect(stepMatchIndex(-1, 4, -1)).toBe(3);
    });
});
