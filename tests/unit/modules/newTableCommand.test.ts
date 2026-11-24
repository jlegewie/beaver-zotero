// @vitest-environment jsdom
/**
 * New tables from Zotero's menus: File ▸ New Beaver Table's empty table and
 * the collection menu's table from a collection or saved search, as registered
 * with Zotero's MenuManager and as created and opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedSource } from '@beaver/agent-core/layouts/tableEdit';

const mocks = vi.hoisted(() => ({
    resolveSources: vi.fn(),
    createTable: vi.fn(),
    openTable: vi.fn(),
    resolveTableLibrary: vi.fn(),
}));

vi.mock('../../../src/services/artifacts/tableSources', () => ({ resolveSources: mocks.resolveSources }));
vi.mock('../../../src/services/artifacts/tableStore', () => ({ createTable: mocks.createTable }));
vi.mock('../../../src/services/artifacts/tableItem', () => ({ resolveTableLibrary: mocks.resolveTableLibrary }));
vi.mock('../../../src/ui/openTable', () => ({ openTable: mocks.openTable }));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : `g${id}`),
}));

import { createAndOpenTable, newTableScope, newTableTitle } from '../../../src/modules/newTableCommand';
import { cleanupContextMenus, initContextMenus } from '../../../src/modules/zoteroContextMenu';

const Z = (globalThis as any).Zotero;
const alertSpy = vi.fn();

const collectionRow = (key: string, name: string, libraryID = 1, id = 7) => ({
    isCollection: () => true,
    isSearch: () => false,
    ref: { id, key, name, libraryID },
});
const searchRow = (key: string, name: string, libraryID = 1) => ({
    isCollection: () => false,
    isSearch: () => true,
    ref: { key, name, libraryID },
});
const viewRow = { isCollection: () => false, isSearch: () => false, ref: { libraryID: 1 } };

const resolved = (papers: number, extra: Partial<ResolvedSource> = {}): ResolvedSource[] =>
    [{ entry: { id: 's1', type: 'library' }, papers: [], total: papers, truncated: false, rejected: [], ...extra } as unknown as ResolvedSource];

const win = { closed: false } as unknown as Window;

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Services = { prompt: { alert: alertSpy } };
    mocks.resolveTableLibrary.mockImplementation((id: number) => (id === 3 ? { error: 'library_excluded' } : { libraryID: id }));
    mocks.resolveSources.mockResolvedValue([]);
    mocks.createTable.mockResolvedValue({ libraryID: 1, key: 'NEWTABLE' });
    mocks.openTable.mockResolvedValue({ ok: true, tabID: 't', reused: false });
});

describe('the table a new table starts from', () => {
    it('takes collections and saved searches, never a library or special view', () => {
        expect(newTableScope(collectionRow('COLL0001', 'Cash transfers'))).toEqual({
            libraryID: 1,
            scope: { kind: 'collection', library_ref: 'u', key: 'COLL0001', name: 'Cash transfers' },
        });
        expect(newTableScope(searchRow('SRCH0001', 'RCTs', 5))?.scope).toMatchObject({ kind: 'saved_search', library_ref: 'g5' });
        expect(newTableScope(viewRow)).toBeNull();
    });

    it('is named for its source', () => {
        expect(newTableTitle([])).toBe('New table');
        expect(newTableTitle([{ kind: 'collection', library_ref: 'u', name: 'Cash' }])).toBe('Cash');
        expect(
            newTableTitle([
                { kind: 'collection', library_ref: 'u', name: 'Cash' },
                { kind: 'saved_search', library_ref: 'u', name: 'RCTs' },
                { kind: 'collection', library_ref: 'u', name: 'Loans' },
            ]),
        ).toBe('Cash and 2 more');
    });
});

describe('creating and opening a new table', () => {
    it('creates an empty table as the user, files it in the collection and opens it', async () => {
        await createAndOpenTable(win, { libraryID: 1, collectionID: 7, scopes: [], title: 'New table' });
        expect(mocks.createTable).toHaveBeenCalledTimes(1);
        const options = mocks.createTable.mock.calls[0][0];
        expect(options).toMatchObject({ libraryID: 1, collectionID: 7, title: 'New table', actor: 'user' });
        expect(options.spec.columns.map((c: { id: string }) => c.id)).toEqual(['_reference', '_year', '_identifier']);
        expect(options.spec.rows).toEqual([]);
        expect(mocks.openTable).toHaveBeenCalledWith({ libraryID: 1, key: 'NEWTABLE' }, { window: win });
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('keeps an empty collection as the source of an empty table', async () => {
        mocks.resolveSources.mockResolvedValue(resolved(0));
        const scope = { kind: 'collection' as const, library_ref: 'u', key: 'COLL0001', name: 'Cash' };
        await createAndOpenTable(win, { libraryID: 1, scopes: [scope], title: 'Cash' });
        expect(mocks.resolveSources).toHaveBeenCalledWith([{ id: 's1', type: 'library', scope }]);
        expect(mocks.createTable.mock.calls[0][0].spec.sources.map((s: { id: string }) => s.id)).toEqual(['s1']);
    });

    it('says why a collection too large for a table makes none', async () => {
        mocks.resolveSources.mockResolvedValue(
            resolved(812, { truncated: true, entry: { id: 's1', type: 'library', scope: { kind: 'collection', library_ref: 'u', name: 'Everything' } } } as never),
        );
        await createAndOpenTable(win, { libraryID: 1, scopes: [{ kind: 'collection', library_ref: 'u', name: 'Everything' }], title: 'Everything' });
        expect(mocks.createTable).not.toHaveBeenCalled();
        expect(alertSpy.mock.calls[0][2]).toBe(
            'A table holds at most 500 items, and “Everything” has 812. Start from a smaller collection or search, or create an empty table and add items to it.',
        );
    });

    it('shows a refusal from the store instead of throwing', async () => {
        mocks.createTable.mockRejectedValue(new Error('That library is excluded in Beaver preferences, so Beaver will not write to it.'));
        await createAndOpenTable(win, { libraryID: 1, scopes: [], title: 'New table' });
        expect(alertSpy.mock.calls[0][2]).toContain('excluded in Beaver preferences');
        expect(mocks.openTable).not.toHaveBeenCalled();
    });
});

describe('the menu entries', () => {
    let registered: any[] = [];

    beforeEach(() => {
        registered = [];
        Z.MenuManager = {
            registerMenu: vi.fn((menu: any) => {
                registered.push(menu);
                return `beaver-${menu.menuID}`;
            }),
            unregisterMenu: vi.fn(),
        };
        Z.Beaver = { ...(Z.Beaver ?? {}), data: { ...(Z.Beaver?.data ?? {}), env: 'development' } };
    });

    afterEach(() => {
        cleanupContextMenus();
        delete Z.MenuManager;
    });

    const menuState = () => {
        const state = { visible: true, enabled: true, l10nArgs: '' };
        return {
            state,
            setVisible: (v: boolean) => (state.visible = v),
            setEnabled: (v: boolean) => (state.enabled = v),
            setL10nArgs: (v: string) => (state.l10nArgs = v),
        };
    };
    const paneContext = (libraryID: number, collection: { id: number } | false) => {
        // Zotero 10+ reads: the singular getters throw there.
        const pane = {
            getSelectedLibraryIDs: () => [libraryID],
            getSelectedCollections: () => (collection ? [collection] : []),
            getSelectedLibraryID: () => {
                throw new Error('ZoteroPane.getSelectedLibraryID() was removed');
            },
            getSelectedCollection: () => {
                throw new Error('ZoteroPane.getSelectedCollection() was removed');
            },
        };
        return { menuElem: { ownerDocument: { defaultView: { ...win, ZoteroPane: pane } } } };
    };

    /** A popup holding Zotero's `anchor` entry, with the plugin item appended at the end as MenuManager does. */
    const popupWith = (anchor: { id?: string; className?: string }) => {
        const popup = document.createElement('div');
        const own = document.createElement('div');
        Object.assign(own, anchor);
        const separator = document.createElement('div');
        separator.className = 'zotero-custom-menu-group-separator';
        const menuElem = document.createElement('div');
        popup.append(own, document.createElement('div'), separator, menuElem);
        return { own, menuElem };
    };

    it('adds New Beaver Table to the File menu below New Note, for library tabs where a table can be filed', async () => {
        initContextMenus();
        expect(registered.some((m) => m.target === 'main/library/addNote')).toBe(false);
        const item = registered.find((m) => m.target === 'main/menubar/file').menus[0];
        expect(item.l10nID).toBe('beaver-new-table');

        const { own, menuElem } = popupWith({ id: 'menu_noteAdd' });
        item.onShowing(null, { ...menuState(), menuElem, tabType: 'library' });
        expect(own.nextElementSibling).toBe(menuElem);

        const open = menuState();
        item.onShowing(null, { ...open, ...paneContext(1, false), tabType: 'library' });
        expect(open.state).toMatchObject({ visible: true, enabled: true });

        const excluded = menuState();
        item.onShowing(null, { ...excluded, ...paneContext(3, false), tabType: 'library' });
        expect(excluded.state.enabled).toBe(false);
        const reader = menuState();
        item.onShowing(null, { ...reader, ...paneContext(1, false), tabType: 'reader' });
        expect(reader.state.visible).toBe(false);

        item.onCommand(null, paneContext(1, { id: 9 }));
        await vi.waitFor(() => expect(mocks.createTable).toHaveBeenCalled());
        expect(mocks.createTable.mock.calls[0][0]).toMatchObject({ libraryID: 1, collectionID: 9, title: 'New table' });
    });

    it('adds Create Beaver Table below Generate Report, only for collections and saved searches', async () => {
        initContextMenus();
        const menu = registered.find((m) => m.target === 'main/library/collection' && m.menuID === 'beaver-new-table-collection-menu');
        const item = menu.menus[0];
        expect(item).toMatchObject({ l10nID: 'beaver-create-table', icon: 'chrome://beaver/content/icons/table.svg' });

        const { own, menuElem } = popupWith({ className: 'zotero-menuitem-create-report' });
        const one = menuState();
        item.onShowing(null, { ...one, menuElem, collectionTreeRows: [collectionRow('COLL0001', 'Cash')] });
        expect(own.nextElementSibling).toBe(menuElem);
        expect(one.state).toMatchObject({ visible: true, enabled: true });

        const several = menuState();
        item.onShowing(null, { ...several, collectionTreeRows: [collectionRow('COLL0001', 'Cash'), searchRow('SRCH0001', 'RCTs')] });
        expect(several.state.visible).toBe(true);

        for (const rows of [[viewRow], [collectionRow('COLL0001', 'Cash', 1), collectionRow('COLL0002', 'Loans', 5)]]) {
            const hidden = menuState();
            item.onShowing(null, { ...hidden, collectionTreeRows: rows });
            expect(hidden.state.visible).toBe(false);
        }

        const excluded = menuState();
        item.onShowing(null, { ...excluded, collectionTreeRows: [collectionRow('COLL0003', 'Hidden', 3)] });
        expect(excluded.state).toMatchObject({ visible: true, enabled: false });

        item.onCommand({ target: { ownerDocument: { defaultView: win } } }, { collectionTreeRows: [collectionRow('COLL0001', 'Cash', 1, 7)] });
        await vi.waitFor(() => expect(mocks.createTable).toHaveBeenCalled());
        expect(mocks.createTable.mock.calls[0][0]).toMatchObject({ libraryID: 1, collectionID: 7, title: 'Cash' });
    });

    it('leaves the Beaver Actions submenu to actions', () => {
        initContextMenus();
        const submenu = registered.find((m) => m.menuID === 'beaver-collection-context-menu').menus[0];
        expect(submenu.menus.some((m: any) => m.l10nID === 'beaver-create-table')).toBe(false);
    });

    it('marks both Beaver Actions submenus with the actions icon', () => {
        initContextMenus();
        const submenus = registered
            .filter((m) => m.menuID === 'beaver-item-context-menu' || m.menuID === 'beaver-collection-context-menu')
            .map((m) => m.menus[0]);
        expect(submenus).toHaveLength(2);
        for (const submenu of submenus) {
            expect(submenu).toMatchObject({ l10nID: 'beaver-context-menu-submenu', icon: 'chrome://beaver/content/icons/beaver-actions.svg' });
        }
    });

    it('adds the table entries in production builds', () => {
        Z.Beaver.data.env = 'production';
        initContextMenus();
        expect(registered.some((m) => m.menuID === 'beaver-new-table-file-menu')).toBe(true);
        expect(registered.some((m) => m.menuID === 'beaver-new-table-collection-menu')).toBe(true);
    });
});
