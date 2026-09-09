/**
 * Which keyboard events are the quick prompt chord.
 */
import { describe, expect, it } from 'vitest';
import { isQuickPromptShortcut, type ChordEvent } from '../../../src/utils/shortcuts';

function event(overrides: Partial<ChordEvent>): ChordEvent {
    return {
        key: 'j',
        code: 'KeyJ',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        getModifierState: () => false,
        ...overrides,
    };
}

describe('isQuickPromptShortcut', () => {
    it('matches Cmd+Option+key on macOS, including the character Option types', () => {
        expect(isQuickPromptShortcut(event({ key: 'j', metaKey: true, altKey: true }), 'j', true)).toBe(true);
        expect(isQuickPromptShortcut(event({ key: '∆', metaKey: true, altKey: true }), 'j', true)).toBe(true);
    });

    it('ignores the AltGraph state on macOS, where Option always carries it', () => {
        const option = event({ key: '∆', metaKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' });
        expect(isQuickPromptShortcut(option, 'j', true)).toBe(true);
    });

    it('matches Ctrl+Alt+key on Windows and Linux', () => {
        expect(isQuickPromptShortcut(event({ ctrlKey: true, altKey: true }), 'j', false)).toBe(true);
    });

    it('rejects AltGr character entry, which arrives as Ctrl+Alt with the AltGraph state', () => {
        const altGr = event({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' });
        expect(isQuickPromptShortcut(altGr, 'q', false)).toBe(false);
    });

    it('still matches under AltGr when the key types nothing but its own letter', () => {
        const altGr = event({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' });
        expect(isQuickPromptShortcut(altGr, 'j', false)).toBe(true);
    });

    it('rejects the other Beaver chords and plain keys', () => {
        expect(isQuickPromptShortcut(event({ metaKey: true }), 'j', true)).toBe(false);
        expect(isQuickPromptShortcut(event({ metaKey: true, shiftKey: true }), 'j', true)).toBe(false);
        expect(isQuickPromptShortcut(event({ metaKey: true, altKey: true, shiftKey: true }), 'j', true)).toBe(false);
        expect(isQuickPromptShortcut(event({ ctrlKey: true, altKey: true }), 'j', true)).toBe(false);
        expect(isQuickPromptShortcut(event({ altKey: true }), 'j', false)).toBe(false);
    });

    it('follows the configured key, case-insensitively', () => {
        expect(isQuickPromptShortcut(event({ key: 'K', code: 'KeyK', metaKey: true, altKey: true }), 'K', true)).toBe(true);
        expect(isQuickPromptShortcut(event({ key: 'j', code: 'KeyJ', metaKey: true, altKey: true }), 'k', true)).toBe(false);
    });

    it('works without getModifierState on the event', () => {
        const bare = event({ ctrlKey: true, altKey: true });
        delete bare.getModifierState;
        expect(isQuickPromptShortcut(bare, 'j', false)).toBe(true);
    });
});
