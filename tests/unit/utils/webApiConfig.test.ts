/**
 * `ZOTERO_CONFIG` is a module export, not a global. Referencing the bare name
 * only worked in the webpack bundle, which inherits a lexical binding leaked by
 * Zotero's own chrome scripts into the main window; the esbuild bundle runs in
 * the plugin sandbox and threw `ReferenceError` on every background download.
 *
 * The module's format is version-dependent: Zotero 8+ ships
 * `resource://zotero/config.mjs`, Zotero 7 only the JSM `config.js`.
 *
 * These tests pin that the module is imported explicitly, lazily (so callers
 * load without a `ChromeUtils`), and from whichever format the running Zotero
 * provides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG = { API_URL: 'https://api.zotero.org/', API_VERSION: 3, SERVICES_URL: 'https://services.zotero.org/' };

async function callGetDownloadUrl(webAPI: any): Promise<string | null> {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Users: { getCurrentUserID: () => 1 },
        Sync: { Data: { Local: { getAPIKey: async () => 'key' } } },
    };
    // `getDownloadUrl` is the smallest exported path that reads the config.
    return webAPI.getDownloadUrl({
        isStoredFileAttachment: () => true,
        // `getDownloadUrl` returns early without a synced hash.
        attachmentSyncedHash: 'abc123',
        library: { isGroup: false, id: 1 },
        key: 'AAAAAAAA',
        libraryID: 1,
    }).catch(() => null);
}

describe('Zotero API config resolution', () => {
    let importESModule: ReturnType<typeof vi.fn>;
    let jsmImport: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        importESModule = vi.fn(() => ({ ZOTERO_CONFIG: CONFIG }));
        jsmImport = vi.fn(() => ({ ZOTERO_CONFIG: CONFIG }));
        (globalThis as any).ChromeUtils = { importESModule, import: jsmImport };
    });

    afterEach(() => {
        delete (globalThis as any).ChromeUtils;
    });

    it('does not touch ChromeUtils at import time', async () => {
        // A module-scope import would break every unit test that pulls this
        // file in transitively, and would run in the wrong realm at load.
        await import('../../../src/utils/webAPI');
        expect(importESModule).not.toHaveBeenCalled();
        expect(jsmImport).not.toHaveBeenCalled();
    });

    it('never relies on a bare ZOTERO_CONFIG global', async () => {
        const fs = await import('node:fs/promises');
        for (const file of ['src/utils/webAPI.ts', 'src/utils/zoteroModules.ts', 'src/services/itemImport/zoteroApis.ts']) {
            const source = await fs.readFile(file, 'utf8');
            // Allowed: reading it off an imported module namespace (`.ZOTERO_CONFIG`).
            expect(source, file).not.toMatch(/[^.'"`\w]ZOTERO_CONFIG\s*(\.|\?\.|\[)/);
        }
    });

    it('resolves the API URL from config.mjs on Zotero 8+', async () => {
        const webAPI: any = await import('../../../src/utils/webAPI');
        await callGetDownloadUrl(webAPI);
        expect(importESModule).toHaveBeenCalledWith('resource://zotero/config.mjs');
        expect(jsmImport).not.toHaveBeenCalled();
    });

    it('falls back to the config.js JSM on Zotero 7, which has no config.mjs', async () => {
        importESModule.mockImplementation(() => {
            throw new Error('Failed to load resource://zotero/config.mjs');
        });
        const { getZoteroConfig } = await import('../../../src/utils/zoteroModules');
        expect(getZoteroConfig()).toEqual(CONFIG);
        expect(jsmImport).toHaveBeenCalledWith('resource://zotero/config.js');
    });

    it('builds a download URL on Zotero 7', async () => {
        importESModule.mockImplementation(() => {
            throw new Error('Failed to load resource://zotero/config.mjs');
        });
        const request = vi.fn(async () => ({ status: 302, responseURL: 'https://files.zotero.net/abc' }));
        const webAPI: any = await import('../../../src/utils/webAPI');
        (globalThis as any).Zotero = { ...(globalThis as any).Zotero, HTTP: { request } };
        const url = await callGetDownloadUrl(webAPI);
        expect(url).toBe('https://files.zotero.net/abc');
        expect(request).toHaveBeenCalledWith(
            'GET',
            'https://api.zotero.org/users/1/items/AAAAAAAA/file',
            { headers: { 'Zotero-API-Key': 'key', 'Zotero-API-Version': '3' } },
        );
    });

    it('rethrows the original error when neither module format is available', async () => {
        const original = new Error('Failed to load resource://zotero/config.mjs');
        importESModule.mockImplementation(() => { throw original; });
        delete (globalThis as any).ChromeUtils.import;
        const { getZoteroConfig } = await import('../../../src/utils/zoteroModules');
        expect(() => getZoteroConfig()).toThrow(original);
    });

    it('caches the resolved config', async () => {
        const { getZoteroConfig } = await import('../../../src/utils/zoteroModules');
        getZoteroConfig();
        getZoteroConfig();
        expect(importESModule).toHaveBeenCalledTimes(1);
    });
});
