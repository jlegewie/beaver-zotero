/**
 * Platform runtime abstraction.
 *
 * Lets shared modules access logging, preferences, and host version reporting
 * without a hard dependency on the `Zotero` global. A host installs its own
 * adapter via `setRuntimeAdapter` before shared code reads host services; the Zotero
 * plugin's adapter lives in `zoteroRuntime.ts` and is installed as a side
 * effect of importing `src/utils/prefs.ts` (see the comment there for why it
 * is not registered from the bundle entries like the other host seams).
 *
 * Must stay free of `react/*` imports and the `Zotero` global so it is safe in
 * both the esbuild and webpack bundles, and so it can typecheck standalone
 * outside the Zotero plugin host.
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
     * Read a Beaver preference by its *unqualified* key, letting the host apply
     * its own preference namespace. Lets shared code carry a user-configurable
     * setting without knowing how the host namespaces preferences.
     *
     * Optional: a host with no preference store omits it. Callers must treat a
     * missing implementation, and any value they cannot use, the same as
     * "unset" and fall back to their own default — so this seam is only for
     * settings that have one.
     */
    getPluginPref?(key: string): unknown;
    /**
     * The host application's own version (e.g. the Zotero version), or an empty
     * string when the host has none to report.
     */
    hostVersion?(): string;
    /**
     * Version identifiers to attach to outgoing backend requests, keyed by header
     * name (e.g. `X-Zotero-Version`). Optional: hosts with nothing to report can
     * omit it, and callers should treat a missing implementation the same as one
     * that returns no headers.
     */
    getVersionHeaders?(): Record<string, string>;
}

/**
 * Installed before any host registers its own adapter. `debug` and
 * `isDevelopment` degrade silently — no host to log to is a normal state, not
 * an error. `getPref`/`setPref`/`clearPref` throw instead of degrading: a
 * caller reaching these without a registered host would otherwise read back
 * `undefined` and have writes silently discarded, which is a worse failure
 * mode (a wrong default, or a lost user preference) than an immediate error at
 * the source. `getPluginPref`/`hostVersion`/`getVersionHeaders` are left off
 * entirely, since all three are optional.
 */
const unregisteredAdapter: RuntimeAdapter = {
    debug() {},
    isDevelopment() {
        return false;
    },
    getPref(key) {
        throw new Error(`No runtime adapter registered; cannot read preference "${key}".`);
    },
    setPref(key) {
        throw new Error(`No runtime adapter registered; cannot write preference "${key}".`);
    },
    clearPref(key) {
        throw new Error(`No runtime adapter registered; cannot clear preference "${key}".`);
    },
};

let adapter: RuntimeAdapter = unregisteredAdapter;

/** Replace the runtime adapter before shared code reads host services. */
export function setRuntimeAdapter(next: RuntimeAdapter): void {
    adapter = next;
}

/**
 * Install an adapter only if no host has installed one yet. Lets a host-specific
 * module that a client may reach indirectly supply its adapter without
 * overwriting the one that client already chose. Derived from the active
 * adapter rather than a separate flag, so restoring the unregistered adapter
 * re-arms it.
 */
export function setRuntimeAdapterIfUnset(next: RuntimeAdapter): void {
    if (adapter !== unregisteredAdapter) return;
    adapter = next;
}

/** The active runtime adapter. */
export function getRuntimeAdapter(): RuntimeAdapter {
    return adapter;
}
