// @vitest-environment jsdom

/**
 * One keystroke reaches the manager's listeners once, however many windows
 * it propagates through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zotero-plugin-toolkit', () => ({
    KeyModifier: class { constructor(_event: unknown) {} },
}));

import { KeyboardManager } from '../../../src/utils/keyboardManager';

let manager: KeyboardManager | null = null;

beforeEach(() => {
    (globalThis as any).ztoolkit = { log: vi.fn() };
    (globalThis as any).Zotero = {
        getMainWindow: () => window,
        getMainWindows: () => [window],
        Reader: undefined,
    };
});

afterEach(() => {
    manager?.unregisterAll();
    manager = null;
});

function keydown(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('KeyboardManager', () => {
    it('dispatches a key event to its callbacks', () => {
        manager = new KeyboardManager();
        const callback = vi.fn();
        manager.register(callback);
        window.dispatchEvent(keydown({ key: 'j', code: 'KeyJ', metaKey: true }));
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('dispatches the same event only once when it arrives through two windows', () => {
        manager = new KeyboardManager();
        const callback = vi.fn();
        manager.register(callback);
        // A keystroke in a reader tab is seen by the listener on the reader's
        // window and again by the one on the main window: the same event,
        // delivered twice.
        const event = keydown({ key: 'j', code: 'KeyJ', metaKey: true, altKey: true });
        window.dispatchEvent(event);
        window.dispatchEvent(event);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('still dispatches a repeated press of the same key', () => {
        manager = new KeyboardManager();
        const callback = vi.fn();
        manager.register(callback);
        const first = keydown({ key: 'j', code: 'KeyJ', metaKey: true });
        const second = keydown({ key: 'j', code: 'KeyJ', metaKey: true });
        // Distinct keystrokes carry distinct timestamps.
        Object.defineProperty(second, 'timeStamp', { value: first.timeStamp + 40 });
        window.dispatchEvent(first);
        window.dispatchEvent(second);
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it('ignores modifier-only presses', () => {
        manager = new KeyboardManager();
        const callback = vi.fn();
        manager.register(callback);
        window.dispatchEvent(keydown({ key: 'Meta' }));
        window.dispatchEvent(keydown({ key: 'Alt' }));
        expect(callback).not.toHaveBeenCalled();
    });
});
