/**
 * The cross-bundle seam, and the rule that the dev handlers go through it.
 *
 * `src/ui/tableTab.ts`, `src/ui/tableDoubleClick.ts` and `readerTableView.ts`
 * keep module-level state and are compiled into the esbuild bundle. A handler
 * in the webpack bundle that imports one of them gets a *second* copy of that
 * state — one that nothing ever writes — and then reports `installed: false`
 * about a `ZoteroPane` that is demonstrably wrapped.
 *
 * These tests fail if a handler goes back to reading module state:
 *
 * - with no namespace published, a handler must say so rather than answer from
 *   a private copy that would always look idle;
 * - with a namespace published, the handler's answer must be the namespace's,
 *   even while a *real* guard is installed and holding a different answer in
 *   its own module state.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const getPref = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/prefs', () => ({
    getPref,
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

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

import {
    getTablesApi,
    setTablesApi,
    TABLES_API_UNAVAILABLE,
    type TablesApi,
} from '../../../src/services/artifacts/tablesApi';
import {
    handleTestCloseTableTabHttpRequest,
    handleTestTableDoubleClickHttpRequest,
    handleTestTableViewStateHttpRequest,
} from '../../../react/hooks/httpHandlers/testTableHandlers';
// The real guard, deliberately not mocked: these tests need its module state to
// exist and to disagree with the namespace.
import {
    cleanupTableDoubleClick,
    installTableDoubleClick,
    isTableDoubleClickInstalled,
    lastTableDoubleClick,
    warmTableItems,
} from '../../../src/ui/tableDoubleClick';

/**
 * Shaped enough for the real guard's `isTableItem` to classify it without
 * throwing. It classifies as *not* a table, which is fine: what this fixture
 * has to produce is real module state that disagrees with the namespace.
 */
const ITEM = {
    id: 7,
    key: 'TABLEKEY',
    libraryID: 1,
    isAttachment: () => false,
    isTopLevelItem: () => true,
    hasTag: () => false,
    getField: () => '',
};

let pane: any;
let win: any;

/** A namespace whose answers cannot be confused with the real module's. */
function sentinelApi(overrides: Partial<TablesApi> = {}): TablesApi {
    return {
        openTable: vi.fn(async () => ({ opened: 'tab' as const })),
        resolveTableTarget: vi.fn(() => 'tab' as const),
        openSpecInTab: vi.fn(() => 'sentinel-tab'),
        closeTab: vi.fn(),
        listViews: vi.fn(() => [
            { host: 'tab' as const, id: 'sentinel-view', key: 'SENTINEL', markers: 99 },
        ]),
        openInReader: vi.fn(),
        doubleClick: {
            isInstalled: vi.fn(() => true),
            last: vi.fn(() => ({
                at: '2026-01-01T00:00:00.000Z',
                handler: 'viewItems' as const,
                path: 'beaver' as const,
                reason: 'table' as const,
                itemID: ITEM.id,
                key: ITEM.key,
                libraryID: ITEM.libraryID,
                opened: 'tab' as const,
            })),
            warm: vi.fn(async () => 1),
            settled: vi.fn(async () => undefined),
        },
        ...overrides,
    } as TablesApi;
}

beforeEach(() => {
    vi.clearAllMocks();
    cleanupTableDoubleClick();
    setTablesApi(null);
    getPref.mockReturnValue(true);

    pane = { viewItems: vi.fn().mockResolvedValue(undefined), viewAttachment: vi.fn() };
    win = { ZoteroPane: pane };
    (Zotero as any).getMainWindow = vi.fn(() => win);
    (Zotero as any).Items = {
        getByLibraryAndKey: vi.fn(() => ITEM),
        getAsync: vi.fn(async () => [ITEM]),
        get: vi.fn(() => ITEM),
        loadDataTypes: vi.fn(async () => undefined),
    };
    (Zotero as any).Libraries = { userLibraryID: 1, getAll: vi.fn(() => []), get: vi.fn(() => null) };
    (Zotero as any).Notifier = {
        registerObserver: vi.fn(() => 'obs'),
        unregisterObserver: vi.fn(),
    };
});

afterEach(() => {
    cleanupTableDoubleClick();
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
    it('refuses the double-click endpoint instead of answering from a private copy', async () => {
        const result = await handleTestTableDoubleClickHttpRequest({ key: ITEM.key });

        expect(result).toMatchObject({ ok: false, code: 'tables_api_unavailable' });
        expect(result.error).toBe(TABLES_API_UNAVAILABLE);
        // The lie this replaces: `installed: false` with a null path, which
        // reads as "the guard is not wrapped" rather than "ask the other half".
        expect(result).not.toHaveProperty('installed');
        expect(pane.viewItems).not.toHaveBeenCalled();
    });

    it('refuses the view-state endpoint rather than reporting an empty registry', async () => {
        const result = await handleTestTableViewStateHttpRequest();

        expect(result).toMatchObject({ ok: false, code: 'tables_api_unavailable' });
        // An empty `views: []` here would look exactly like "no tables open".
        expect(result).not.toHaveProperty('views');
    });

    it('refuses to close a tab it cannot see', async () => {
        const result = await handleTestCloseTableTabHttpRequest({ tab_id: 'tab-1' });

        expect(result).toMatchObject({ ok: false, code: 'tables_api_unavailable' });
    });
});

describe('handlers read the namespace, not module state', () => {
    it('reports the namespace even while a real guard holds a different answer', async () => {
        // A real install, in this module instance, with its own decision record.
        installTableDoubleClick(win as unknown as Window);
        await warmTableItems([{ ...ITEM } as unknown as Zotero.Item]);
        expect(isTableDoubleClickInstalled(win as unknown as Window)).toBe(true);

        // The namespace disagrees with it on every field.
        const api = sentinelApi({
            doubleClick: {
                isInstalled: vi.fn(() => false),
                last: vi.fn(() => ({
                    at: '2026-01-01T00:00:00.000Z',
                    handler: 'viewAttachment' as const,
                    path: 'original' as const,
                    reason: 'not_a_table' as const,
                    itemID: null,
                    key: null,
                    libraryID: null,
                })),
                warm: vi.fn(async () => 0),
                settled: vi.fn(async () => undefined),
            },
        });
        setTablesApi(api);

        const result = await handleTestTableDoubleClickHttpRequest({ key: ITEM.key });

        // Every one of these would differ if the handler had read its own copy.
        expect(result.installed).toBe(false);
        expect(result.handler).toBe('viewAttachment');
        expect(result.path).toBe('original');
        expect(result.reason).toBe('not_a_table');
        expect(result.views).toEqual([
            { host: 'tab', id: 'sentinel-view', key: 'SENTINEL', markers: 99 },
        ]);
        expect(api.doubleClick.warm).toHaveBeenCalled();
        expect(api.doubleClick.settled).toHaveBeenCalled();
    });

    it('drives the pane through the namespace-published guard', async () => {
        setTablesApi(sentinelApi());

        const result = await handleTestTableDoubleClickHttpRequest({ key: ITEM.key });

        // Still the real double-click, invoked exactly as Zotero would.
        expect(pane.viewItems).toHaveBeenCalledWith([ITEM], null);
        expect(result.path).toBe('beaver');
        expect(result.reason).toBe('table');
        // The un-installed local module must not have recorded anything.
        expect(lastTableDoubleClick()).toBeNull();
    });

    it('lists views from the namespace', async () => {
        setTablesApi(sentinelApi());

        const result = await handleTestTableViewStateHttpRequest();

        expect(result).toMatchObject({ ok: true, tabs: 1, readers: 0 });
        expect(result.views[0].id).toBe('sentinel-view');
    });

    it('closes a tab through the namespace', async () => {
        const api = sentinelApi();
        setTablesApi(api);

        const result = await handleTestCloseTableTabHttpRequest({ tab_id: 'tab-9' });

        expect(api.closeTab).toHaveBeenCalledWith('tab-9');
        expect(result.ok).toBe(true);
    });
});
