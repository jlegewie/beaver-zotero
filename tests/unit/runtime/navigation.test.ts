import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptsTabEvent, contextMainWindow, resolveNavigationWindow, resolveChatWindow } from '../../../src/runtime/navigation';

function main(id: string) {
    return {
        closed: false, focus: vi.fn(),
        ZoteroPane: { itemsView: {} },
        Zotero_Tabs: { windowID: id, selectedID: 'zotero-pane' },
        __beaverEventBus: new EventTarget(),
    } as any;
}
let a: any, b: any;
beforeEach(() => {
    a = main('a'); b = main('b');
    vi.stubGlobal('Zotero', {
        getMainWindow: vi.fn(() => b),
        openMainWindow: vi.fn(() => a),
        Promise: { delay: async () => {} },
    });
});

describe('navigation ownership', () => {
    it('keeps an originating main window while another window is focused', async () => {
        expect(await resolveNavigationWindow(a)).toBe(a);
        expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    });
    it('maps borrowed surfaces to their renderer context', async () => {
        const surface = { closed: false, __beaverOwnerWindowRef: new WeakRef(a) } as any;
        expect(contextMainWindow(surface)).toBe(a);
        expect(await resolveNavigationWindow(surface)).toBe(a);
    });
    it('rejects a closed or closing local target instead of redirecting to B', async () => {
        a.closed = true;
        await expect(resolveNavigationWindow(a)).rejects.toMatchObject({ code: 'window_unavailable' });
        a.closed = false; a.__beaverRuntime = { status: 'closing', contextWindow: a };
        await expect(resolveNavigationWindow(a)).rejects.toMatchObject({ code: 'window_unavailable' });
    });
    it('opens a main window for an originless user command with no windows', async () => {
        vi.mocked(Zotero.getMainWindow).mockReturnValue(null as any);
        expect(await resolveNavigationWindow()).toBe(a);
        expect((Zotero as any).openMainWindow).toHaveBeenCalledOnce();
    });
    it('routes a standalone reader to a chat rather than treating its host as a main window', async () => {
        b.__beaverRuntime = { status: 'ready', contextWindow: b };
        expect(await resolveChatWindow({ closed: false } as any)).toBe(b);
    });
});

describe('tab notifications', () => {
    it('uses isOwnTabEvent for each relevant id in a tagged batch', () => {
        a.Zotero_Tabs.isOwnTabEvent = vi.fn((extra, id) => extra[id].windowID === 'a');
        expect(acceptsTabEvent(a, ['foreign', 'zotero-pane'], {
            foreign: { windowID: 'b' }, 'zotero-pane': { windowID: 'a' },
        })).toBe(true);
        expect(acceptsTabEvent(a, ['zotero-pane'], { 'zotero-pane': { windowID: 'b' } })).toBe(false);
    });
    it('accepts untagged batches for recomputation even when ids do not name the selected tab', () => {
        expect(acceptsTabEvent(a, ['foreign', 'other'], {})).toBe(true);
        expect(a.Zotero_Tabs.selectedID).toBe('zotero-pane');
    });
});

it('independently evaluated renderer modules keep their own context after focus changes', async () => {
    vi.resetModules();
    const rendererA = await import('../../../react/runtime/windowRuntime');
    rendererA.initializeWindowRuntime({ id: 'a', hostWindow: a, contextWindow: a, status: 'ready', events: new EventTarget() });
    vi.resetModules();
    const rendererB = await import('../../../react/runtime/windowRuntime');
    rendererB.initializeWindowRuntime({ id: 'b', hostWindow: b, contextWindow: b, status: 'ready', events: new EventTarget() });
    expect(rendererA.getContextWindow()).toBe(a);
    expect(rendererB.getContextWindow()).toBe(b);
    rendererA.getWindowRuntime().status = 'closing';
    expect(rendererA.tryGetWindowRuntime()).toBeUndefined();
    expect(rendererB.getContextWindow()).toBe(b);
});
