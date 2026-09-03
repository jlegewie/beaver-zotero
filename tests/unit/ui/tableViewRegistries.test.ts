/**
 * The bookkeeping behind the host a rendered table document lives in.
 *
 * `view/readerTableView.ts` keeps a module-level registry of what it has
 * enhanced, which is the whole reason the `tablesApi` seam exists: a second
 * copy of that module is a second registry that nothing closes, and every entry
 * it holds is a window, an iframe and a whole rendered document that cannot be
 * collected.
 *
 * So what is tested here is the releasing, not the mounting: that a reader going
 * away drops the entry *and* everything attached to it, that a per-window close
 * leaves other windows alone, and that disposing twice is harmless — a plugin
 * reload and a macOS last-window close both run these paths more than once.
 * The annotation lock is part of that contract: it is reader *state* rather than
 * something merely added, so it has to come back exactly when it was set.
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

import {
    cleanupReaderTableViews,
    cleanupReaderTableViewsForWindow,
    listReaderTableViews,
    openTableInReader,
} from '../../../src/services/artifacts/view/readerTableView';

let savedZotero: any;

/** A document the enhancement accepts immediately. */
function loadedDocument(): any {
    return {
        documentURI: 'about:srcdoc',
        readyState: 'complete',
        documentElement: { getAttribute: () => '1' },
        querySelectorAll: () => ({ length: 0 }),
    };
}

interface FakeWindow {
    win: any;
    close: ReturnType<typeof vi.fn>;
}

/** A chrome window, as much of one as the reader host touches. */
function fakeWindow(): FakeWindow {
    const close = vi.fn();
    const win: any = { setTimeout: vi.fn(), close };
    return { win, close };
}

/**
 * A reader instance shaped enough for the enhancement to reach its document.
 *
 * `iframeDocument` is the reader's public getter and the one the host prefers;
 * `_iframeDocument` is the same object, so a build that has only the private
 * field behaves identically.
 */
function fakeReader(
    win: any,
    itemID: number,
    tabID: string | undefined,
    options: {
        /** The reader's live `_state.readOnly` — what `setReadOnly` writes. */
        readOnly?: boolean;
        /**
         * What `_isReadOnly()` answers, only consulted when `_state` carries no
         * boolean. `'absent'` removes the method; `'throws'` makes it raise.
         * A real reader returns `undefined` (not `false`) for an editable,
         * un-trashed, parentless attachment — see `readerReadOnly`.
         */
        isReadOnly?: boolean | undefined | 'absent' | 'throws';
        /** `'no-state'` drops `_state`, forcing the fallback branch. */
        state?: 'no-state';
        setReadOnly?: unknown;
    } = {}
): any {
    const doc = loadedDocument();
    const view = {
        initializedPromise: Promise.resolve(),
        initialized: true,
        iframeDocument: doc,
        _iframeDocument: doc,
        _iframe: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) },
    };
    const setReadOnly = 'setReadOnly' in options ? options.setReadOnly : vi.fn();
    const internal: any = { _primaryView: view, setReadOnly };
    if (options.state !== 'no-state') internal._state = { readOnly: options.readOnly === true };

    const reader: any = {
        type: 'snapshot',
        itemID,
        tabID,
        // What `listReaderTableViews` falls back to when there is no tab.
        _instanceID: `instance-${itemID}`,
        _window: win,
        _internalReader: internal,
        _iframe: {
            parentElement: {},
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        },
    };
    if (options.isReadOnly === 'throws') {
        reader._isReadOnly = () => {
            throw new Error('item is gone');
        };
    } else if (options.isReadOnly !== 'absent') {
        reader._isReadOnly = () => options.isReadOnly;
    }
    return reader;
}

function tableItem(id: number, key: string): any {
    return { id, key, libraryID: 1 };
}

beforeEach(() => {
    savedZotero = (globalThis as any).Zotero;
    vi.clearAllMocks();
    isTableItem.mockReturnValue(true);
    countCitationMarkers.mockReturnValue(3);
});

afterEach(() => {
    cleanupReaderTableViews();
    (globalThis as any).Zotero = savedZotero;
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

// ---------------------------------------------------------------------------
// The annotation lock
// ---------------------------------------------------------------------------

describe('locking a table reader against annotations', () => {
    let readers: any[];
    let main: FakeWindow;

    function stub(reader: any): void {
        readers = [reader];
        (globalThis as any).Zotero = {
            ...savedZotero,
            Beaver: { data: { config: { addonID: 'beaver@test' } } },
            getMainWindow: () => main.win,
            Items: { get: (id: number) => tableItem(id, `KEY${id}`) },
            Reader: { _readers: readers, open: vi.fn(async () => undefined) },
        };
    }

    beforeEach(() => {
        main = fakeWindow();
        enhanceTableDocument.mockReturnValue(vi.fn());
    });

    it('turns the annotation tools off, and back on when the view goes', async () => {
        const reader = fakeReader(main.win, 1, 'tab-1');
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.annotationsDisabled).toBe(true);
        expect(reader._internalReader.setReadOnly).toHaveBeenCalledWith(true);

        cleanupReaderTableViews();

        // Restored, not left behind: this is the one piece of reader state the
        // module changes, so a plugin teardown has to give it back.
        expect(reader._internalReader.setReadOnly).toHaveBeenLastCalledWith(false);
        expect(reader._internalReader.setReadOnly).toHaveBeenCalledTimes(2);
    });

    it('leaves an already read-only reader alone, so it is not unlocked later', async () => {
        const reader = fakeReader(main.win, 1, 'tab-1', { readOnly: true });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.annotationsDisabled).toBe(false);
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();

        cleanupReaderTableViews();

        // Restoring blindly to `false` would *grant* annotation tools on a
        // table Zotero had already locked.
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();
    });

    it('still enhances a build with no setReadOnly, and says which seam was missing', async () => {
        const reader = fakeReader(main.win, 1, 'tab-1', { setReadOnly: undefined });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.annotationsDisabled).toBe(false);
        expect(diagnostics.failures).toContain('set_read_only_unavailable');
    });

    it('still enhances when the lock throws, and does not try to undo it', async () => {
        const setReadOnly = vi.fn(() => {
            throw new Error('reader is mid-teardown');
        });
        const reader = fakeReader(main.win, 1, 'tab-1', { setReadOnly });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.annotationsDisabled).toBe(false);
        expect(diagnostics.failures.some((f) => f.startsWith('set_read_only_failed'))).toBe(
            true
        );

        cleanupReaderTableViews();
        expect(setReadOnly).toHaveBeenCalledTimes(1);
    });

    it('leaves the reader untouched when the enhancement itself fails', async () => {
        enhanceTableDocument.mockImplementation(() => {
            throw new Error('no card mount');
        });
        const reader = fakeReader(main.win, 1, 'tab-1');
        stub(reader);

        // A short deadline: the driver retries until one succeeds, and here
        // none ever will.
        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'), {
            timeoutMs: 50,
        });

        expect(diagnostics.enhanced).toBe(false);
        // Nothing was registered to undo, so nothing may have been changed.
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Which read-only signal is believed
// ---------------------------------------------------------------------------

describe('reading the reader\'s read-only state', () => {
    let readers: any[];
    let main: FakeWindow;

    function stub(reader: any): void {
        readers = [reader];
        (globalThis as any).Zotero = {
            ...savedZotero,
            Beaver: { data: { config: { addonID: 'beaver@test' } } },
            getMainWindow: () => main.win,
            Items: { get: (id: number) => tableItem(id, `KEY${id}`) },
            Reader: { _readers: readers, open: vi.fn(async () => undefined) },
        };
    }

    beforeEach(() => {
        main = fakeWindow();
        enhanceTableDocument.mockReturnValue(vi.fn());
    });

    it('believes _state.readOnly over _isReadOnly, and so does not unlock a locked reader', async () => {
        // The disagreement this exists for: the reader was opened on a trashed
        // item (`_state.readOnly` true from `_open`) and the item has since been
        // restored, so `_isReadOnly()` — which *recomputes* editability — now
        // says false. Believing it would register an undo that later granted
        // annotation tools on a reader Zotero had locked.
        const reader = fakeReader(main.win, 1, 'tab-1', {
            readOnly: true,
            isReadOnly: false,
        });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.annotationsDisabled).toBe(false);
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();

        cleanupReaderTableViews();
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();
    });

    it('believes _state.readOnly over _isReadOnly, and so re-locks a reader Zotero would not', async () => {
        // The other direction: the item was trashed under an open reader, so
        // `_isReadOnly()` says true while the reader is still writable. The old
        // check declined here and left the table annotatable for the session.
        const reader = fakeReader(main.win, 1, 'tab-1', {
            readOnly: false,
            isReadOnly: true,
        });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.annotationsDisabled).toBe(true);
        expect(reader._internalReader.setReadOnly).toHaveBeenCalledWith(true);
    });

    it('falls back to _isReadOnly, treating its undefined as writable', async () => {
        // A real `_isReadOnly()` returns `undefined`, not `false`, for an
        // editable un-trashed parentless attachment — every stored table — so
        // only an explicit `true` may count as locked.
        const reader = fakeReader(main.win, 1, 'tab-1', {
            state: 'no-state',
            isReadOnly: undefined,
        });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.annotationsDisabled).toBe(true);
        expect(reader._internalReader.setReadOnly).toHaveBeenCalledWith(true);
    });

    it('changes nothing when neither signal can be read', async () => {
        const reader = fakeReader(main.win, 1, 'tab-1', {
            state: 'no-state',
            isReadOnly: 'absent',
        });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.annotationsDisabled).toBe(false);
        expect(diagnostics.failures).toContain('read_only_state_unreadable');
        // "No state was read" is not "the state is writable": an undo built on
        // an assumption is what grants tools the reader never had.
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();
    });

    it('changes nothing when the fallback throws', async () => {
        const reader = fakeReader(main.win, 1, 'tab-1', {
            state: 'no-state',
            isReadOnly: 'throws',
        });
        stub(reader);

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.failures).toContain('read_only_state_unreadable');
        expect(reader._internalReader.setReadOnly).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Reader windows
// ---------------------------------------------------------------------------

describe('a table hosted in a reader window', () => {
    let readers: any[];
    let main: FakeWindow;
    let listeners: Array<{ type: string; handler: (event?: unknown) => void }>;
    let readerWin: any;

    beforeEach(() => {
        main = fakeWindow();
        listeners = [];
        // A reader window is not the main window and is not covered by the tab
        // notifier, so it carries its own `unload` listener.
        readerWin = {
            setTimeout: vi.fn(),
            addEventListener: vi.fn((type: string, handler: any) => {
                listeners.push({ type, handler });
            }),
            removeEventListener: vi.fn(),
        };
        enhanceTableDocument.mockReturnValue(vi.fn());
        // No `tabID`: that is what marks a window-hosted reader.
        readers = [fakeReader(readerWin, 1, undefined)];
        (globalThis as any).Zotero = {
            ...savedZotero,
            Beaver: { data: { config: { addonID: 'beaver@test' } } },
            getMainWindow: () => main.win,
            Items: { get: (id: number) => tableItem(id, `KEY${id}`) },
            Reader: { _readers: readers, open: vi.fn(async () => undefined) },
        };
    });

    it('registers an unload listener on its own window', async () => {
        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.failures).not.toContain('window_unload_listener_failed');
        expect(listeners.map((l) => l.type)).toEqual(['unload']);
    });

    it('identifies the view by instance id, having no tab id to use', async () => {
        await openTableInReader(tableItem(1, 'KEY1'));

        expect(listReaderTableViews()).toEqual([
            { id: 'instance-1', key: 'KEY1', markers: 3 },
        ]);
    });

    it('disposes the view when that window unloads, including the annotation lock', async () => {
        await openTableInReader(tableItem(1, 'KEY1'));
        const reader = readers[0];
        expect(reader._internalReader.setReadOnly).toHaveBeenCalledWith(true);
        expect(listReaderTableViews()).toHaveLength(1);

        // `ReaderWindow.close()` splices `_readers` through its own `onClose`
        // and fires no notifier, so this listener is the only signal.
        readers.length = 0;
        listeners.find((l) => l.type === 'unload')!.handler();

        expect(listReaderTableViews()).toEqual([]);
        expect(reader._internalReader.setReadOnly).toHaveBeenLastCalledWith(false);
    });

    it('still enhances when the unload listener cannot be attached, and says so', async () => {
        readerWin.addEventListener = () => {
            throw new Error('window is already gone');
        };

        const diagnostics = await openTableInReader(tableItem(1, 'KEY1'));

        // A listener that cannot be attached is named and survived, not fatal:
        // the table is still enhanced, registered and fully disposable. Only
        // the automatic release is lost, so this view now depends on an
        // explicit cleanup — which is why the failure is reported rather than
        // swallowed.
        expect(diagnostics.enhanced).toBe(true);
        expect(diagnostics.failures).toContain('window_unload_listener_failed');
        expect(listReaderTableViews()).toHaveLength(1);

        cleanupReaderTableViews();
        expect(readers[0]._internalReader.setReadOnly).toHaveBeenLastCalledWith(false);
    });
});
