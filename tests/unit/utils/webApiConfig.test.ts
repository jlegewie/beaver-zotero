/**
 * `ZOTERO_CONFIG` is an ES module export from `resource://zotero/config.mjs`,
 * not a global. Referencing the bare name only worked in the webpack bundle,
 * which inherits a lexical binding leaked by Zotero's own chrome scripts into
 * the main window; the esbuild bundle runs in the plugin sandbox and threw
 * `ReferenceError` on every background-queue download.
 *
 * These tests pin the two properties that keep that from coming back: the
 * module is imported explicitly, and it is imported lazily so this file can be
 * loaded in an environment that has no `ChromeUtils` at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG = { API_URL: 'https://api.zotero.org/', API_VERSION: 3 };

describe('Zotero API config resolution', () => {
    let importESModule: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        importESModule = vi.fn(() => ({ ZOTERO_CONFIG: CONFIG }));
        (globalThis as any).ChromeUtils = { importESModule };
    });

    afterEach(() => {
        delete (globalThis as any).ChromeUtils;
    });

    it('does not touch ChromeUtils at import time', async () => {
        // A module-scope import would break every unit test that pulls this
        // file in transitively, and would run in the wrong realm at load.
        await import('../../../src/utils/webAPI');
        expect(importESModule).not.toHaveBeenCalled();
    });

    it('never relies on a bare ZOTERO_CONFIG global', async () => {
        const source = await import('node:fs/promises')
            .then((fs) => fs.readFile('src/utils/webAPI.ts', 'utf8'));
        // The lazy accessor names it once in a string literal and once when
        // destructuring the module namespace; nothing may read it as a global.
        expect(source).not.toMatch(/[^.'"\w]ZOTERO_CONFIG\s*\./);
    });

    it('resolves the API URL from the Zotero config module', async () => {
        const webAPI: any = await import('../../../src/utils/webAPI');
        // `getDownloadUrl` is the smallest exported path that reads the config.
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Users: { getCurrentUserID: () => 1 },
            Sync: { Data: { Local: { getAPIKey: async () => 'key' } } },
        };
        await webAPI.getDownloadUrl({
            isStoredFileAttachment: () => true,
            // `getDownloadUrl` returns early without a synced hash.
            attachmentSyncedHash: 'abc123',
            library: { isGroup: false, id: 1 },
            key: 'AAAAAAAA',
            libraryID: 1,
        }).catch(() => undefined);
        expect(importESModule).toHaveBeenCalledWith('resource://zotero/config.mjs');
    });
});
