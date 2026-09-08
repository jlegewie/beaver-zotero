/**
 * The cross-bundle seam, and the rule that the dev handlers go through it.
 *
 * `view/readerTableView.ts` and `src/ui/tableItemPane.ts` keep module-level
 * state and are compiled into the esbuild bundle. A handler in the webpack
 * bundle that imports one of them gets a *second* copy of that state — one
 * that nothing ever writes — and then reports an empty view list for readers
 * that are demonstrably enhanced.
 *
 * These tests fail if a handler goes back to reading module state:
 *
 * - with no namespace published, a handler must say so rather than answer from
 *   a private copy that would always look idle;
 * - with a namespace published, the handler's answer must be the namespace's,
 *   even while the *real* reader registry in this module instance is holding a
 *   different answer in its own module state.
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
// The real reader host needs these two to reach a document without a Zotero.
vi.mock('../../../src/services/artifacts/view/enhanceTableDocument', () => ({
    enhanceTableDocument: vi.fn(() => vi.fn()),
    countCitationMarkers: vi.fn(() => 3),
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
    handleTestTableViewStateHttpRequest,
} from '../../../react/hooks/httpHandlers/testTableHandlers';
// The real reader host, deliberately not mocked: these tests need its module
// state to exist and to disagree with the namespace.
import {
    cleanupReaderTableViews,
    listReaderTableViews,
    openTableInReader,
} from '../../../src/services/artifacts/view/readerTableView';

const ITEM = { id: 7, key: 'TABLEKEY', libraryID: 1 };

/** A reader shaped enough for the real host to enhance it. */
function fakeReader(win: any, itemID: number): any {
    const doc = {
        documentURI: 'about:srcdoc',
        readyState: 'complete',
        documentElement: { getAttribute: () => '1' },
        querySelectorAll: () => ({ length: 0 }),
    };
    return {
        type: 'snapshot',
        itemID,
        tabID: `real-tab-${itemID}`,
        _window: win,
        _internalReader: {
            // The live state the host reads before locking it.
            _state: { readOnly: false },
            setReadOnly: vi.fn(),
            _primaryView: {
                initializedPromise: Promise.resolve(),
                initialized: true,
                iframeDocument: doc,
                _iframe: {
                    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
                },
            },
        },
        _iframe: {
            parentElement: {},
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        },
    };
}

let win: any;
let readers: any[];

/** A namespace whose answers cannot be confused with the real module's. */
function sentinelApi(overrides: Partial<TablesApi> = {}): TablesApi {
    return {
        openTable: vi.fn(async () => ({ ok: true as const })),
        listViews: vi.fn(() => [
            { id: 'sentinel-view', key: 'SENTINEL', markers: 99 },
        ]),
        openInReader: vi.fn(),
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
    cleanupReaderTableViews();
    setTablesApi(null);

    readers = [];
    win = {};
    (Zotero as any).getMainWindow = vi.fn(() => win);
    (Zotero as any).Beaver = { data: { config: { addonID: 'beaver@test' } } };
    (Zotero as any).Items = {
        getByLibraryAndKey: vi.fn(() => ITEM),
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
    (Zotero as any).Reader = {
        _readers: readers,
        open: vi.fn(async (itemID: number) => {
            readers.push(fakeReader(win, itemID));
        }),
    };
});

afterEach(() => {
    cleanupReaderTableViews();
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
    it('refuses the view-state endpoint rather than reporting an empty registry', async () => {
        const result = await handleTestTableViewStateHttpRequest();

        expect(result).toMatchObject({ ok: false, code: 'tables_api_unavailable' });
        expect(result.error).toBe(TABLES_API_UNAVAILABLE);
        // An empty `views: []` here would look exactly like "no tables open".
        expect(result).not.toHaveProperty('views');
    });

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
    it('lists the namespace views even while the real registry holds others', async () => {
        // A real enhancement, in this module instance, with its own registry.
        const diagnostics = await openTableInReader(ITEM as unknown as Zotero.Item);
        expect(diagnostics.enhanced).toBe(true);
        expect(listReaderTableViews()).toEqual([
            { id: 'real-tab-7', key: ITEM.key, markers: 3 },
        ]);

        setTablesApi(sentinelApi());

        const result = await handleTestTableViewStateHttpRequest();

        // Every field would differ if the handler had read its own copy.
        expect(result).toMatchObject({ ok: true });
        expect(result.views).toEqual([
            { id: 'sentinel-view', key: 'SENTINEL', markers: 99 },
        ]);
    });

    it('opens a stored table through the namespace', async () => {
        const api = sentinelApi();
        setTablesApi(api);

        const result = await handleTestOpenStoredTableHttpRequest({ key: ITEM.key });

        expect(api.openTable).toHaveBeenCalledWith({
            libraryID: ITEM.libraryID,
            key: ITEM.key,
        });
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
