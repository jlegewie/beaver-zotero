/**
 * Loads a window's own copy of the React bundle and binds it to the window's
 * runtime: the start every Beaver renderer shares (main windows, the separate
 * Beaver window, table windows). What it mounts afterwards is the caller's.
 *
 * The bundle is compiled once, off the main thread, and the compiled script
 * runs in each renderer window. Compiling is most of the cost of opening a
 * window; with a `<script>` tag every window would compile the bundle again.
 * The compiled script belongs to the plugin realm and holds no window, so a
 * closed window leaves nothing behind; a plugin reload compiles it again.
 */

import type { WindowRuntime } from '../runtime/instance';

const REACT_BUNDLE_URL = 'chrome://beaver/content/reactBundle.js';

type RendererWindow = Window & { BeaverReact?: { initializeRuntime?(runtime: WindowRuntime): void } };

let compiledBundle: Promise<PrecompiledScript | null> | null = null;

/**
 * Starts compiling the bundle unless it already has. Resolves to the compiled
 * script, or to null when compiling failed: the window then loads the bundle
 * with a script tag, and the next window tries compiling again. Returns null
 * where scripts cannot be compiled ahead at all.
 */
export function prepareRendererBundle(): Promise<PrecompiledScript | null> | null {
    if (compiledBundle) return compiledBundle;
    if (typeof ChromeUtils.compileScript !== 'function') return null;
    compiledBundle = ChromeUtils.compileScript(REACT_BUNDLE_URL, { hasReturnValue: false }).catch(() => {
        compiledBundle = null;
        return null;
    });
    return compiledBundle;
}

/**
 * Runs the bundle in `win`. Once it has run, and only while `runtime` is
 * still the window's live runtime, initializes the runtime and calls
 * `onReady`. `onFailure` gets a load that failed, a bundle that threw or
 * lacks the renderer API, or whatever `onReady` throws; a window whose
 * runtime changed or closed meanwhile gets neither.
 */
export function loadRendererBundle(
    win: Window,
    runtime: WindowRuntime | undefined,
    onReady: () => void,
    onFailure: (error?: unknown) => void,
): void {
    const current = () => !!runtime && runtime.status !== 'closing' && win.__beaverRuntime === runtime && !win.closed;
    const start = () => {
        if (!current()) return;
        try {
            const renderer = (win as RendererWindow).BeaverReact;
            if (!renderer?.initializeRuntime) throw new Error('Beaver renderer API unavailable');
            renderer.initializeRuntime(runtime!);
            onReady();
        } catch (error) {
            onFailure(error);
        }
    };

    const compilation = prepareRendererBundle();
    if (!compilation) {
        appendBundleScript(win, runtime, start, onFailure);
        return;
    }
    void compilation.then((script) => {
        if (!current()) return;
        // The script tag reports a bundle that cannot be read at all.
        if (!script) {
            appendBundleScript(win, runtime, start, onFailure);
            return;
        }
        try {
            script.executeInGlobal(win);
        } catch (error) {
            onFailure(error);
            return;
        }
        start();
    });
}

/** Loads the bundle with a script tag, which compiles it for this window alone. */
function appendBundleScript(
    win: Window,
    runtime: WindowRuntime | undefined,
    onLoad: () => void,
    onFailure: (error?: unknown) => void,
): void {
    const script = win.document.createElement('script');
    script.type = 'text/javascript';
    script.src = REACT_BUNDLE_URL;
    script.onload = onLoad;
    script.onerror = () => {
        if (win.__beaverRuntime === runtime) onFailure();
    };
    win.document.documentElement.appendChild(script);
}
