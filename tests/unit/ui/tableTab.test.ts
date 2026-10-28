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
const prefs = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({ isTableItem, loadTableItemFields }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key) ?? '',
    setPref: (key: string, value: unknown) => { prefs.set(key, value); },
}));
vi.mock('../../../src/services/artifacts/view/readerTableView', () => ({
    isTableReaderOptedIn: (id: number) => optedIn.has(id),
    setTableReaderRedirect: (fn: any) => { redirect.current = fn; },
}));

import {
    TABLE_TAB_TYPE,
    cleanupTableTabs,
    initTableTabs,
    listTableTabs,
    openTableTab,
    setTableTabWarning,
    tableTabStats,
} from '../../../src/ui/tableTab';
import {
    cleanupBeaverTabs,
    closeBeaverTabsForWindow,
    dropBeaverTabsFromSession,
    initBeaverTabs,
    recoverTabsAfterBeaverTabs,
    restoreBeaverTabs,
} from '../../../src/ui/beaverTabs';
import { fakeWindow, type FakeTab } from '../../helpers/fakeZoteroTabs';

const REF = { libraryID: 1, key: 'TABLEKEY' };

function tableItem(id = 42, key = REF.key) {
    return {
        id,
        key,
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
    prefs.clear();
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
        Promise: { delay: vi.fn(async () => {}) },
        Notifier: {
            registerObserver: vi.fn((o: any) => { notifier = o; return 'beaver-table-tab'; }),
            unregisterObserver: vi.fn(),
        },
    });
    opener = vi.fn(async () => ({ ok: true }));
    startTabs(opener);
});

afterEach(() => {
    stopTabs();
});

/** Plugin startup: the shared Beaver tabs, then the table kind. */
function startTabs(open: any) {
    initBeaverTabs();
    initTableTabs(open);
}

/** Plugin shutdown: the tabs close while their kind is registered. */
function stopTabs(options: { saveSession?: boolean } = {}) {
    cleanupBeaverTabs(options);
    cleanupTableTabs();
}

describe('opening', () => {
    it('opens a beaver-table tab carrying the item and table, with React one level below a beaver-pane root', () => {
        const win = windows[0];
        const spec = { id: 't', title: 'Spec title', columns: [], rows: [] } as any;
        const { tabID, reused } = openTableTab(win, tableItem(), REF, { initial: { spec, version: 3 } });

        expect(reused).toBe(false);
        const tab = win.Zotero_Tabs.tabs.find((t: FakeTab) => t.id === tabID);
        expect(tab).toMatchObject({ type: TABLE_TAB_TYPE, title: 'Spec title', data: { itemID: 42, beaverTab: { kind: 'table', ref: REF } } });
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

        expect(closeBeaverTabsForWindow(windows[0])).toBe(1);

        expect(listTableTabs().map((t) => t.tabID)).toEqual([kept]);
        expect(windows[0].BeaverReact.unmountFromElement).toHaveBeenCalledOnce();
        expect(other.BeaverReact.unmountFromElement).not.toHaveBeenCalled();
    });

    it('strips Beaver tabs from the in-memory session when a window closes them', () => {
        session.state = {
            windows: [{ type: 'pane', tabs: [{ type: 'library' }, { type: TABLE_TAB_TYPE, data: {} }, { type: 'reader', data: { itemID: 9 } }] }],
        };
        closeBeaverTabsForWindow(windows[0]);
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
        await expect(hook({ data: { itemID: 42, beaverTab: { kind: 'table', ref: REF } } }, 3)).resolves.toBe(false);
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

        stopTabs({ saveSession: true });

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
        startTabs(opener);
        closeBeaverTabsForWindow(win);
        expect(session.state.windows[0].tabs.some((t: any) => t.type === TABLE_TAB_TYPE)).toBe(false);

        await expect(recoverTabsAfterBeaverTabs(win)).resolves.toBe(2);
        expect(win.Zotero_Tabs.getState().map((t: any) => [t.type, t.data?.itemID])).toEqual([
            ['library', undefined],
            ['reader', 7],
            ['reader', 8],
            ['note', 9],
        ]);
        // A second load of the same window does nothing.
        await expect(recoverTabsAfterBeaverTabs(win)).resolves.toBe(0);
    });

    it('leaves a window alone that got the hooks before it restored', async () => {
        session.state = { windows: [{ type: 'pane', tabs: [{ type: TABLE_TAB_TYPE }, { type: 'reader', data: { itemID: 8 } }] }] };
        startTabs(opener);
        const fresh = fakeWindow();
        wmListener.onOpenWindow({ docShell: { domWindow: fresh } });
        fresh.dispatch('DOMContentLoaded');
        await expect(recoverTabsAfterBeaverTabs(fresh)).resolves.toBe(0);
        expect(fresh.Zotero_Tabs.tabHooks.restoreState.reader).not.toHaveBeenCalled();
    });

    it('does nothing when the session it started from holds no Beaver tab', async () => {
        session.state = { windows: [{ type: 'pane', tabs: [{ type: 'library' }, { type: 'reader', data: { itemID: 8 } }] }] };
        startTabs(opener);
        await expect(recoverTabsAfterBeaverTabs(windows[0])).resolves.toBe(0);
        expect(windows[0].Zotero_Tabs.tabHooks.restoreState.reader).not.toHaveBeenCalled();
    });

    it('reports whether anything was stripped', () => {
        session.state = { windows: [{ type: 'pane', tabs: [{ type: 'library' }] }] };
        expect(dropBeaverTabsFromSession()).toBe(false);
    });
});

describe('reopening Beaver tabs after a lifecycle close', () => {
    const T1 = { libraryID: 1, key: 'TABLEONE' };
    const T2 = { libraryID: 1, key: 'TABLETWO' };
    const IDS: Record<string, number> = { TABLEONE: 51, TABLETWO: 52, TABLEKEY: 42 };

    /** The product open as the tab sees it: opens or reuses the tab. */
    function openingOpener(fail: Record<string, string> = {}) {
        return vi.fn(async (ref: any, options: any) => {
            if (fail[ref.key]) return { error: fail[ref.key] };
            openTableTab(options.window, tableItem(IDS[ref.key] ?? 1, ref.key), ref, {
                background: options.background,
                index: options.index,
            });
            return { ok: true as const };
        });
    }

    function layout(win: any) {
        return win.Zotero_Tabs.getState().map((t: any) =>
            t.type === TABLE_TAB_TYPE ? `table:${t.data.beaverTab.ref.key}` : `${t.type}:${t.data?.itemID ?? ''}`);
    }

    function selected(win: any) {
        const tab = win.Zotero_Tabs.tabs.find((t: FakeTab) => t.id === win.Zotero_Tabs.selectedID);
        return tab?.type === TABLE_TAB_TYPE ? `table:${tab.data.beaverTab.ref.key}` : tab?.type;
    }

    /** library, reader 7, table one, reader 8, table two — table two selected. */
    function arrange(win: any) {
        win.Zotero_Tabs.add({ type: 'reader', data: { itemID: 7 } });
        openTableTab(win, tableItem(51, T1.key), T1, { background: true });
        win.Zotero_Tabs.add({ type: 'reader', data: { itemID: 8 } });
        openTableTab(win, tableItem(52, T2.key), T2);
        expect(layout(win)).toEqual(['library:', 'reader:7', 'table:TABLEONE', 'reader:8', 'table:TABLETWO']);
    }

    function record() {
        const value = prefs.get('beaverTabsToRestore');
        return value ? JSON.parse(value as string) : null;
    }

    function startPlugin(open = openingOpener()) {
        stopTabs();
        startTabs(open);
        return open;
    }

    it('reopens the tables a plugin reload closed, in their positions, with the selected one selected', async () => {
        const win = windows[0];
        arrange(win);

        // Plugin shutdown: removeChatPanel per window, then cleanup.
        closeBeaverTabsForWindow(win);
        expect(selected(win)).not.toBe('table:TABLETWO');
        expect(record().windows).toEqual([{
            window: String(win.docShell.outerWindowID),
            primary: true,
            tabs: [
                { kind: 'table', ref: T1, index: 2, selected: false },
                { kind: 'table', ref: T2, index: 4, selected: true },
            ],
        }]);
        const open = startPlugin();

        await expect(restoreBeaverTabs(win)).resolves.toBe(2);

        expect(layout(win)).toEqual(['library:', 'reader:7', 'table:TABLEONE', 'reader:8', 'table:TABLETWO']);
        expect(selected(win)).toBe('table:TABLETWO');
        expect(open).toHaveBeenCalledWith(T1, { window: win, background: true, index: 2 });
        expect(prefs.get('beaverTabsToRestore')).toBe('');
    });

    it('remembers the tabs it closes on quit, and the next start reopens them in the first window', async () => {
        const win = windows[0];
        arrange(win);
        quitObserver.observe();
        expect(listTableTabs()).toEqual([]);
        expect(record().windows[0].tabs).toHaveLength(2);

        // A new run of Zotero: its session restored the other tabs, and Zotero
        // selected the neighbour it chose when the selected table closed.
        const next = fakeWindow();
        next.Zotero_Tabs.add({ type: 'reader-unloaded', data: { itemID: 7 } });
        next.Zotero_Tabs.add({ type: 'reader-unloaded', data: { itemID: 8 }, select: true });
        windows = [next];
        (Zotero as any).__beaverAppSessionID = 'a later run';
        try {
            startPlugin();
            await expect(restoreBeaverTabs(next)).resolves.toBe(2);
        } finally {
            delete (Zotero as any).__beaverAppSessionID;
        }
        expect(layout(next)).toEqual(['library:', 'reader:7', 'table:TABLEONE', 'reader:8', 'table:TABLETWO']);
        expect(selected(next)).toBe('table:TABLETWO');
        expect(prefs.get('beaverTabsToRestore')).toBe('');
    });

    it('reopens only the first window\'s tables after a restart, as Zotero restores only its tabs', async () => {
        const second = fakeWindow();
        windows.push(second);
        openTableTab(windows[0], tableItem(51, T1.key), T1);
        openTableTab(second, tableItem(52, T2.key), T2);
        quitObserver.observe();
        expect(record().windows.map((w: any) => [w.primary, w.tabs[0].ref.key])).toEqual([[true, 'TABLEONE'], [false, 'TABLETWO']]);

        const next = fakeWindow();
        windows = [next];
        (Zotero as any).__beaverAppSessionID = 'a later run';
        try {
            startPlugin();
            await restoreBeaverTabs(next);
        } finally {
            delete (Zotero as any).__beaverAppSessionID;
        }
        expect(layout(next)).toEqual(['library:', 'table:TABLEONE']);
    });

    it('gives each window its own tables back after a plugin reload', async () => {
        const second = fakeWindow();
        windows.push(second);
        openTableTab(windows[0], tableItem(51, T1.key), T1);
        openTableTab(second, tableItem(52, T2.key), T2);
        for (const win of windows) closeBeaverTabsForWindow(win);
        startPlugin();

        await restoreBeaverTabs(second);
        await restoreBeaverTabs(windows[0]);

        expect(layout(windows[0])).toEqual(['library:', 'table:TABLEONE']);
        expect(layout(second)).toEqual(['library:', 'table:TABLETWO']);
    });

    it('never remembers a tab the user closed, or one closed because its table was trashed', async () => {
        const win = windows[0];
        const { tabID } = openTableTab(win, tableItem(51, T1.key), T1);
        openTableTab(win, tableItem(52, T2.key), T2);

        win.Zotero_Tabs.close(tabID);
        await notifier.notify('trash', 'item', [52], {});

        expect(listTableTabs()).toEqual([]);
        expect(prefs.get('beaverTabsToRestore') ?? '').toBe('');
        closeBeaverTabsForWindow(win);
        expect(prefs.get('beaverTabsToRestore') ?? '').toBe('');
    });

    it('reopens a list once: a later load, or a crash after it, finds nothing', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        closeBeaverTabsForWindow(win);
        const open = startPlugin();
        await expect(restoreBeaverTabs(win)).resolves.toBe(1);
        // The user closes it; a second load of the window opens nothing.
        win.Zotero_Tabs.close(findTabID(win, T1));

        await expect(restoreBeaverTabs(win)).resolves.toBe(0);
        expect(open).toHaveBeenCalledOnce();
    });

    it('skips a table that is gone or unreadable without a message, and keeps the others in place', async () => {
        const win = windows[0];
        arrange(win);
        closeBeaverTabsForWindow(win);
        const alert = vi.fn();
        (Zotero as any).alert = alert;
        startPlugin(openingOpener({ TABLEONE: 'Could not open table TABLEONE — Table TABLEONE is in the trash.' }));

        await expect(restoreBeaverTabs(win)).resolves.toBe(1);

        expect(layout(win)).toEqual(['library:', 'reader:7', 'reader:8', 'table:TABLETWO']);
        expect(selected(win)).toBe('table:TABLETWO');
        expect(alert).not.toHaveBeenCalled();
    });

    it('does not open a second tab for a table already open again', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        closeBeaverTabsForWindow(win);
        startPlugin();
        // A reader redirect, or undo-close, got there first.
        openTableTab(win, tableItem(51, T1.key), T1, { background: true });

        await restoreBeaverTabs(win);

        expect(layout(win)).toEqual(['library:', 'table:TABLEONE']);
    });

    it('leaves the selection alone when the user moved to another tab while tables reopened', async () => {
        const win = windows[0];
        arrange(win);
        closeBeaverTabsForWindow(win);
        const inner = openingOpener();
        startPlugin(vi.fn(async (ref: any, options: any) => {
            win.Zotero_Tabs.select('zotero-pane');
            return inner(ref, options);
        }) as any);
        win.Zotero_Tabs.select(win.Zotero_Tabs.tabs[1].id);

        await restoreBeaverTabs(win);

        expect(selected(win)).toBe('library');
    });

    it('reopens the last window\'s tables in the next main window after it closed while Zotero runs', async () => {
        const win = windows[0];
        arrange(win);
        // The window has left Zotero's window list and is closing.
        windows = [];
        win.closed = true;
        closeBeaverTabsForWindow(win);
        expect(record().windows[0]).toMatchObject({ primary: true });

        const next = fakeWindow();
        next.Zotero_Tabs.add({ type: 'reader-unloaded', data: { itemID: 7 } });
        next.Zotero_Tabs.add({ type: 'reader-unloaded', data: { itemID: 8 }, select: true });
        windows = [next];
        startPlugin();
        await expect(restoreBeaverTabs(next)).resolves.toBe(2);
        expect(layout(next)).toEqual(['library:', 'reader:7', 'table:TABLEONE', 'reader:8', 'table:TABLETWO']);
        expect(selected(next)).toBe('table:TABLETWO');
    });

    it('remembers from the pane state Zotero saved when its own teardown closes the last window first', async () => {
        const win = windows[0];
        arrange(win);
        // ZoteroPane.destroy: the window has left the list, Zotero keeps its
        // tabs as the session's pane, then closes them all.
        windows = [];
        win.closed = true;
        session.state = { windows: [{ type: 'pane', tabs: win.Zotero_Tabs.getState() }] };
        win.Zotero_Tabs.closeAll();

        expect(listTableTabs()).toEqual([]);
        expect(record().windows[0].tabs).toEqual([
            { kind: 'table', ref: T1, index: 2, selected: false },
            { kind: 'table', ref: T2, index: 4, selected: true },
        ]);
        // Beaver's own unload follows and finds nothing left to remember.
        closeBeaverTabsForWindow(win);
        expect(record().windows[0].tabs).toHaveLength(2);
        expect(session.state.windows[0].tabs.some((t: any) => t.type === TABLE_TAB_TYPE)).toBe(false);
    });

    it('forgets the tables of a window that closes while another stays open, as Zotero forgets its tabs', () => {
        const win = windows[0];
        const other = fakeWindow();
        openTableTab(win, tableItem(51, T1.key), T1);
        windows = [other];
        win.closed = true;

        closeBeaverTabsForWindow(win);
        session.state = { windows: [{ type: 'pane', tabs: [] }] };
        win.Zotero_Tabs.closeAll();

        expect(prefs.get('beaverTabsToRestore') ?? '').toBe('');
    });

    it('keeps the list for a later load when the window never comes up', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        closeBeaverTabsForWindow(win);
        const open = startPlugin();
        win.__beaverRuntime.status = 'closing';

        await expect(restoreBeaverTabs(win)).resolves.toBe(0);

        expect(open).not.toHaveBeenCalled();
        expect(record().windows[0].tabs).toHaveLength(1);
    });

    it('waits for the renderer before taking the list', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        closeBeaverTabsForWindow(win);
        startPlugin();
        win.__beaverRuntime.status = 'attaching';
        (Zotero.Promise.delay as any).mockImplementationOnce(async () => {
            expect(record()).not.toBeNull();
            win.__beaverRuntime.status = 'ready';
        });

        await expect(restoreBeaverTabs(win)).resolves.toBe(1);
    });

    it('remembers the tabs plugin cleanup closes itself', () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        stopTabs({ saveSession: true });
        expect(record().windows[0].tabs).toEqual([{ kind: 'table', ref: T1, index: 1, selected: true }]);
    });

    it('ignores a record that is too old', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        closeBeaverTabsForWindow(win);
        const old = record();
        prefs.set('beaverTabsToRestore', JSON.stringify({ ...old, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
        const open = startPlugin();

        await expect(restoreBeaverTabs(win)).resolves.toBe(0);
        expect(open).not.toHaveBeenCalled();
        expect(prefs.get('beaverTabsToRestore')).toBe('');
    });

    it('keeps the tables a restore had yet to reopen when the plugin unloads during it, and opens no stray tab', async () => {
        const T3 = { libraryID: 1, key: 'TABLETRI' };
        const win = windows[0];
        win.Zotero_Tabs.add({ type: 'reader', data: { itemID: 7 } });
        openTableTab(win, tableItem(51, T1.key), T1, { background: true });
        openTableTab(win, tableItem(52, T2.key), T2, { background: true });
        openTableTab(win, tableItem(53, T3.key), T3);
        closeBeaverTabsForWindow(win);

        // The second open is still reading when the plugin unloads.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const inner = openingOpener();
        startPlugin(vi.fn(async (ref: any, options: any) => {
            if (ref.key === T2.key) await gate;
            return inner(ref, options).catch((error: unknown) => ({ error: String(error) }));
        }) as any);
        const running = restoreBeaverTabs(win);
        await vi.waitFor(() => expect(layout(win)).toEqual(['library:', 'reader:7', 'table:TABLEONE']));

        // Plugin shutdown: removeChatPanel, then cleanup.
        closeBeaverTabsForWindow(win);
        stopTabs();
        release();
        await expect(running).resolves.toBe(1);

        expect(layout(win)).toEqual(['library:', 'reader:7']);
        expect(record().windows[0].tabs).toEqual([
            { kind: 'table', ref: T1, index: 2, selected: false },
            { kind: 'table', ref: T2, index: 3, selected: false },
            { kind: 'table', ref: T3, index: 4, selected: true },
        ]);

        startPlugin();
        await expect(restoreBeaverTabs(win)).resolves.toBe(3);
        expect(layout(win)).toEqual(['library:', 'reader:7', 'table:TABLEONE', 'table:TABLETWO', 'table:TABLETRI']);
        expect(selected(win)).toBe('table:TABLETRI');
    });

    /** Starts a restore of T1, T2, T3 whose open of `slow` waits for `release`. */
    async function restoreWithSlowOpen(win: any, slow: string) {
        const T3 = { libraryID: 1, key: 'TABLETRI' };
        win.Zotero_Tabs.add({ type: 'reader', data: { itemID: 7 } });
        openTableTab(win, tableItem(51, T1.key), T1, { background: true });
        openTableTab(win, tableItem(52, T2.key), T2, { background: true });
        openTableTab(win, tableItem(53, T3.key), T3);
        closeBeaverTabsForWindow(win);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const inner = openingOpener();
        startPlugin(vi.fn(async (ref: any, options: any) => {
            // The tab is up before the open's repair finishes.
            const outcome = await inner(ref, options).catch((error: unknown) => ({ error: String(error) }));
            if (ref.key === slow) await gate;
            return outcome;
        }) as any);
        const running = restoreBeaverTabs(win);
        return { running, release, T3 };
    }

    it('keeps the tables already back and those still to come when the last window closes mid-restore', async () => {
        const win = windows[0];
        const { running, release, T3 } = await restoreWithSlowOpen(win, T2.key);
        await vi.waitFor(() => expect(layout(win)).toEqual(['library:', 'reader:7', 'table:TABLEONE', 'table:TABLETWO']));

        // Zotero's teardown first, then Beaver's unload.
        windows = [];
        win.closed = true;
        session.state = { windows: [{ type: 'pane', tabs: win.Zotero_Tabs.getState() }] };
        win.Zotero_Tabs.closeAll();
        closeBeaverTabsForWindow(win);
        release();
        await running;

        expect(record().windows[0].tabs.map((tab: any) => [tab.ref.key, tab.index])).toEqual([
            [T1.key, 2], [T2.key, 3], [T3.key, 4],
        ]);
    });

    it('does not record a restored tab the user closed while its open was still finishing', async () => {
        const win = windows[0];
        const { running, release } = await restoreWithSlowOpen(win, T2.key);
        await vi.waitFor(() => expect(layout(win)).toContain('table:TABLETWO'));

        win.Zotero_Tabs.close(findTabID(win, T2));
        closeBeaverTabsForWindow(win);
        release();
        await running;

        expect(record().windows[0].tabs.map((tab: any) => tab.ref.key)).toEqual([T1.key, 'TABLETRI']);
    });

    it('keeps the selected table selected when a reload interrupts the restore after it reopened', async () => {
        const win = windows[0];
        const { running, release } = await restoreWithSlowOpen(win, 'TABLETRI');
        await vi.waitFor(() => expect(layout(win)).toContain('table:TABLETRI'));
        expect(selected(win)).not.toBe('table:TABLETRI');

        closeBeaverTabsForWindow(win);
        stopTabs();
        release();
        await running;

        expect(record().windows[0].tabs.map((tab: any) => [tab.ref.key, tab.selected])).toEqual([
            [T1.key, false], [T2.key, false], ['TABLETRI', true],
        ]);
    });

    it('keeps a table whose open failed because its window was closing', async () => {
        const win = windows[0];
        const T3 = { libraryID: 1, key: 'TABLETRI' };
        openTableTab(win, tableItem(51, T1.key), T1, { background: true });
        openTableTab(win, tableItem(52, T2.key), T2, { background: true });
        openTableTab(win, tableItem(53, T3.key), T3);
        closeBeaverTabsForWindow(win);
        const inner = openingOpener();
        startPlugin(vi.fn(async (ref: any, options: any) => {
            if (ref.key !== T2.key) return inner(ref, options);
            // The last window closes while this open waits for it.
            windows = [];
            win.closed = true;
            return { error: 'Could not open table TABLETWO — no Zotero window is available to show it.' };
        }) as any);

        await restoreBeaverTabs(win);
        closeBeaverTabsForWindow(win);

        expect(record().windows[0].tabs.map((tab: any) => tab.ref.key)).toEqual([T1.key, T2.key, T3.key]);
    });

    it('keeps a table whose open failed because the plugin was shutting the window\'s renderer down', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1, { background: true });
        openTableTab(win, tableItem(52, T2.key), T2);
        closeBeaverTabsForWindow(win);
        const inner = openingOpener();
        startPlugin(vi.fn(async (ref: any, options: any) => {
            if (ref.key !== T2.key) return inner(ref, options);
            // Plugin shutdown marks the window closing before it closes the tabs.
            win.__beaverRuntime.status = 'closing';
            return { error: 'Could not open table TABLETWO — no Zotero window is available to show it.' };
        }) as any);

        await restoreBeaverTabs(win);
        closeBeaverTabsForWindow(win);

        expect(record().windows[0].tabs.map((tab: any) => [tab.ref.key, tab.selected])).toEqual([[T1.key, false], [T2.key, true]]);
    });

    it('selects nothing when the user closed the selected table while later ones opened', async () => {
        const win = windows[0];
        openTableTab(win, tableItem(51, T1.key), T1);
        openTableTab(win, tableItem(52, T2.key), T2, { background: true });
        closeBeaverTabsForWindow(win);
        const inner = openingOpener();
        startPlugin(vi.fn(async (ref: any, options: any) => {
            const outcome = await inner(ref, options);
            if (ref.key === T2.key) win.Zotero_Tabs.close(findTabID(win, T1));
            return outcome;
        }) as any);
        const select = vi.spyOn(win.Zotero_Tabs, 'select');

        await expect(restoreBeaverTabs(win)).resolves.toBe(2);

        expect(select).not.toHaveBeenCalled();
        expect(layout(win)).toEqual(['library:', 'table:TABLETWO']);
    });

    it('reopens a previous run\'s tables only in the first main window', async () => {
        const first = windows[0];
        const second = fakeWindow();
        windows.push(second);
        openTableTab(first, tableItem(51, T1.key), T1);
        quitObserver.observe();
        (Zotero as any).__beaverAppSessionID = 'a later run';
        try {
            startPlugin();
            // The second window's renderer is ready first.
            await expect(restoreBeaverTabs(second)).resolves.toBe(0);
            await expect(restoreBeaverTabs(first)).resolves.toBe(1);
        } finally {
            delete (Zotero as any).__beaverAppSessionID;
        }
        expect(layout(second)).toEqual(['library:']);
        expect(layout(first)).toEqual(['library:', 'table:TABLEONE']);
    });

    it('refuses to open a tab once torn down', () => {
        stopTabs();
        expect(() => openTableTab(windows[0], tableItem(51, T1.key), T1)).toThrow(/not running/);
        expect(windows[0].Zotero_Tabs.tabs).toHaveLength(1);
    });

    it('records only the Beaver tabs it tracks', () => {
        const win = windows[0];
        // A tab some other copy of the plugin left behind.
        win.Zotero_Tabs.add({ type: TABLE_TAB_TYPE, data: { itemID: 52, beaverTab: { kind: 'table', ref: T2 } } });
        openTableTab(win, tableItem(51, T1.key), T1);

        closeBeaverTabsForWindow(win);

        expect(record().windows[0].tabs).toEqual([{ kind: 'table', ref: T1, index: 2, selected: true }]);
    });

    function findTabID(win: any, ref: { key: string }) {
        return win.Zotero_Tabs.tabs.find((t: FakeTab) => t.data?.beaverTab?.ref?.key === ref.key)!.id;
    }
});
