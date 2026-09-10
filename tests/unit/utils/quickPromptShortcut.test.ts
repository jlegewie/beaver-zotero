// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zotero-plugin-toolkit', () => ({
    KeyModifier: class { constructor(_event: unknown) {} },
}));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => 'J' }));
vi.mock('../../../src/utils/locale', () => ({ getString: () => 'Beaver', getLocaleID: vi.fn() }));

import { BeaverUIFactory } from '../../../src/ui/ui';

let timestamp = 0;
let toggle: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).ztoolkit = { log: vi.fn() };
    (globalThis as any).Zotero = {
        isMac: false,
        getMainWindow: () => window,
        getMainWindows: () => [window],
    };
    (window as any).__beaverEventBus = new EventTarget();
    toggle = vi.fn();
    (window as any).__beaverEventBus.addEventListener('toggleQuickPrompt', toggle);
    BeaverUIFactory.registerShortcuts();
});

afterEach(() => {
    BeaverUIFactory.unregisterShortcuts();
    delete (window as any).__beaverEventBus;
});

function dispatch(type: 'keydown' | 'keyup', init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent(type, {
        key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true,
        bubbles: true, cancelable: true, ...init,
    });
    Object.defineProperty(event, 'timeStamp', { value: ++timestamp });
    window.dispatchEvent(event);
    return event;
}

describe('quick prompt shortcut registration', () => {
    it('toggles once when J is released before Ctrl and Alt, then accepts another press', () => {
        dispatch('keydown');
        expect(toggle).toHaveBeenCalledTimes(1);
        dispatch('keyup');
        expect(toggle).toHaveBeenCalledTimes(1);
        dispatch('keydown');
        expect(toggle).toHaveBeenCalledTimes(2);
    });

    it('consumes held-key repeats without toggling the popup again', () => {
        dispatch('keydown');
        expect(dispatch('keydown', { repeat: true }).defaultPrevented).toBe(true);
        dispatch('keyup');
        expect(toggle).toHaveBeenCalledTimes(1);
    });

    it('toggles once for Cmd+Option+J on macOS', () => {
        (Zotero as any).isMac = true;
        const chord = { key: '∆', ctrlKey: false, metaKey: true };
        dispatch('keydown', chord);
        dispatch('keyup', chord);
        expect(toggle).toHaveBeenCalledTimes(1);
    });
});
