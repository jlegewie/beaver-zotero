/**
 * The bookkeeping behind the two hosts a rendered table document lives in.
 *
 * `src/ui/tableTab.ts` and `view/readerTableView.ts` each keep a module-level
 * registry of what they have mounted, which is the whole reason the `tablesApi`
 * seam exists: a second copy of either module is a second registry that nothing
 * closes, and every entry it holds is a window, an iframe and a whole rendered
 * document that cannot be collected.
 *
 * So what is tested here is the releasing, not the mounting: that closing drops
 * the entry *and* the surface it held, that a per-window close leaves other
 * windows alone, and that disposing twice is harmless — a plugin reload and a
 * macOS last-window close both run these paths more than once.
 *
 * The enhancer is mocked. Its own behaviour is covered by
 * `tests/unit/artifacts/enhanceTableDocument.test.ts`; what matters here is
 * only that the undo function it hands back is called exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enhanceTableDocument = vi.hoisted(() => vi.fn());
const countCitationMarkers = vi.hoisted(() => vi.fn(() => 3));
const isTableItem = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/services/artifacts/view/enhanceTableDocument', () => ({
    enhanceTableDocument,
    countCitationMarkers,
}));

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    isTableItem,
    loadTableItemFields: vi.fn(async () => undefined),
}));

import type { TableSpec } from '@beaver/agent-core/layouts/table';
import {
    closeAllTableTabs,
    closeTableTab,
    closeTableTabsForWindow,
    listTableTabViews,
    openTableTab,
} from '../../../src/ui/tableTab';
import {
    cleanupReaderTableViews,
    cleanupReaderTableViewsForWindow,
    listReaderTableViews,
    openTableInReader,
} from '../../../src/services/artifacts/view/readerTableView';

const SPEC: TableSpec = {
    id: 'demo',
    key: 'TBL00001',
    title: 'Demo table',
    columns: [{ id: 'note', header: 'Note', type: 'text' }],
    rows: [
        {
            id: 'r1',
            cells: { note: { value: { kind: 'text', text: 'One' }, provenance: 'asserted' } },
        },
    ],
};

let savedZotero: any;
/** Tab ids are unique across windows, the way Zotero's deck makes them. */
let nextTabID = 0;

/** A document the tab's load wait accepts immediately. */
function loadedDocument(): any {
    return {
        documentURI: 'about:srcdoc',
        readyState: 'complete',
        documentElement: { getAttribute: () => '1' },
        querySelectorAll: () => ({ length: 0 }),
    };
}

interface FakeIframe {
    setAttribute: ReturnType<typeof vi.fn>;
    removeAttribute: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    contentDocument: any;
    style: { cssText: string };
    getBoundingClientRect: () => any;
    parentElement: any;
}

interface FakeWindow {
    win: any;
    iframes: FakeIframe[];
    close: ReturnType<typeof vi.fn>;
}

/** A chrome window with just the `Zotero_Tabs` surface the tab host uses. */
function fakeWindow(): FakeWindow {
    const iframes: FakeIframe[] = [];
    const close = vi.fn();
    const win: any = {
        document: {
            createElementNS: () => {
                const iframe: FakeIframe = {
                    setAttribute: vi.fn(),
                    removeAttribute: vi.fn(),
                    remove: vi.fn(),
                    contentDocument: loadedDocument(),
                    style: { cssText: '' },
                    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
                    parentElement: null,
                };
                iframes.push(iframe);
                return iframe;
            },
        },
        setTimeout: vi.fn(),
        Zotero_Tabs: {
            add: (options: any) => ({
                id: options.id ?? `tab-${++nextTabID}`,
                container: { appendChild: vi.fn() },
            }),
            close,
            select: vi.fn(),
        },
    };
    return { win, iframes, close };
}

/** A reader instance shaped enough for the enhancement to reach its document. */
function fakeReader(win: any, itemID: number, tabID: string): any {
    const view = {
        initializedPromise: Promise.resolve(),
        initialized: true,
        _iframeDocument: loadedDocument(),
        _iframe: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) },
    };
    return {
        type: 'snapshot',
        itemID,
        tabID,
        _window: win,
        _internalReader: { _primaryView: view },
        _iframe: {
            parentElement: {},
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        },
    };
}

function tableItem(id: number, key: string): any {
    return { id, key, libraryID: 1 };
}

beforeEach(() => {
    savedZotero = (globalThis as any).Zotero;
    vi.clearAllMocks();
    nextTabID = 0;
    isTableItem.mockReturnValue(true);
    countCitationMarkers.mockReturnValue(3);
});

afterEach(() => {
    closeAllTableTabs();
    cleanupReaderTableViews();
    (globalThis as any).Zotero = savedZotero;
});

// ---------------------------------------------------------------------------
// The tab registry
// ---------------------------------------------------------------------------

describe('the table tab registry', () => {
    let main: FakeWindow;
    let dispose: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        main = fakeWindow();
        dispose = vi.fn();
        enhanceTableDocument.mockReturnValue(dispose);
        (globalThis as any).Zotero = {
            ...savedZotero,
            getMainWindow: () => main.win,
        };
    });

    it('releases the entry, the document and the iframe when a tab closes', () => {
        const id = openTableTab(SPEC)!;
        expect(listTableTabViews()).toEqual([
            { host: 'tab', id, key: 'TBL00001', markers: 3 },
        ]);

        closeTableTab(id);

        expect(listTableTabViews()).toEqual([]);
        // The enhancer's undo, then the document, then the element: a tab left
        // in the map holds its whole rendered document alive.
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(main.iframes[0].removeAttribute).toHaveBeenCalledWith('srcdoc');
        expect(main.iframes[0].remove).toHaveBeenCalledTimes(1);
        expect(main.close).toHaveBeenCalledWith(id);
    });

    it('closes a tab once, however many times it is asked', () => {
        const id = openTableTab(SPEC)!;

        closeTableTab(id);
        closeTableTab(id);

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(main.iframes[0].remove).toHaveBeenCalledTimes(1);
        expect(main.close).toHaveBeenCalledTimes(1);
    });

    it('leaves other windows\' tabs alone when one window unloads', () => {
        const other = fakeWindow();
        const mine = openTableTab(SPEC, { win: main.win })!;
        const theirs = openTableTab(SPEC, { win: other.win })!;

        closeTableTabsForWindow(main.win);

        expect(listTableTabViews().map((view) => view.id)).toEqual([theirs]);
        expect(main.iframes[0].remove).toHaveBeenCalledTimes(1);
        expect(other.iframes[0].remove).not.toHaveBeenCalled();
        // The window is taking its own tabs with it, so the deck is not asked.
        expect(main.close).not.toHaveBeenCalled();
        expect(mine).not.toBe(theirs);
    });

    it('closes every window\'s tabs at shutdown', () => {
        const other = fakeWindow();
        openTableTab(SPEC, { win: main.win });
        openTableTab(SPEC, { win: other.win });

        closeAllTableTabs();

        expect(listTableTabViews()).toEqual([]);
        expect(dispose).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// The reader registry
// ---------------------------------------------------------------------------

describe('the reader table view registry', () => {
    let readers: any[];
    let dispose: ReturnType<typeof vi.fn>;
    let main: FakeWindow;

    beforeEach(() => {
        readers = [];
        main = fakeWindow();
        dispose = vi.fn();
        enhanceTableDocument.mockReturnValue(dispose);
        (globalThis as any).Zotero = {
            ...savedZotero,
            Beaver: { data: { config: { addonID: 'beaver@test' } } },
            getMainWindow: () => main.win,
            Items: { get: (id: number) => tableItem(id, `KEY${id}`) },
            Reader: {
                _readers: readers,
                open: vi.fn(async (itemID: number) => {
                    readers.push(fakeReader(main.win, itemID, `tab-${itemID}`));
                }),
            },
        };
    });

    it('drops the view when its reader leaves the registry', async () => {
        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));
        expect(diagnostics.enhanced).toBe(true);
        expect(listReaderTableViews()).toHaveLength(1);

        // The tab closed: the reader is spliced out and the notifier prunes.
        readers.length = 0;

        expect(listReaderTableViews()).toEqual([]);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes only the views hosted in the window that is unloading', async () => {
        const other = fakeWindow();
        await openTableInReader(tableItem(1, 'KEY1'));
        readers.push(fakeReader(other.win, 2, 'tab-2'));
        await openTableInReader(tableItem(2, 'KEY2'));
        expect(listReaderTableViews()).toHaveLength(2);

        cleanupReaderTableViewsForWindow(other.win);

        expect(listReaderTableViews().map((view) => view.key)).toEqual(['KEY1']);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes each view once, however many times cleanup runs', async () => {
        await openTableInReader(tableItem(1, 'KEY1'));

        cleanupReaderTableViews();
        cleanupReaderTableViews();

        expect(listReaderTableViews()).toEqual([]);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('survives an undo that throws, and still forgets the view', async () => {
        dispose.mockImplementation(() => {
            throw new Error('the reader is already gone');
        });
        await openTableInReader(tableItem(1, 'KEY1'));

        expect(() => cleanupReaderTableViews()).not.toThrow();
        expect(listReaderTableViews()).toEqual([]);
    });
});
