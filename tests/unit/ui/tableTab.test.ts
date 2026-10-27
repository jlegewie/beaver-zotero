// @vitest-environment jsdom
/**
 * The Beaver tab's Zotero side: the tab, its pane and React root, the tab-type
 * hooks Zotero needs for it, and keeping it out of the saved session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isTableItem = vi.hoisted(() => vi.fn(() => true));
const loadTableItemFields = vi.hoisted(() => vi.fn(async () => {}));
const optedIn = vi.hoisted(() => new Set<number>());
const redirect = vi.hoisted(() => ({ current: null as null | ((reader: any, item: any) => boolean) }));

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({ isTableItem, loadTableItemFields }));
vi.mock('../../../src/services/artifacts/view/readerTableView', () => ({
    isTableReaderOptedIn: (id: number) => optedIn.has(id),
    setTableReaderRedirect: (fn: any) => { redirect.current = fn; },
}));

import {
    TABLE_TAB_TYPE,
    cleanupTableTabs,
    closeTableTabsForWindow,
    dropTableTabsFromSession,
    initTableTabs,
    listTableTabs,
    openTableTab,
    recoverTabsAfterTableTabs,
    setTableTabWarning,
    tableTabStats,
} from '../../../src/ui/tableTab';

const REF = { libraryID: 1, key: 'TABLEKEY' };

interface FakeTab { id: string; type: string; title?: string; data?: any; onClose?: () => void }

let notifyAdd: ((id: string, extra: any) => void) | null = null;
// Zotero's tab ids are random, so unique across windows.
let nextTabID = 0;

class FakeTabs {
    tabs: FakeTab[] = [{ id: 'zotero-pane', type: 'library', data: {} }];
    selectedID = 'zotero-pane';
    tabHooks: Record<string, Record<string, any>> = {
        // Zotero's own: an unloaded tab at `index`, which must be >= 1.
        restoreState: {
            reader: vi.fn(async (tab: FakeTab, index: number) => {
                if (!(index >= 1)) throw new Error(`'index' should be an integer > 0 (was ${index})`);
                this.add({ type: 'reader-unloaded', title: tab.title, data: tab.data });
                return { itemID: tab.data.itemID };
            }),
            note: vi.fn(async (tab: FakeTab, index: number) => {
                if (!(index >= 1)) throw new Error(`'index' should be an integer > 0 (was ${index})`);
                this.add({ type: 'note-unloaded', title: tab.title, data: tab.data });
                return { itemID: tab.data.itemID };
            }),
        },
        getTitle: {},
        undoClose: {},
    };
    deck: HTMLElement;
    rename = vi.fn(async (id: string, title?: string) => {
        const tab = this.tabs.find((t) => t.id === id);
        if (!tab) return;
        tab.title = title || (await this.tabHooks.getTitle?.beaver?.(tab));
    });
    restoreState = vi.fn(async (tabs: FakeTab[]) => {
        for (const tab of tabs) this.add({ type: `${tab.type}-unloaded`, title: tab.title, data: tab.data });
    });

    constructor(private doc: Document) {
        this.deck = doc.createElement('div');
        doc.body.appendChild(this.deck);
    }

    get selectedType() {
        return this.tabs.find((t) => t.id === this.selectedID)?.type;
    }

    add({ type, title, data, select, onClose }: any) {
        const id = `tab-${++nextTabID}`;
        const container = this.doc.createElement('div');
        container.id = id;
        this.deck.appendChild(container);
        this.tabs.push({ id, type, title, data, onClose });
        notifyAdd?.(id, { ...data, type });
        if (select) this.selectedID = id;
        return { id, container };
    }

    select(id: string) {
        this.selectedID = id;
    }

    close(ids: string | string[]) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
            const index = this.tabs.findIndex((t) => t.id === id);
            if (index < 0) continue;
            const [tab] = this.tabs.splice(index, 1);
            if (this.selectedID === id) this.selectedID = 'zotero-pane';
            tab.onClose?.();
            // Zotero removes the container on the next tick.
            setTimeout(() => this.doc.getElementById(id)?.remove());
        }
    }

    getState() {
        return this.tabs.map((t) => ({ type: t.type.replace(/-unloaded$/, ''), title: t.title, data: t.data }));
    }
}

function fakeWindow() {
    const doc = document.implementation.createHTMLDocument('main');
    const listeners: Record<string, Array<() => void>> = {};
    const handle = { setWarning: vi.fn(), reload: vi.fn() };
    const win: any = {
        closed: false,
        document: doc,
        location: { href: 'chrome://zotero/content/zoteroPane.xhtml' },
        addEventListener: vi.fn((name: string, fn: () => void) => { (listeners[name] ??= []).push(fn); }),
        dispatch: (name: string) => listeners[name]?.forEach((fn) => fn()),
        BeaverReact: {
            renderTableTab: vi.fn((container: HTMLElement) => {
                container.appendChild(doc.createElement('section'));
                return handle;
            }),
            unmountFromElement: vi.fn((container: HTMLElement) => {
                container.replaceChildren();
                return true;
            }),
        },
        handle,
    };
    win.Zotero_Tabs = new FakeTabs(doc);
    return win;
}

function tableItem(id = 42) {
    return {
        id,
        key: REF.key,
        libraryID: REF.libraryID,
        isAttachment: () => true,
        attachmentContentType: 'text/html',
        getField: vi.fn(() => 'Item title'),
    } as any;
}

let windows: any[];
let wmListener: any;
let quitObserver: any;
let notifier: any;
let opener: ReturnType<typeof vi.fn>;
let session: { state: any; save: ReturnType<typeof vi.fn> };

beforeEach(() => {
    vi.clearAllMocks();
    optedIn.clear();
    notifyAdd = null;
    windows = [fakeWindow()];
    session = { state: { windows: [] }, save: vi.fn(async () => {}) };
    (globalThis as any).Services = {
        wm: { addListener: vi.fn((l: any) => { wmListener = l; }), removeListener: vi.fn() },
        obs: { addObserver: vi.fn((o: any) => { quitObserver = o; }), removeObserver: vi.fn() },
    };
    Object.assign(Zotero as any, {
        getMainWindows: () => windows,
        Session: session,
        Items: { get: vi.fn(() => tableItem()) },
        Notifier: {
            registerObserver: vi.fn((o: any) => { notifier = o; return 'beaver-table-tab'; }),
            unregisterObserver: vi.fn(),
        },
    });
    opener = vi.fn(async () => ({ ok: true }));
    initTableTabs(opener as any);
});

afterEach(() => {
    cleanupTableTabs();
});

describe('opening', () => {
    it('opens a beaver-table tab carrying the item and table, with React one level below a beaver-pane root', () => {
        const win = windows[0];
        const spec = { id: 't', title: 'Spec title', columns: [], rows: [] } as any;
        const { tabID, reused } = openTableTab(win, tableItem(), REF, { initial: { spec, version: 3 } });

        expect(reused).toBe(false);
        const tab = win.Zotero_Tabs.tabs.find((t: FakeTab) => t.id === tabID);
        expect(tab).toMatchObject({ type: TABLE_TAB_TYPE, title: 'Spec title', data: { itemID: 42, beaverTable: REF } });
        expect(win.Zotero_Tabs.selectedID).toBe(tabID);

        const pane = win.document.getElementById(`beaver-pane-table-${tabID}`);
        expect(pane?.classList.contains('beaver-root')).toBe(true);
        expect(pane?.parentElement?.id).toBe(tabID);
        const [container, ref, options] = win.BeaverReact.renderTableTab.mock.calls[0];
        expect(container.parentElement).toBe(pane);
        expect(ref).toEqual(REF);
        expect(options.initial).toEqual({ spec, version: 3 });
    });

    it('selects the tab already showing the table on a second open', () => {
        const win = windows[0];
        const first = openTableTab(win, tableItem(), REF);
        win.Zotero_Tabs.select('zotero-pane');

        const second = openTableTab(win, tableItem(), REF);

        expect(second).toEqual({ tabID: first.tabID, reused: true });
        expect(win.Zotero_Tabs.selectedID).toBe(first.tabID);
        expect(win.BeaverReact.renderTableTab).toHaveBeenCalledTimes(1);
        expect(win.Zotero_Tabs.tabs.filter((t: FakeTab) => t.type === TABLE_TAB_TYPE)).toHaveLength(1);
    });

    it('opens behind the selected tab when asked', () => {
        const win = windows[0];
        openTableTab(win, tableItem(), REF, { background: true });
        expect(win.Zotero_Tabs.selectedID).toBe('zotero-pane');
    });

    it('refuses a window without the renderer', () => {
        const win = windows[0];
        delete win.BeaverReact.renderTableTab;
        expect(() => openTableTab(win, tableItem(), REF)).toThrow(/cannot show a Beaver tab/);
        expect(win.Zotero_Tabs.tabs).toHaveLength(1);
    });

    it('renames the tab when the spec title changes', () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        const { onTitle } = win.BeaverReact.renderTableTab.mock.calls[0][2];

        onTitle('Renamed');

        expect(win.Zotero_Tabs.rename).toHaveBeenCalledWith(tabID, 'Renamed');
        expect(listTableTabs()[0].title).toBe('Renamed');
    });

    it('forwards the open warning to the mounted tab', () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        setTableTabWarning(tabID, 'Snapshot behind');
        expect(win.handle.setWarning).toHaveBeenCalledWith('Snapshot behind');
    });
});

describe('closing', () => {
    it('unmounts the root when the tab closes, before Zotero removes the container', () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        const container = win.BeaverReact.renderTableTab.mock.calls[0][0];
        const before = tableTabStats();

        win.Zotero_Tabs.close(tabID);

        expect(win.BeaverReact.unmountFromElement).toHaveBeenCalledWith(container);
        expect(tableTabStats().unmounted - before.unmounted).toBe(1);
        expect(win.document.querySelector('.beaver-table-tab')).toBeNull();
        expect(listTableTabs()).toEqual([]);
    });

    it("closes one window's tabs and leaves another's open", () => {
        const other = fakeWindow();
        windows.push(other);
        openTableTab(windows[0], tableItem(), REF);
        const { tabID: kept } = openTableTab(other, tableItem(), REF);

        expect(closeTableTabsForWindow(windows[0])).toBe(1);

        expect(listTableTabs().map((t) => t.tabID)).toEqual([kept]);
        expect(windows[0].BeaverReact.unmountFromElement).toHaveBeenCalledOnce();
        expect(other.BeaverReact.unmountFromElement).not.toHaveBeenCalled();
    });

    it('strips Beaver tabs from the in-memory session when a window closes them', () => {
        session.state = {
            windows: [{ type: 'pane', tabs: [{ type: 'library' }, { type: TABLE_TAB_TYPE, data: {} }, { type: 'reader', data: { itemID: 9 } }] }],
        };
        closeTableTabsForWindow(windows[0]);
        expect(session.state.windows[0].tabs.map((t: any) => t.type)).toEqual(['library', 'reader']);
    });

    it('closes every Beaver tab on quit-application-granted, before Zotero saves the session', () => {
        const win = windows[0];
        openTableTab(win, tableItem(), REF);
        quitObserver.observe();
        expect(listTableTabs()).toEqual([]);
        expect(win.Zotero_Tabs.getState().map((t: any) => t.type)).toEqual(['library']);
    });
});

describe('tab hooks', () => {
    it('answers the title Zotero asks for on an item rename, never undefined', async () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        const getTitle = win.Zotero_Tabs.tabHooks.getTitle.beaver;
        await expect(getTitle({ id: tabID })).resolves.toBe('Item title');
        await expect(getTitle({ id: 'gone' })).resolves.toBe('');
    });

    it('drops a saved Beaver tab on restore with an object, so the tabs after it restore', async () => {
        const hook = windows[0].Zotero_Tabs.tabHooks.restoreState.beaver;
        await expect(hook({ type: TABLE_TAB_TYPE, data: {} }, 1)).resolves.toEqual({ itemID: null });
    });

    it('installs the hooks in a new main window at DOMContentLoaded, before it restores its tabs', () => {
        const fresh = fakeWindow();
        wmListener.onOpenWindow({ docShell: { domWindow: fresh } });
        expect(fresh.Zotero_Tabs.tabHooks.restoreState.beaver).toBeUndefined();

        fresh.dispatch('DOMContentLoaded');

        expect(typeof fresh.Zotero_Tabs.tabHooks.restoreState.beaver).toBe('function');
        expect(typeof fresh.Zotero_Tabs.tabHooks.getTitle.beaver).toBe('function');
    });

    it('reopens a closed table through the product open on undo-close', async () => {
        const hook = windows[0].Zotero_Tabs.tabHooks.undoClose.beaver;
        await expect(hook({ data: { itemID: 42, beaverTable: REF } }, 3)).resolves.toBe(false);
        expect(opener).toHaveBeenCalledWith(REF, { window: windows[0], index: 3 });
    });

    it('moves keyboard focus into the tab, back to where it was when that is still there', async () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        const [container] = win.BeaverReact.renderTableTab.mock.calls[0];
        const first = win.document.createElement('button');
        const search = win.document.createElement('input');
        container.append(first, search);
        const focusFirst = vi.spyOn(first, 'focus');
        const focusSearch = vi.spyOn(search, 'focus');

        await win.Zotero_Tabs.tabHooks.focusFirst.beaver({ id: tabID });
        expect(focusFirst).toHaveBeenCalledOnce();

        const tab = { id: tabID, lastFocusedElement: search as Element | null };
        await win.Zotero_Tabs.tabHooks.refocus.beaver(tab);
        expect(focusSearch).toHaveBeenCalledOnce();
        expect(tab.lastFocusedElement).toBeNull();

        search.remove();
        await win.Zotero_Tabs.tabHooks.refocus.beaver({ id: tabID, lastFocusedElement: search });
        expect(focusSearch).toHaveBeenCalledOnce();
        expect(focusFirst).toHaveBeenCalledTimes(2);
    });

    it('removes the hooks, observers and tabs on cleanup, and saves the session when asked', () => {
        const win = windows[0];
        openTableTab(win, tableItem(), REF);
        session.state = { windows: [{ type: 'pane', tabs: [{ type: 'library' }, { type: TABLE_TAB_TYPE }] }] };

        cleanupTableTabs({ saveSession: true });

        expect(listTableTabs()).toEqual([]);
        expect(win.Zotero_Tabs.tabHooks.restoreState.beaver).toBeUndefined();
        expect(win.Zotero_Tabs.tabHooks.getTitle.beaver).toBeUndefined();
        expect(win.Zotero_Tabs.tabHooks.focusFirst.beaver).toBeUndefined();
        expect(win.Zotero_Tabs.tabHooks.refocus.beaver).toBeUndefined();
        expect(Services.wm.removeListener).toHaveBeenCalled();
        expect(Services.obs.removeObserver).toHaveBeenCalledWith(expect.anything(), 'quit-application-granted');
        expect(Zotero.Notifier.unregisterObserver).toHaveBeenCalledWith('beaver-table-tab');
        expect(session.state.windows[0].tabs).toEqual([{ type: 'library' }]);
        expect(session.save).toHaveBeenCalledOnce();
    });
});

describe('readers on a table item', () => {
    async function addReader(win: any, itemID = 42) {
        const { id } = win.Zotero_Tabs.add({ type: 'reader', data: { itemID }, select: true });
        await notifier.notify('add', 'tab', [id], { [id]: { type: 'reader', itemID } });
        return id;
    }

    it('closes a reader tab opened on a table and opens the Beaver tab in its window', async () => {
        const win = windows[0];
        const readerTab = await addReader(win);

        expect(win.Zotero_Tabs.tabs.some((t: FakeTab) => t.id === readerTab)).toBe(false);
        expect(opener).toHaveBeenCalledWith(REF, { window: win, background: false });
    });

    it('says why when the table behind a closed reader cannot be shown', async () => {
        const win = windows[0];
        const alert = vi.fn();
        (Zotero as any).alert = alert;
        opener.mockResolvedValueOnce({ error: 'This table cannot be read.' });
        await addReader(win);
        await Promise.resolve();
        await Promise.resolve();
        expect(alert).toHaveBeenCalledWith(win, 'Beaver', 'This table cannot be read.');
    });

    it('leaves a reader on anything else alone', async () => {
        isTableItem.mockReturnValueOnce(false);
        const win = windows[0];
        const readerTab = await addReader(win);
        expect(win.Zotero_Tabs.tabs.some((t: FakeTab) => t.id === readerTab)).toBe(true);
        expect(opener).not.toHaveBeenCalled();
    });

    it('never loads fields for a reader that is not an HTML snapshot', async () => {
        (Zotero.Items.get as any).mockReturnValueOnce({ ...tableItem(), attachmentContentType: 'application/pdf' });
        await addReader(windows[0]);
        expect(loadTableItemFields).not.toHaveBeenCalled();
        expect(opener).not.toHaveBeenCalled();
    });

    it('keeps a reader the dev endpoint opened on purpose', async () => {
        optedIn.add(42);
        await addReader(windows[0]);
        expect(opener).not.toHaveBeenCalled();
    });

    it('hands the reader toolbar hook a redirect for restored reader tabs that load later', () => {
        const win = windows[0];
        const { id } = win.Zotero_Tabs.add({ type: 'reader', data: { itemID: 42 } });
        expect(redirect.current?.({ tabID: id, _window: win }, tableItem())).toBe(true);
        expect(opener).toHaveBeenCalledWith(REF, { window: win, background: true });
        expect(redirect.current?.({ _window: win }, tableItem())).toBe(false);
    });
});

describe('the context pane', () => {
    it('collapses for a selected Beaver tab, which Zotero leaves showing the last reader item', async () => {
        const win = windows[0];
        const doc: Document = win.document;
        for (const id of ['zotero-context-splitter', 'zotero-context-pane', 'zotero-context-pane-sidenav']) {
            const el = doc.createElement('div');
            el.id = id;
            doc.body.appendChild(el);
        }
        const { tabID } = openTableTab(win, tableItem(), REF);

        await notifier.notify('select', 'tab', [tabID], { [tabID]: { type: TABLE_TAB_TYPE } });

        // "true", not "": Zotero 7–10 read an empty value as off.
        expect(doc.getElementById('zotero-context-splitter')!.getAttribute('hidden')).toBe('true');
        expect(doc.getElementById('zotero-context-pane')!.getAttribute('collapsed')).toBe('true');
        expect(doc.getElementById('zotero-context-pane-sidenav')!.hidden).toBe(true);
    });

    it('stays open for Beaver chat when the chat is open', async () => {
        const win = windows[0];
        const doc: Document = win.document;
        for (const id of ['zotero-context-splitter', 'zotero-context-pane', 'zotero-beaver-tb-chat-toggle']) {
            const el = doc.createElement('div');
            el.id = id;
            doc.body.appendChild(el);
        }
        doc.getElementById('zotero-beaver-tb-chat-toggle')!.setAttribute('selected', 'true');
        const { tabID } = openTableTab(win, tableItem(), REF);

        await notifier.notify('select', 'tab', [tabID], { [tabID]: { type: TABLE_TAB_TYPE } });

        expect(doc.getElementById('zotero-context-pane')!.hasAttribute('collapsed')).toBe(false);
    });

    it('reads the table again when Zotero selects its open tab (double-click, zotero://open)', async () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        win.handle.reload.mockClear();

        await notifier.notify('select', 'tab', [tabID], { [tabID]: { type: TABLE_TAB_TYPE } });

        expect(win.handle.reload).toHaveBeenCalledOnce();
    });

    it('closes the tab when its table is trashed or deleted, and only that tab', async () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(), REF);
        const other = { ...REF, key: 'OTHER222' };
        const { tabID: otherID } = openTableTab(win, tableItem(43), other);

        await notifier.notify('trash', 'item', [42], {});

        expect(listTableTabs().map((t: any) => t.tabID)).toEqual([otherID]);
        expect(win.Zotero_Tabs.tabs.some((t: any) => t.id === tabID)).toBe(false);

        await notifier.notify('delete', 'item', [43], {});
        expect(listTableTabs()).toEqual([]);
    });

    it('is left alone for any other tab', async () => {
        const win = windows[0];
        const doc: Document = win.document;
        const pane = doc.createElement('div');
        pane.id = 'zotero-context-pane';
        doc.body.appendChild(pane);
        const { id } = win.Zotero_Tabs.add({ type: 'reader', data: { itemID: 9 } });
        await notifier.notify('select', 'tab', [id], { [id]: { type: 'reader' } });
        expect(pane.hasAttribute('collapsed')).toBe(false);
    });
});

describe('session restore', () => {
    it('reopens the tabs a cold start lost after a saved Beaver tab, once', async () => {
        const win = windows[0];
        // The window restored up to the Beaver entry, which threw.
        win.Zotero_Tabs.add({ type: 'reader-unloaded', data: { itemID: 7 } });
        session.state = {
            windows: [{
                type: 'pane',
                tabs: [
                    { type: 'library' },
                    { type: 'reader', data: { itemID: 7 } },
                    { type: TABLE_TAB_TYPE, data: { itemID: 42 } },
                    { type: 'reader', data: { itemID: 8 } },
                    { type: 'note', data: { itemID: 9 } },
                ],
            }],
        };
        // The plugin starts after that restore; its startup must not strip
        // the saved session it is about to compare against.
        initTableTabs(opener as any);
        closeTableTabsForWindow(win);
        expect(session.state.windows[0].tabs.some((t: any) => t.type === TABLE_TAB_TYPE)).toBe(false);

        await expect(recoverTabsAfterTableTabs(win)).resolves.toBe(2);
        expect(win.Zotero_Tabs.getState().map((t: any) => [t.type, t.data?.itemID])).toEqual([
            ['library', undefined],
            ['reader', 7],
            ['reader', 8],
            ['note', 9],
        ]);
        // A second load of the same window does nothing.
        await expect(recoverTabsAfterTableTabs(win)).resolves.toBe(0);
    });

    it('leaves a window alone that got the hooks before it restored', async () => {
        session.state = { windows: [{ type: 'pane', tabs: [{ type: TABLE_TAB_TYPE }, { type: 'reader', data: { itemID: 8 } }] }] };
        initTableTabs(opener as any);
        const fresh = fakeWindow();
        wmListener.onOpenWindow({ docShell: { domWindow: fresh } });
        fresh.dispatch('DOMContentLoaded');
        await expect(recoverTabsAfterTableTabs(fresh)).resolves.toBe(0);
        expect(fresh.Zotero_Tabs.tabHooks.restoreState.reader).not.toHaveBeenCalled();
    });

    it('does nothing when the session it started from holds no Beaver tab', async () => {
        session.state = { windows: [{ type: 'pane', tabs: [{ type: 'library' }, { type: 'reader', data: { itemID: 8 } }] }] };
        initTableTabs(opener as any);
        await expect(recoverTabsAfterTableTabs(windows[0])).resolves.toBe(0);
        expect(windows[0].Zotero_Tabs.tabHooks.restoreState.reader).not.toHaveBeenCalled();
    });

    it('reports whether anything was stripped', () => {
        session.state = { windows: [{ type: 'pane', tabs: [{ type: 'library' }] }] };
        expect(dropTableTabsFromSession()).toBe(false);
    });
});
