/**
 * Loading Zotero's own internal modules across Zotero versions.
 *
 * Zotero 8+ ships them as ES modules (`.mjs`, loaded with
 * `ChromeUtils.importESModule`). Zotero 7 (Firefox 115) ships the same modules
 * as JSMs, loaded with `ChromeUtils.import`; their `.mjs` URLs do not exist
 * there and fail with `Failed to load <url>`. `ChromeUtils.import` is gone on
 * newer platforms, so the ES module is always tried first.
 *
 * Every import is lazy: module-scope evaluation would break unit tests, which
 * import callers without a `ChromeUtils`.
 */

export interface ZoteroModuleUrls {
    /** Zotero 8+ ES module URL. */
    esm: string;
    /** Zotero 7 JSM URL. */
    jsm: string;
}

export const ZOTERO_MODULES = {
    config: { esm: 'resource://zotero/config.mjs', jsm: 'resource://zotero/config.js' },
    epub: { esm: 'chrome://zotero/content/EPUB.mjs', jsm: 'chrome://zotero/content/EPUB.jsm' },
    hiddenBrowser: { esm: 'chrome://zotero/content/HiddenBrowser.mjs', jsm: 'chrome://zotero/content/HiddenBrowser.jsm' },
    remoteTranslate: { esm: 'chrome://zotero/content/RemoteTranslate.mjs', jsm: 'chrome://zotero/content/RemoteTranslate.jsm' },
} as const satisfies Record<string, ZoteroModuleUrls>;

/**
 * Import a Zotero module, falling back to its Zotero 7 JSM. Throws the ES
 * module error when neither format loads.
 */
export function importZoteroModule<T = any>(urls: ZoteroModuleUrls): T {
    const chromeUtils = (globalThis as any).ChromeUtils;
    try {
        return chromeUtils.importESModule(urls.esm) as T;
    } catch (esmError) {
        if (typeof chromeUtils?.import !== 'function') throw esmError;
        try {
            return chromeUtils.import(urls.jsm) as T;
        } catch {
            throw esmError;
        }
    }
}

/**
 * Zotero's build constants (`ZOTERO_CONFIG`: API, services and web URLs).
 *
 * `ZOTERO_CONFIG` is **not** a global — it is a module export, and every Zotero
 * file that wants it imports it explicitly. Referencing the bare name only
 * appears to work: Zotero's own chrome scripts bind it with a top-level `const`,
 * which lands in the main window's global *lexical* scope, and Beaver's webpack
 * bundle — injected into that window as a classic `<script>` — picks it up by
 * accident. The esbuild bundle runs in the plugin's `Cu.Sandbox`, whose globals
 * never include it.
 */
export interface ZoteroConfig {
    API_URL: string;
    API_VERSION: number | string;
    SERVICES_URL?: string;
    [key: string]: unknown;
}

let cachedConfig: ZoteroConfig | null = null;

export function getZoteroConfig(): ZoteroConfig {
    if (cachedConfig) return cachedConfig;
    const config = importZoteroModule<{ ZOTERO_CONFIG?: ZoteroConfig }>(ZOTERO_MODULES.config).ZOTERO_CONFIG;
    if (!config?.API_URL) {
        throw new Error('Zotero config module exports no API_URL');
    }
    cachedConfig = config;
    return config;
}
