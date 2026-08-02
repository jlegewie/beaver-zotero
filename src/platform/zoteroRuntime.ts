/**
 * Zotero implementation of the platform runtime adapter.
 *
 * Routes `debug`, preference access, and version reporting through the
 * `Zotero` global. Reads `Zotero` only inside its methods (never at import
 * time), so importing this module is safe in any context.
 *
 * Unlike the other Zotero seams, this one is installed by `src/utils/prefs.ts`
 * rather than from a bundle entry — see the comment there.
 */

import { setRuntimeAdapterIfUnset, type RuntimeAdapter } from './runtime';

/** The running Zotero's version, or an empty string when it reports none. */
function zoteroVersion(): string {
    if (typeof Zotero === 'undefined') return '';
    const { version } = Zotero;
    return version && typeof version === 'string' ? version : '';
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
    hostVersion() {
        return zoteroVersion();
    },
    getVersionHeaders() {
        const versionHeaders: Record<string, string> = {};

        const version = zoteroVersion();
        if (version) {
            versionHeaders['X-Zotero-Version'] = version;
        }

        const pluginVersion = typeof Zotero !== 'undefined' ? Zotero.Beaver?.pluginVersion : undefined;
        if (pluginVersion && typeof pluginVersion === 'string') {
            versionHeaders['X-Beaver-Version'] = pluginVersion;
        }

        return versionHeaders;
    },
};

/**
 * Install the Zotero-backed runtime adapter, unless a host already installed
 * one. Declining to overwrite keeps the outcome the same whichever order the
 * two happen in, so a non-Zotero host that reaches this module indirectly does
 * not lose its own adapter.
 */
export function registerZoteroRuntime(): void {
    setRuntimeAdapterIfUnset(zoteroAdapter);
}
