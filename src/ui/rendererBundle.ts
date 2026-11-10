/**
 * Loads a window's own copy of the React bundle and binds it to the window's
 * runtime: the start every Beaver renderer shares (main windows, the separate
 * Beaver window, table windows). What it mounts afterwards is the caller's.
 */

import type { WindowRuntime } from '../runtime/instance';

const REACT_BUNDLE_URL = 'chrome://beaver/content/reactBundle.js';

type RendererWindow = Window & { BeaverReact?: { initializeRuntime?(runtime: WindowRuntime): void } };

/**
 * Appends the bundle's script to `win`. Once it loads, and only while `runtime`
 * is still the window's live runtime, initializes the runtime and calls
 * `onReady`. `onFailure` gets a load that failed, a bundle without the
 * renderer API, or whatever `onReady` throws; a window whose runtime changed
 * or closed meanwhile gets neither.
 */
export function loadRendererBundle(
    win: Window,
    runtime: WindowRuntime | undefined,
    onReady: () => void,
    onFailure: (error?: unknown) => void,
): void {
    const current = () => !!runtime && runtime.status !== 'closing' && win.__beaverRuntime === runtime && !win.closed;
    const script = win.document.createElement('script');
    script.type = 'text/javascript';
    script.src = REACT_BUNDLE_URL;
    script.onload = () => {
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
    script.onerror = () => {
        if (win.__beaverRuntime === runtime) onFailure();
    };
    win.document.documentElement.appendChild(script);
}
