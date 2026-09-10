import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverInstance } from '../../../src/runtime/instance';

vi.mock('../../../react/atoms/models', () => ({ isUsingBeaverCreditsAtom: {} }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn() }));

function makeWindow() {
    return { EventTarget, CustomEvent, closed: false } as unknown as Window;
}

/** A frame window the way a reader tab's chrome window appears to the plugin. */
function makeFrameWindow(embedder: Window | undefined) {
    return {
        closed: false,
        browsingContext: embedder ? { embedderElement: { ownerGlobal: embedder } } : undefined,
    } as unknown as Window;
}

beforeEach(() => {
    vi.clearAllMocks();
    Zotero.__beaverShuttingDown = false;
    (Zotero as any).Reader = { onChangeSidebarWidth: null };
});

describe('window runtime lifetimes', () => {
    it('offers optional lookup for late callbacks while keeping required lookup strict', async () => {
        vi.resetModules();
        const accessor = await import('../../../react/runtime/windowRuntime');
        expect(accessor.tryGetWindowRuntime()).toBeUndefined();
        expect(() => accessor.getWindowRuntime()).toThrow('Window runtime unavailable');
        const instance = new BeaverInstance();
        const runtime = instance.attachWindow(makeWindow());
        accessor.initializeWindowRuntime(runtime);
        expect(accessor.tryGetWindowRuntime()).toBe(runtime);
        runtime.status = 'ready';
        expect(accessor.getWindowRuntime()).toBe(runtime);
        instance.detachWindow(runtime.hostWindow);
        expect(accessor.tryGetWindowRuntime()).toBeUndefined();
        expect(() => accessor.getWindowRuntime()).toThrow('Window runtime unavailable');
    });

    it('attaches once, drops window slots on detach and never reuses an id', () => {
        const instance = new BeaverInstance();
        const win = makeWindow();
        const first = instance.attachWindow(win);
        expect(instance.attachWindow(win)).toBe(first);
        expect(first.contextWindow).toBe(win);
        expect(first.hostWindow).toBe(win);
        instance.detachWindow(win);
        instance.detachWindow(win);
        expect(first.status).toBe('closing');
        expect(win.__beaverRuntime).toBeUndefined();
        expect(win.__beaverJotaiStore).toBeUndefined();
        expect(instance.attachWindow(win).id).not.toBe(first.id);
        instance.disposeInstance();
        instance.disposeInstance();
        expect(instance.getSnapshot()).toEqual([]);
        expect(() => instance.attachWindow(makeWindow())).toThrow('disposed');
    });

    it('broadcasts to both subscribers and invalidates closing callbacks synchronously', () => {
        const instance = new BeaverInstance();
        const a = instance.attachWindow(makeWindow());
        const b = instance.attachWindow(makeWindow());
        const first = vi.fn(detail => { detail.running = false; });
        const second = vi.fn();
        instance.subscribeWindow(a, 'status', first);
        const unsubscribe = instance.subscribeWindow(b, 'status', second);
        const input = { running: true };
        instance.publish('status', input);
        expect(input.running).toBe(true);
        expect(second).toHaveBeenLastCalledWith({ running: true });
        instance.markClosing(a.hostWindow);
        instance.publish('status', input);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
        unsubscribe();
        instance.publish('status', input);
        expect(second).toHaveBeenCalledTimes(2);
    });

    it('does not notify renderers when services stop during application shutdown', () => {
        const instance = new BeaverInstance();
        const runtime = instance.attachWindow(makeWindow());
        const listener = vi.fn();
        instance.subscribeWindow(runtime, 'background-worker:status', listener);
        Zotero.__beaverShuttingDown = true;
        instance.publish('background-worker:status', { running: false });
        expect(listener).not.toHaveBeenCalled();
    });

    it('resolves a frame inside a main window to that window, and refuses unowned or unusable frames', () => {
        const instance = new BeaverInstance();
        const win = makeWindow();
        const runtime = instance.attachWindow(win);
        runtime.status = 'ready';
        const readerFrame = makeFrameWindow(win);
        const viewFrame = makeFrameWindow(readerFrame);

        expect(instance.resolveWindowFrom(win)).toBe(runtime);
        expect(instance.resolveWindowFrom(readerFrame)).toBe(runtime);
        expect(instance.resolveWindowFrom(viewFrame)).toBe(runtime);
        expect(instance.resolveWindowFrom(undefined)).toBeUndefined();
        // A standalone reader window is a chrome window Beaver never attached to.
        expect(instance.resolveWindowFrom(makeFrameWindow(makeWindow()))).toBeUndefined();

        runtime.status = 'attaching';
        expect(instance.resolveWindowFrom(readerFrame)).toBeUndefined();
        runtime.status = 'ready';
        instance.markClosing(win);
        expect(instance.resolveWindowFrom(readerFrame)).toBeUndefined();
    });

    it('keeps one reader wrapper when either window closes and restores the original on disposal', () => {
        const original = vi.fn();
        Zotero.Reader.onChangeSidebarWidth = original;
        const instance = new BeaverInstance();
        const a = instance.attachWindow(makeWindow());
        const b = instance.attachWindow(makeWindow());
        const first = vi.fn(), second = vi.fn();
        instance.subscribeReaderWidth(a, first);
        const wrapper = Zotero.Reader.onChangeSidebarWidth;
        instance.subscribeReaderWidth(b, second);
        expect(Zotero.Reader.onChangeSidebarWidth).toBe(wrapper);
        wrapper(300);
        expect(original).toHaveBeenCalledWith(300);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        instance.detachWindow(a.hostWindow);
        wrapper(301);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
        instance.detachWindow(b.hostWindow);
        expect(Zotero.Reader.onChangeSidebarWidth).toBe(wrapper);
        instance.disposeInstance();
        expect(Zotero.Reader.onChangeSidebarWidth).toBe(original);
        wrapper(302);
        expect(second).toHaveBeenCalledTimes(2);
    });
});

describe('independently evaluated renderer modules', () => {
    async function loadRenderer(win: Window, instance: BeaverInstance) {
        vi.resetModules();
        const runtime = await import('../../../react/runtime/windowRuntime');
        runtime.initializeWindowRuntime(instance.attachWindow(win));
        const { store } = await import('../../../react/store');
        const { isSidebarVisibleAtom } = await import('../../../react/atoms/ui');
        const { eventManager } = await import('../../../react/events/eventManager');
        return { store, isSidebarVisibleAtom, eventManager };
    }

    it('uses distinct stores and atom identities, with one store for surfaces in each renderer', async () => {
        const instance = new BeaverInstance();
        const a = await loadRenderer(makeWindow(), instance);
        const sameRenderer = await import('../../../react/store');
        expect(a.store).toBe(sameRenderer.store);
        const b = await loadRenderer(makeWindow(), instance);
        expect(a.store).not.toBe(b.store);
        expect(a.isSidebarVisibleAtom).not.toBe(b.isSidebarVisibleAtom);
        a.store.set(a.isSidebarVisibleAtom, true);
        expect(a.store.get(a.isSidebarVisibleAtom)).toBe(true);
        expect(b.store.get(b.isSidebarVisibleAtom)).toBe(false);
    });

    it('pins event subscriptions and dispatch to the renderer despite focus changes', async () => {
        const instance = new BeaverInstance();
        const winA = makeWindow(), winB = makeWindow();
        const a = await loadRenderer(winA, instance);
        const b = await loadRenderer(winB, instance);
        const onA = vi.fn(), onB = vi.fn();
        a.eventManager.subscribe('toggleChat', onA);
        b.eventManager.subscribe('toggleChat', onB);
        vi.mocked(Zotero.getMainWindow).mockReturnValue(winB as any);
        a.eventManager.dispatch('toggleChat', {});
        expect(onA).toHaveBeenCalledOnce();
        expect(onB).not.toHaveBeenCalled();
        b.eventManager.dispatch('toggleChat', {});
        expect(onB).toHaveBeenCalledOnce();
        instance.markClosing(winA);
        a.eventManager.dispatch('toggleChat', {}, winA);
        expect(onA).toHaveBeenCalledOnce();
    });
});

describe('window-owned global endpoints', () => {
    const path = '/beaver/test/window-runtime';
    beforeEach(() => { (Zotero as any).Server = { Endpoints: {} }; });

    it.each(['first', 'last'])('keeps a live handler when the %s registrant closes', (closing) => {
        const instance = new BeaverInstance();
        const a = instance.attachWindow(makeWindow());
        const b = instance.attachWindow(makeWindow());
        const handlerA = vi.fn(), handlerB = vi.fn();
        const releaseA = instance.registerWindowEndpoint(a, path, handlerA);
        const releaseB = instance.registerWindowEndpoint(b, path, handlerB);
        expect(Zotero.Server.Endpoints[path]).toBe(handlerB);
        const [closed, surviving, handler] = closing === 'first' ? [a, b, handlerB] : [b, a, handlerA];
        instance.markClosing(closed.hostWindow);
        (closing === 'first' ? releaseA : releaseB)();
        expect(Zotero.Server.Endpoints[path]).toBe(handler);
        instance.detachWindow(surviving.hostWindow);
        releaseA();
        releaseB();
        expect(Zotero.Server.Endpoints[path]).toBeUndefined();
    });

    it('transfers ownership on auth cleanup and ignores obsolete cleanup after re-registration', () => {
        const instance = new BeaverInstance();
        const a = instance.attachWindow(makeWindow());
        const b = instance.attachWindow(makeWindow());
        const handlerA = vi.fn(), handlerB = vi.fn(), replacement = vi.fn();
        const oldRelease = instance.registerWindowEndpoint(a, path, handlerA);
        instance.registerWindowEndpoint(a, path, replacement);
        oldRelease();
        const signOut = instance.registerWindowEndpoint(b, path, handlerB);
        signOut();
        expect(Zotero.Server.Endpoints[path]).toBe(replacement);
        instance.disposeInstance();
        expect(Zotero.Server.Endpoints[path]).toBeUndefined();
    });

    it('does not delete an externally replaced handler or accept stale runtimes', () => {
        const instance = new BeaverInstance();
        const runtime = instance.attachWindow(makeWindow());
        instance.registerWindowEndpoint(runtime, path, vi.fn());
        const external = vi.fn();
        Zotero.Server.Endpoints[path] = external;
        instance.detachWindow(runtime.hostWindow);
        instance.registerWindowEndpoint(runtime, path, vi.fn());
        expect(Zotero.Server.Endpoints[path]).toBe(external);
    });
});
