/**
 * The cross-bundle seam, and the rule that the dev handlers go through it.
 *
 * `src/ui/tableTab.ts`, `src/ui/tableItemPane.ts` and the reader redirect keep
 * module-level state and are compiled into the esbuild bundle. A handler in
 * the webpack bundle that imports one of them gets a *second* copy of that
 * state, one that nothing ever writes.
 *
 * These tests fail if a handler goes back to reading module state:
 *
 * - with no namespace published, a handler must say so rather than answer from
 *   a private copy that would always look idle;
 * - with a namespace published, the handler's answer must be the namespace's.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The handler module's webpack-side dependencies, none of which these tests
// exercise. Stubbed so it can be imported outside a browser bundle.
vi.mock('../../../react/store', () => ({ store: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../react/atoms/windowSurface', () => ({ windowSurfaceAtom: {} }));
vi.mock('../../../src/ui/ui', () => ({
    BeaverUIFactory: { openBeaverWindow: vi.fn(), findBeaverWindow: vi.fn(() => null) },
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: vi.fn(() => []),
    checkLibraryExcluded: vi.fn(() => null),
}));
vi.mock('../../../src/services/artifacts/tableStore', () => ({
    createTable: vi.fn(),
    deleteTable: vi.fn(),
    editTable: vi.fn(),
    listVersions: vi.fn(),
    openTable: vi.fn(),
    readTable: vi.fn(),
    restoreShadowVersion: vi.fn(),
    restoreTable: vi.fn(),
    revertTable: vi.fn(),
    writeTable: vi.fn(),
}));
vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    isTableItem: vi.fn(() => true),
    loadTableItemFields: vi.fn(async () => undefined),
    resolveTableItem: vi.fn(),
}));

import {
    getTablesApi,
    setTablesApi,
    TABLES_API_UNAVAILABLE,
    type TablesApi,
} from '../../../src/services/artifacts/tablesApi';
import {
    handleTestOpenStoredTableHttpRequest,
    handleTestTableItemPaneHttpRequest,
} from '../../../react/hooks/httpHandlers/testTableHandlers';

const ITEM = { id: 7, key: 'TABLEKEY', libraryID: 1 };

let win: any;

/** A namespace whose answers cannot be confused with the real module's. */
function sentinelApi(overrides: Partial<TablesApi> = {}): TablesApi {
    return {
        openTable: vi.fn(async () => ({ ok: true as const })),
        itemPane: {
            isRegistered: vi.fn(() => true),
            paneID: vi.fn(() => 'sentinel-pane'),
            describe: vi.fn(async () => ({
                registered: true,
                paneID: 'sentinel-pane',
                libraryID: ITEM.libraryID,
                key: ITEM.key,
                applies: true,
                reason: null,
                fields: null,
                actions: { open: true, showInLibrary: true, restoreShadow: false },
            })),
        },
        ...overrides,
    } as unknown as TablesApi;
}

beforeEach(() => {
    vi.clearAllMocks();
    setTablesApi(null);

    win = {};
    (Zotero as any).getMainWindow = vi.fn(() => win);
    (Zotero as any).Beaver = { data: { config: { addonID: 'beaver@test' } } };
    (Zotero as any).Items = {
        getByLibraryAndKeyAsync: vi.fn(async () => ITEM),
        getAsync: vi.fn(async () => [ITEM]),
        get: vi.fn(() => ITEM),
        loadDataTypes: vi.fn(async () => undefined),
    };
    (Zotero as any).Libraries = {
        userLibraryID: 1,
        getAll: vi.fn(() => []),
        get: vi.fn(() => null),
    };
    (Zotero as any).Notifier = {
        registerObserver: vi.fn(() => 'obs'),
        unregisterObserver: vi.fn(),
    };
    (Zotero as any).Reader = { _readers: [], open: vi.fn() };
});

afterEach(() => {
    setTablesApi(null);
});

describe('the shared namespace', () => {
    it('round-trips through the Zotero global, not a module variable', () => {
        expect(getTablesApi()).toBeNull();

        const api = sentinelApi();
        setTablesApi(api);

        expect(getTablesApi()).toBe(api);
        // The global is the storage, so another bundle's copy of this module
        // would see the same object.
        expect((Zotero as any).__beaverTables).toBe(api);

        setTablesApi(null);
        expect(getTablesApi()).toBeNull();
        expect((Zotero as any).__beaverTables).toBeUndefined();
    });
});

describe('handlers report honestly when the esbuild half is not up', () => {
    it('refuses to open a stored table it cannot reach', async () => {
        const result = await handleTestOpenStoredTableHttpRequest({ key: ITEM.key });

        expect(result).toMatchObject({ ok: false, code: 'tables_api_unavailable' });
        expect((Zotero as any).Reader.open).not.toHaveBeenCalled();
    });

    it('refuses the item-pane endpoint instead of guessing at the registration', async () => {
        const result = await handleTestTableItemPaneHttpRequest({ key: ITEM.key });

        expect(result).toMatchObject({ ok: false, code: 'tables_api_unavailable' });
        // The lie this replaces: `registered: false`, which reads as "the
        // section is not up" rather than "ask the other half".
        expect(result).not.toHaveProperty('registered');
    });
});

describe('handlers read the namespace, not module state', () => {
    it('opens a stored table through the namespace', async () => {
        const api = sentinelApi();
        setTablesApi(api);

        const result = await handleTestOpenStoredTableHttpRequest({ key: ITEM.key });

        // No renderer runtime in a unit test: an originless open.
        expect(api.openTable).toHaveBeenCalledWith(
            { libraryID: ITEM.libraryID, key: ITEM.key },
            { window: null },
        );
        expect(result).toMatchObject({ ok: true, key: ITEM.key, library_id: ITEM.libraryID });
    });

    it('reports the open failure the namespace returns, rather than throwing', async () => {
        setTablesApi(
            sentinelApi({
                openTable: vi.fn(async () => ({ error: 'it has no file on disk' })),
            } as unknown as Partial<TablesApi>)
        );

        const result = await handleTestOpenStoredTableHttpRequest({ key: ITEM.key });

        expect(result).toMatchObject({ ok: false, error: 'it has no file on disk' });
    });

    it('describes the item-pane section through the namespace', async () => {
        const api = sentinelApi();
        setTablesApi(api);

        const result = await handleTestTableItemPaneHttpRequest({ key: ITEM.key });

        expect(api.itemPane.describe).toHaveBeenCalledWith({
            libraryID: ITEM.libraryID,
            key: ITEM.key,
        });
        expect(result).toMatchObject({ ok: true, pane_id: 'sentinel-pane' });
    });

    it('requires a key before it reaches the namespace at all', async () => {
        const api = sentinelApi();
        setTablesApi(api);

        await expect(handleTestOpenStoredTableHttpRequest({})).resolves.toMatchObject({
            ok: false,
            code: 'invalid_request',
        });
        expect(api.openTable).not.toHaveBeenCalled();
    });
});
