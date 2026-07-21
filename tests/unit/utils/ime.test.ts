import { describe, it, expect } from 'vitest';
import { isImeKeyEvent } from '../../../react/utils/ime';

describe('isImeKeyEvent', () => {
    it('detects events flagged as composing', () => {
        expect(isImeKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    });

    it('detects the legacy IME keyCode 229', () => {
        expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    });

    it('ignores ordinary key events', () => {
        expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
        expect(isImeKeyEvent({ isComposing: false, keyCode: 37 })).toBe(false);
    });

    it('ignores events without composition signals', () => {
        expect(isImeKeyEvent({})).toBe(false);
    });
});
