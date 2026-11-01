/**
 * Readers on a stored table are handed to the Beaver tab.
 *
 * `view/readerTableView.ts` listens to the reader's `renderToolbar` event and
 * sweeps the readers already open; `tableTab.ts` registers what a hand-over
 * does. What is tested here is the deciding: a reader on a table goes to the
 * redirect once, both kinds of reader (a tab and a window), every other reader
 * is left alone, and a reader stays the static page when no redirect is
 * registered or it fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isTableItem = vi.hoisted(() => vi.fn((item: any) => item?.table === true));

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    isTableItem,
    loadTableItemFields: vi.fn(async () => undefined),
}));

import {
    cleanupTableReaderRedirect,
    initTableReaderRedirect,
    setTableReaderRedirect,
} from '../../../src/services/artifacts/view/readerTableView';

let savedZotero: any;
let readers: any[];
let listeners: Array<{ type: string; handler: (event: any) => void }>;

/** A reader Zotero has open: in its registry, with a live window. */
function reader(itemID: number, options: { tabID?: string; type?: string } = {}): any {
    const opened = { type: options.type ?? 'snapshot', itemID, tabID: options.tabID, _window: { closed: false } };
    readers.push(opened);
    return opened;
}

/** Fires `renderToolbar` for a reader, as Zotero does. */
function render(target: any): void {
    for (const listener of listeners) if (listener.type === 'renderToolbar') listener.handler({ reader: target });
}

beforeEach(() => {
    savedZotero = (globalThis as any).Zotero;
    vi.clearAllMocks();
    readers = [];
    listeners = [];
    (globalThis as any).Zotero = {
        ...savedZotero,
        Beaver: { data: { config: { addonID: 'beaver@test' } } },
        // Items 1–9 are tables, 10 and up are not.
        Items: { get: (id: number) => ({ id, key: `KEY${id}`, libraryID: 1, table: id < 10 }) },
        Reader: {
            _readers: readers,
            get _registeredListeners() {
                return listeners;
            },
            set _registeredListeners(next: any[]) {
                listeners = next;
            },
            registerEventListener: vi.fn((type: string, handler: any) => {
                listeners.push({ type, handler });
            }),
        },
    };
});

afterEach(() => {
    cleanupTableReaderRedirect();
    setTableReaderRedirect(null);
    (globalThis as any).Zotero = savedZotero;
});

describe('readers on a stored table', () => {
    it('hands a reader tab and a reader window on a table to the redirect', async () => {
        const redirect = vi.fn(() => true);
        setTableReaderRedirect(redirect);
        initTableReaderRedirect();
        const tab = reader(1, { tabID: 'tab-1' });
        const win = reader(2);
        render(tab);
        render(win);
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledTimes(2));
        expect(redirect).toHaveBeenCalledWith(tab, expect.objectContaining({ id: 1, key: 'KEY1' }));
        expect(redirect).toHaveBeenCalledWith(win, expect.objectContaining({ id: 2, key: 'KEY2' }));
    });

    it('decides each reader once, however often its toolbar renders', async () => {
        const redirect = vi.fn(() => false);
        setTableReaderRedirect(redirect);
        initTableReaderRedirect();
        const target = reader(3);
        render(target);
        render(target);
        render(target);
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(redirect).toHaveBeenCalledOnce();
    });

    it('leaves readers that are not on a table alone', async () => {
        const redirect = vi.fn(() => true);
        setTableReaderRedirect(redirect);
        initTableReaderRedirect();
        render(reader(11));
        render(reader(4, { type: 'pdf' }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(redirect).not.toHaveBeenCalled();
        // A PDF reader is never looked up at all.
        expect(isTableItem).toHaveBeenCalledTimes(1);
    });

    it('sweeps the readers already open when it starts', async () => {
        const redirect = vi.fn(() => true);
        setTableReaderRedirect(redirect);
        const open = reader(5);
        reader(12);
        initTableReaderRedirect();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith(open, expect.objectContaining({ id: 5 })));
        expect(redirect).toHaveBeenCalledOnce();
    });

    it('leaves the reader on the static page while no redirect is registered', async () => {
        initTableReaderRedirect();
        const target = reader(6);
        render(target);
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Once a redirect exists, the same reader is still handed over.
        const redirect = vi.fn(() => true);
        setTableReaderRedirect(redirect);
        render(target);
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith(target, expect.anything()));
    });

    it('leaves a reader the user closed while its item loaded', async () => {
        const redirect = vi.fn(() => true);
        setTableReaderRedirect(redirect);
        initTableReaderRedirect();
        const closedWindow = reader(8);
        const closedTab = reader(9, { tabID: 'tab-9' });
        render(closedWindow);
        render(closedTab);
        // Closed before the item's fields finished loading.
        closedWindow._window.closed = true;
        closedTab._isTabClosed = true;
        const gone = reader(7);
        render(gone);
        readers.splice(readers.indexOf(gone), 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(redirect).not.toHaveBeenCalled();
    });

    it('keeps a redirect that throws from breaking the reader', async () => {
        setTableReaderRedirect(() => {
            throw new Error('no window');
        });
        initTableReaderRedirect();
        expect(() => render(reader(7))).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('registers one listener, and removes it on cleanup however often that runs', () => {
        initTableReaderRedirect();
        initTableReaderRedirect();
        expect(listeners.filter((l) => l.type === 'renderToolbar')).toHaveLength(1);
        expect(Zotero.Reader.registerEventListener).toHaveBeenLastCalledWith('renderToolbar', expect.any(Function), 'beaver@test');
        cleanupTableReaderRedirect();
        cleanupTableReaderRedirect();
        expect(listeners).toHaveLength(0);
    });
});
