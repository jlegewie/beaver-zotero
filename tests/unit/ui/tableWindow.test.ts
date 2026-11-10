// @vitest-environment jsdom
/**
 * The table window's plugin side: one window per table, its renderer and
 * table mounted once it loads, its native menus and edit controller driven
 * from the table's menu state, and closing, recording and reopening windows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key) ?? '',
    setPref: (key: string, value: unknown) => { prefs.set(key, value); },
}));

import {
    cleanupTableWindows,
    findTableWindow,
    initTableWindows,
    listTableWindows,
    onTableWindowCommand,
    onTableWindowLoad,
    onTableWindowMenuShowing,
    onTableWindowUnload,
    openTableWindow,
    restoreTableWindows,
    setTableWindowWarning,
} from '../../../src/ui/tableWindow';
import type { TableViewCommand, TableViewMenuState } from '../../../src/ui/tableTabTypes';

const REF = { libraryID: 1, key: 'TABLEKEY' };
const OTHER = { libraryID: 1, key: 'OTHERKEY' };
const SPEC = { id: 't', title: 'Spec title', columns: [], rows: [] } as any;

/** Every command off but the ones named. */
function enabled(...on: TableViewCommand[]): Record<TableViewCommand, boolean> {
    return new Proxy({} as Record<TableViewCommand, boolean>, {
        get: (_target, key) => on.includes(key as TableViewCommand),
    });
}

const STATE: TableViewMenuState = {
    enabled: enabled('export-csv', 'fill-pending'),
    density: 'cozy',
    fillAvailable: true,
};

function item(id = 42, key = REF.key) {
    return { id, key, libraryID: 1, getField: () => 'Item title' } as any;
}

interface FakeTableWindow {
    win: any;
    handle: any;
    state: TableViewMenuState;
}

/** A table window as `beaverTableWindow.xhtml` builds it, with a renderer that mounts a fake table. */
function fakeTableWindow(): FakeTableWindow {
    const doc = document.implementation.createHTMLDocument('table');
    const pane = doc.createElement('div');
    pane.id = 'beaver-pane-table-window';
    doc.body.appendChild(pane);
    for (const command of ['undo', 'fill-pending', 'fill-stop', 'export-csv', 'show-hidden-columns', 'add-column']) {
        const element = doc.createElement('command');
        element.setAttribute('data-table-command', command);
        doc.body.appendChild(element);
    }
    for (const density of ['compact', 'cozy', 'tall']) {
        const entry = doc.createElement('menuitem');
        entry.setAttribute('data-density', density);
        doc.body.appendChild(entry);
    }
    const fillEntry = doc.createElement('menuitem');
    fillEntry.setAttribute('data-table-fill', '');
    doc.body.appendChild(fillEntry);

    const fake: FakeTableWindow = { win: null, handle: null, state: { ...STATE } };
    fake.handle = {
        setWarning: vi.fn(),
        reload: vi.fn(),
        focus: vi.fn(),
        request: vi.fn(),
        selectionChanged: vi.fn(),
        command: vi.fn(() => true),
        menuState: vi.fn(() => fake.state),
    };
    const win: any = {
        closed: false,
        document: doc,
        screenX: 100,
        screenY: 100,
        focus: vi.fn(),
        moveBy: vi.fn(),
        close: vi.fn(() => { win.closed = true; }),
        controllers: { insertControllerAt: vi.fn(), removeController: vi.fn() },
        BeaverReact: {
            initializeRuntime: vi.fn(),
            renderTableTab: vi.fn(() => {
                pane.appendChild(doc.createElement('section'));
                return fake.handle;
            }),
            unmountFromElement: vi.fn(() => true),
            disposeRuntime: vi.fn(),
        },
    };
    fake.win = win;
    return fake;
}

/** Loads the window as its script does, then runs the renderer's bundle onload. */
function load(fake: FakeTableWindow): void {
    onTableWindowLoad(fake.win);
    const script = fake.win.document.querySelector('script[src="chrome://beaver/content/reactBundle.js"]');
    script?.onload?.();
}

let opened: FakeTableWindow[];
let next: FakeTableWindow[];
let notifier: any;
let quitObserver: any;
let runtimes: Map<any, any>;
let opener: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    prefs.clear();
    opened = [];
    next = [];
    runtimes = new Map();
    (globalThis as any).ChromeUtils = { generateQI: () => () => {} };
    (globalThis as any).Services = {
        ww: {
            openWindow: vi.fn(() => {
                const fake = next.shift() ?? fakeTableWindow();
                opened.push(fake);
                return fake.win;
            }),
        },
        obs: { addObserver: vi.fn((o: any) => { quitObserver = o; }), removeObserver: vi.fn() },
    };
    Object.assign(Zotero as any, {
        logError: vi.fn(),
        Notifier: {
            registerObserver: vi.fn((o: any) => { notifier = o; return 'beaver-table-window'; }),
            unregisterObserver: vi.fn(),
        },
        Beaver: {
            ...(Zotero as any).Beaver,
            mutations: { cancelOwner: vi.fn() },
            syncPause: { releaseWindow: vi.fn() },
            runtime: {
                attachWindow: vi.fn((win: any, kind: string) => {
                    const runtime = { id: `rt-${runtimes.size + 1}`, kind, status: 'attaching', hostWindow: win };
                    runtimes.set(win, runtime);
                    win.__beaverRuntime = runtime;
                    return runtime;
                }),
                getWindow: vi.fn((win: any) => runtimes.get(win)),
                markClosing: vi.fn((win: any) => {
                    const runtime = runtimes.get(win);
                    if (!runtime || runtime.status === 'closing') return false;
                    runtime.status = 'closing';
                    return true;
                }),
                detachWindow: vi.fn((win: any) => {
                    runtimes.delete(win);
                    delete win.__beaverRuntime;
                }),
            },
        },
    });
    opener = vi.fn(async () => ({ ok: true }));
    initTableWindows(opener);
});

afterEach(() => {
    cleanupTableWindows();
    prefs.clear();
});

describe('opening a table window', () => {
    it('opens one window per table and finds it before it has loaded', () => {
        const { win, reused } = openTableWindow(item(), REF, { initial: { spec: SPEC, version: 3 } });
        expect(reused).toBe(false);
        expect(Services.ww.openWindow).toHaveBeenCalledWith(
            null,
            'chrome://beaver/content/beaverTableWindow.xhtml',
            '_blank',
            expect.stringContaining('chrome'),
            null,
        );
        expect(findTableWindow(REF)).toBe(win);
        expect(findTableWindow(OTHER)).toBeNull();
    });

    it('brings the open window forward on a second open instead of opening another', () => {
        const first = openTableWindow(item(), REF);
        const second = openTableWindow(item(), REF);
        expect(second).toEqual({ win: first.win, reused: true });
        expect(first.win.focus).toHaveBeenCalledOnce();
        expect(Services.ww.openWindow).toHaveBeenCalledOnce();
    });

    it('mounts the table as a window surface once the window loads, with what the open read', () => {
        const focus = { rowId: 'r1', columnId: 'design' };
        const { win } = openTableWindow(item(), REF, { initial: { spec: SPEC, version: 3 }, focus });
        load(opened[0]);

        expect(win.__beaverRuntime).toMatchObject({ kind: 'table', status: 'ready' });
        expect(win.BeaverReact.initializeRuntime).toHaveBeenCalledWith(win.__beaverRuntime);
        const [container, ref, options] = win.BeaverReact.renderTableTab.mock.calls[0];
        expect(container.id).toBe('beaver-pane-table-window');
        expect(ref).toEqual(REF);
        expect(options).toMatchObject({ surface: 'window', initial: { spec: SPEC, version: 3 }, focus });
        expect(options.isSelected()).toBe(true);
        expect(win.document.title).toBe('Spec title');
        options.onTitle('Renamed');
        expect(win.document.title).toBe('Renamed');
        expect(listTableWindows()).toEqual([
            expect.objectContaining({ key: REF.key, title: 'Renamed', mounted: true, runtimeId: win.__beaverRuntime.id }),
        ]);
    });

    it('holds a warning, a cited cell and a fill request that arrive before the table mounts', () => {
        const { win } = openTableWindow(item(), REF);
        setTableWindowWarning(win, 'Behind.');
        const request = { kind: 'show_failed' as const, job_id: 'j', row_ids: ['r2'] };
        openTableWindow(item(), REF, { focus: { rowId: 'r2' }, request });
        load(opened[0]);

        const options = win.BeaverReact.renderTableTab.mock.calls[0][2];
        expect(options.focus).toEqual({ rowId: 'r2' });
        expect(options.request).toEqual(request);
        expect(opened[0].handle.setWarning).toHaveBeenCalledWith('Behind.');
    });

    it('reloads the mounted table and passes a cited cell to it when reused', () => {
        openTableWindow(item(), REF);
        load(opened[0]);
        openTableWindow(item(), REF, { focus: { rowId: 'r1' } });
        expect(opened[0].handle.reload).toHaveBeenCalledOnce();
        expect(opened[0].handle.focus).toHaveBeenCalledWith({ rowId: 'r1' });
    });

    it('moves a new window off another table window left at the same place', () => {
        openTableWindow(item(), REF);
        load(opened[0]);
        openTableWindow(item(43, OTHER.key), OTHER);
        load(opened[1]);
        expect(opened[0].win.moveBy).not.toHaveBeenCalled();
        expect(opened[1].win.moveBy).toHaveBeenCalledWith(26, 26);
    });

    it('closes a window it did not open', () => {
        const stray = fakeTableWindow();
        onTableWindowLoad(stray.win);
        expect(stray.win.close).toHaveBeenCalledOnce();
        expect(Zotero.Beaver.runtime.attachWindow).not.toHaveBeenCalled();
    });

    it('says so in the window when its renderer cannot start', () => {
        openTableWindow(item(), REF);
        const fake = opened[0];
        fake.win.BeaverReact = {};
        load(fake);
        expect(fake.win.document.querySelector('[role="alert"]')?.textContent).toContain('couldn’t show this table');
    });

    it('refuses to open a window once Beaver has shut its windows down', () => {
        cleanupTableWindows();
        expect(() => openTableWindow(item(), REF)).toThrow('Beaver is not running.');
    });
});

describe('closing', () => {
    it('unmounts the table, disposes the renderer and releases the window when it unloads', () => {
        const { win } = openTableWindow(item(), REF);
        load(opened[0]);
        const runtime = win.__beaverRuntime;
        onTableWindowUnload(win);

        expect(win.BeaverReact.unmountFromElement).toHaveBeenCalledWith(win.document.getElementById('beaver-pane-table-window'));
        expect(win.BeaverReact.disposeRuntime).toHaveBeenCalledOnce();
        expect(win.controllers.removeController).toHaveBeenCalledOnce();
        expect(Zotero.Beaver.mutations.cancelOwner).toHaveBeenCalledWith(runtime.id);
        expect(Zotero.Beaver.runtime.detachWindow).toHaveBeenCalledWith(win);
        expect(findTableWindow(REF)).toBeNull();
    });

    it('closes the window of a table moved to the trash or deleted', async () => {
        const { win } = openTableWindow(item(42), REF);
        const other = openTableWindow(item(43, OTHER.key), OTHER).win;
        await notifier.notify('modify', 'item', [42]);
        expect(win.close).not.toHaveBeenCalled();
        await notifier.notify('trash', 'item', [42]);
        expect(win.close).toHaveBeenCalledOnce();
        expect(other.close).not.toHaveBeenCalled();
        await notifier.notify('delete', 'item', [43]);
        expect(other.close).toHaveBeenCalledOnce();
    });
});

describe('native menus', () => {
    it('updates the commands, the row height and the fill entries as a menu opens', () => {
        const { win } = openTableWindow(item(), REF);
        const fake = opened[0];
        load(fake);
        fake.state = { enabled: enabled('undo', 'export-csv'), density: 'tall', fillAvailable: false };
        onTableWindowMenuShowing(win);

        const doc = win.document;
        const command = (name: string) => doc.querySelector(`command[data-table-command="${name}"]`)!;
        expect(command('undo').hasAttribute('disabled')).toBe(false);
        expect(command('export-csv').hasAttribute('disabled')).toBe(false);
        expect(command('show-hidden-columns').hasAttribute('disabled')).toBe(true);
        expect(command('fill-pending').hasAttribute('disabled')).toBe(true);

        expect(doc.querySelector('[data-density="tall"]')!.hasAttribute('checked')).toBe(true);
        expect(doc.querySelector('[data-density="cozy"]')!.hasAttribute('checked')).toBe(false);
        expect(doc.querySelector('[data-table-fill]')!.hasAttribute('hidden')).toBe(true);

        // Enabled again the next time the menu opens with the state allowing it.
        fake.state = { ...STATE, enabled: enabled('show-hidden-columns') };
        onTableWindowMenuShowing(win);
        expect(command('show-hidden-columns').hasAttribute('disabled')).toBe(false);
        expect(command('undo').hasAttribute('disabled')).toBe(true);
    });

    it('turns every command off in a window whose table has not mounted', () => {
        const { win } = openTableWindow(item(), REF);
        onTableWindowMenuShowing(win);
        const commands = Array.from(win.document.querySelectorAll('command[data-table-command]')) as Element[];
        expect(commands.every((element) => element.hasAttribute('disabled'))).toBe(true);
    });

    it("runs a menu command on the window's table", () => {
        const { win } = openTableWindow(item(), REF);
        load(opened[0]);
        onTableWindowCommand(win, 'export-csv');
        expect(opened[0].handle.command).toHaveBeenCalledWith('export-csv');
    });

    it("sends Edit's Undo, Copy and Select All to the table when no text field takes them", () => {
        const { win } = openTableWindow(item(), REF);
        const fake = opened[0];
        load(fake);
        const [index, controller] = win.controllers.insertControllerAt.mock.calls[0];
        expect(index).toBe(0);
        expect(controller.supportsCommand('cmd_undo')).toBe(true);
        expect(controller.supportsCommand('cmd_paste')).toBe(false);

        expect(controller.isCommandEnabled('cmd_undo')).toBe(false);
        controller.doCommand('cmd_undo');
        expect(fake.handle.command).not.toHaveBeenCalled();

        fake.state = { ...STATE, enabled: enabled('undo', 'copy-selection', 'select-all-rows') };
        expect(controller.isCommandEnabled('cmd_undo')).toBe(true);
        controller.doCommand('cmd_undo');
        controller.doCommand('cmd_copy');
        controller.doCommand('cmd_selectAll');
        expect(fake.handle.command.mock.calls.map((call: any[]) => call[0])).toEqual(['undo', 'copy-selection', 'select-all-rows']);
    });
});

describe('reopening windows after a quit or a reload', () => {
    it('records the open windows when Beaver shuts down and reopens them once', async () => {
        openTableWindow(item(), REF);
        openTableWindow(item(43, OTHER.key), OTHER);
        cleanupTableWindows();
        expect(opened.every((fake) => fake.win.close.mock.calls.length === 1)).toBe(true);
        expect(JSON.parse(String(prefs.get('tableWindowsToRestore'))).tables).toEqual([REF, OTHER]);

        initTableWindows(opener);
        await expect(restoreTableWindows()).resolves.toBe(2);
        expect(opener.mock.calls.map((call) => call[0])).toEqual([REF, OTHER]);
        expect(prefs.get('tableWindowsToRestore')).toBe('');
        await expect(restoreTableWindows()).resolves.toBe(0);
    });

    it('records the open windows when Zotero quits', () => {
        openTableWindow(item(), REF);
        quitObserver.observe();
        expect(JSON.parse(String(prefs.get('tableWindowsToRestore'))).tables).toEqual([REF]);
    });

    it('keeps a record when shutting down with no window open', () => {
        prefs.set('tableWindowsToRestore', JSON.stringify({ savedAt: Date.now(), tables: [REF] }));
        cleanupTableWindows();
        expect(JSON.parse(String(prefs.get('tableWindowsToRestore'))).tables).toEqual([REF]);
    });

    it('ignores and clears a record too old or not a list of tables', async () => {
        prefs.set('tableWindowsToRestore', JSON.stringify({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, tables: [REF] }));
        await expect(restoreTableWindows()).resolves.toBe(0);
        expect(prefs.get('tableWindowsToRestore')).toBe('');
        prefs.set('tableWindowsToRestore', JSON.stringify({ savedAt: Date.now(), tables: [{ key: 7 }] }));
        await expect(restoreTableWindows()).resolves.toBe(0);
        expect(opener).not.toHaveBeenCalled();
    });

    it('counts a table that could not be reopened as not restored', async () => {
        prefs.set('tableWindowsToRestore', JSON.stringify({ savedAt: Date.now(), tables: [REF, OTHER] }));
        opener.mockResolvedValueOnce({ error: 'gone' });
        await expect(restoreTableWindows()).resolves.toBe(1);
    });
});
