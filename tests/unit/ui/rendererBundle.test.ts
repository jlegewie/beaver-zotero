// @vitest-environment jsdom
/**
 * The renderer bundle loader: one compilation shared by every window, the
 * compiled script run in each window, and the script tag when the bundle
 * cannot be compiled ahead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUNDLE_URL = 'chrome://beaver/content/reactBundle.js';

interface FakeWindow {
    win: any;
    runtime: any;
}

function fakeWindow(): FakeWindow {
    const doc = document.implementation.createHTMLDocument('renderer');
    const runtime = { status: 'attaching' };
    const win: any = { closed: false, document: doc, __beaverRuntime: runtime };
    return { win, runtime };
}

/** A compiled bundle whose run defines the renderer API on the window it runs in. */
function compiledScript() {
    return {
        executeInGlobal: vi.fn((global: any) => {
            global.BeaverReact = { initializeRuntime: vi.fn() };
        }),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function loader() {
    vi.resetModules();
    return import('../../../src/ui/rendererBundle');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('loadRendererBundle', () => {
    it('compiles the bundle once and runs it in every window', async () => {
        const windows = [fakeWindow(), fakeWindow()];
        const script = compiledScript();
        const compileScript = vi.fn(async () => script);
        (globalThis as any).ChromeUtils = { compileScript };
        const { loadRendererBundle } = await loader();

        const ready = windows.map(() => vi.fn());
        const failed = vi.fn();
        windows.forEach((fake, i) => loadRendererBundle(fake.win, fake.runtime, ready[i], failed));
        await flush();

        expect(compileScript).toHaveBeenCalledTimes(1);
        expect(compileScript).toHaveBeenCalledWith(BUNDLE_URL, { hasReturnValue: false });
        expect(script.executeInGlobal.mock.calls.map(([global]) => global)).toEqual(windows.map((f) => f.win));
        windows.forEach((fake, i) => {
            expect(fake.win.BeaverReact.initializeRuntime).toHaveBeenCalledWith(fake.runtime);
            expect(ready[i]).toHaveBeenCalledTimes(1);
            expect(fake.win.document.querySelector('script')).toBeNull();
        });
        expect(failed).not.toHaveBeenCalled();
    });

    it('reuses a compilation started ahead of the first window', async () => {
        const fake = fakeWindow();
        const compileScript = vi.fn(async () => compiledScript());
        (globalThis as any).ChromeUtils = { compileScript };
        const { loadRendererBundle, prepareRendererBundle } = await loader();

        void prepareRendererBundle();
        expect(compileScript).toHaveBeenCalledTimes(1);
        const ready = vi.fn();
        loadRendererBundle(fake.win, fake.runtime, ready, vi.fn());
        await flush();

        expect(compileScript).toHaveBeenCalledTimes(1);
        expect(ready).toHaveBeenCalledTimes(1);
    });

    it('runs nothing in a window that closed or changed runtime while the bundle compiled', async () => {
        const closed = fakeWindow();
        const replaced = fakeWindow();
        const compilation = deferred<any>();
        const script = compiledScript();
        (globalThis as any).ChromeUtils = { compileScript: vi.fn(() => compilation.promise) };
        const { loadRendererBundle } = await loader();

        const ready = vi.fn();
        const failed = vi.fn();
        loadRendererBundle(closed.win, closed.runtime, ready, failed);
        loadRendererBundle(replaced.win, replaced.runtime, ready, failed);
        closed.win.closed = true;
        replaced.win.__beaverRuntime = { status: 'attaching' };
        compilation.resolve(script);
        await flush();

        expect(script.executeInGlobal).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
    });

    it('reports a bundle that throws as it runs, without a script tag', async () => {
        const fake = fakeWindow();
        const error = new Error('bundle threw');
        (globalThis as any).ChromeUtils = {
            compileScript: vi.fn(async () => ({ executeInGlobal: vi.fn(() => { throw error; }) })),
        };
        const { loadRendererBundle } = await loader();

        const ready = vi.fn();
        const failed = vi.fn();
        loadRendererBundle(fake.win, fake.runtime, ready, failed);
        await flush();

        expect(failed).toHaveBeenCalledWith(error);
        expect(ready).not.toHaveBeenCalled();
        expect(fake.win.document.querySelector('script')).toBeNull();
    });

    it('reports a bundle without the renderer API', async () => {
        const fake = fakeWindow();
        (globalThis as any).ChromeUtils = { compileScript: vi.fn(async () => ({ executeInGlobal: vi.fn() })) };
        const { loadRendererBundle } = await loader();

        const failed = vi.fn();
        loadRendererBundle(fake.win, fake.runtime, vi.fn(), failed);
        await flush();

        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Beaver renderer API unavailable' }));
    });

    it('falls back to the script tag when the bundle cannot be compiled, and compiles again for the next window', async () => {
        const first = fakeWindow();
        const second = fakeWindow();
        const script = compiledScript();
        const compileScript = vi.fn()
            .mockImplementationOnce(() => Promise.reject(new Error('compile failed')))
            .mockImplementationOnce(async () => script);
        (globalThis as any).ChromeUtils = { compileScript };
        const { loadRendererBundle } = await loader();

        const ready = vi.fn();
        const failed = vi.fn();
        loadRendererBundle(first.win, first.runtime, ready, failed);
        await flush();

        const tag = first.win.document.querySelector('script') as HTMLScriptElement;
        expect(tag?.getAttribute('src')).toBe(BUNDLE_URL);
        first.win.BeaverReact = { initializeRuntime: vi.fn() };
        tag.onload?.(new Event('load'));
        expect(first.win.BeaverReact.initializeRuntime).toHaveBeenCalledWith(first.runtime);
        expect(ready).toHaveBeenCalledTimes(1);

        loadRendererBundle(second.win, second.runtime, ready, failed);
        await flush();
        expect(compileScript).toHaveBeenCalledTimes(2);
        expect(script.executeInGlobal).toHaveBeenCalledWith(second.win);
        expect(ready).toHaveBeenCalledTimes(2);
        expect(failed).not.toHaveBeenCalled();
    });

    it('loads the bundle with a script tag where scripts cannot be compiled ahead', async () => {
        const fake = fakeWindow();
        (globalThis as any).ChromeUtils = {};
        const { loadRendererBundle, prepareRendererBundle } = await loader();

        expect(prepareRendererBundle()).toBeNull();
        const failed = vi.fn();
        loadRendererBundle(fake.win, fake.runtime, vi.fn(), failed);
        const tag = fake.win.document.querySelector('script') as HTMLScriptElement;
        expect(tag?.getAttribute('src')).toBe(BUNDLE_URL);

        tag.onerror?.(new Event('error'));
        expect(failed).toHaveBeenCalledWith();
    });
});
