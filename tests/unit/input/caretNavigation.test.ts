import { describe, it, expect } from 'vitest';
import { collapsesToRangeEnd } from '@beaver/agent-ui/composer/caretNavigation';

describe('collapsesToRangeEnd', () => {
    it('collapses a range to its start for backward keys', () => {
        for (const key of ['ArrowLeft', 'ArrowUp', 'Home', 'PageUp']) {
            expect(collapsesToRangeEnd(key)).toBe(false);
        }
    });

    it('collapses a range to its end for forward keys', () => {
        for (const key of ['ArrowRight', 'ArrowDown', 'End', 'PageDown']) {
            expect(collapsesToRangeEnd(key)).toBe(true);
        }
    });

    // The edge is chosen in document order for every key, so a right-to-left
    // block behaves exactly like the platform's native fields: ArrowLeft out of
    // a selection lands on the range's start, not its visually left end.
    it('does not mirror the mapping for text direction', () => {
        expect(collapsesToRangeEnd('ArrowLeft')).toBe(false);
        expect(collapsesToRangeEnd('ArrowRight')).toBe(true);
    });
});
