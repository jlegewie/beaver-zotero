/**
 * Platform runtime abstraction.
 *
 * Lets shared modules (logger, prefs) access logging and preferences without a
 * hard dependency on the `Zotero` global. Shared code can inject a different
 * adapter via `setRuntimeAdapter` when it runs outside the Zotero plugin host.
 *
 * The default adapter is Zotero-backed. It references the `Zotero` global only
 * inside its methods (never at import time), so importing this module is safe in
 * any context; callers can replace the adapter before first use.
 *
 * Must stay free of `react/*` imports so it is safe in both the esbuild and
 * webpack bundles.
 */

export interface RuntimeAdapter {
    /** Write a debug message to the host log. Mirrors `Zotero.debug`. */
    debug(message: string, level?: number, maxDepth?: number, stack?: number | boolean): void;
    /** Whether the host is running a development build. */
    isDevelopment(): boolean;
    /** Read a fully-qualified preference key. */
    getPref(key: string): unknown;
    /** Write a fully-qualified preference key. */
    setPref(key: string, value: unknown): void;
    /** Clear a fully-qualified preference key. */
    clearPref(key: string): void;
    /**
     * Version identifiers to attach to outgoing backend requests, keyed by header
     * name (e.g. `X-Zotero-Version`). Optional: hosts with nothing to report can
     * omit it, and callers should treat a missing implementation the same as one
     * that returns no headers.
     */
    getVersionHeaders?(): Record<string, string>;
}

const zoteroAdapter: RuntimeAdapter = {
    debug(message, level, maxDepth, stack) {
        Zotero.debug(message, level as any, maxDepth as any, stack as any);
    },
    isDevelopment() {
        return "Beaver" in Zotero && (Zotero as any).Beaver.data.env === "development";
    },
    getPref(key) {
        return Zotero.Prefs.get(key, true);
    },
    setPref(key, value) {
        Zotero.Prefs.set(key, value as any, true);
    },
    clearPref(key) {
        Zotero.Prefs.clear(key, true);
    },
    getVersionHeaders() {
        const versionHeaders: Record<string, string> = {};

        if (typeof Zotero !== 'undefined') {
            const { version, Beaver } = Zotero;
            if (version && typeof version === 'string') {
                versionHeaders['X-Zotero-Version'] = version;
            }
            const pluginVersion = Beaver?.pluginVersion;
            if (pluginVersion && typeof pluginVersion === 'string') {
                versionHeaders['X-Beaver-Version'] = pluginVersion;
            }
        }

        return versionHeaders;
    },
};

let adapter: RuntimeAdapter = zoteroAdapter;

/** Replace the runtime adapter before shared code reads host services. */
export function setRuntimeAdapter(next: RuntimeAdapter): void {
    adapter = next;
}

/** The active runtime adapter. */
export function getRuntimeAdapter(): RuntimeAdapter {
    return adapter;
}
