// @vitest-environment jsdom
/**
 * Zotero's "Open Snapshot in New Tab/Window" item menu entries, named for
 * Beaver tables when the whole selection is tables.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    isTableItem: (item: { table?: boolean; broken?: boolean }) => {
        if (item.broken) throw new Error('Item data not loaded');
        return !!item.table;
    },
}));

import {
    attachTableOpenLabels,
    detachAllTableOpenLabels,
    detachTableOpenLabels,
    labelTableOpenEntries,
} from '../../../src/modules/tableOpenMenuLabel';

const Z = (globalThis as any).Zotero;
const table = { table: true, libraryID: 1, key: 'TABLEKEY' } as unknown as Zotero.Item;
const snapshot = { table: false } as unknown as Zotero.Item;

let popup: HTMLElement;
let setAttributes: ReturnType<typeof vi.fn>;

function addEntry(args: Record<string, unknown>, l10nId = 'item-menu-viewAttachment'): HTMLElement {
    const entry = document.createElement('menuitem');
    entry.setAttribute('data-l10n-id', l10nId);
    entry.setAttribute('data-l10n-args', JSON.stringify(args));
    popup.appendChild(entry);
    return entry;
}

beforeEach(() => {
    vi.clearAllMocks();
    Z.locale = 'en-US';
    popup = document.createElement('menupopup');
    document.body.appendChild(popup);
    setAttributes = vi.fn((el: Element, id: string, args: object) => {
        el.setAttribute('data-l10n-id', id);
        el.setAttribute('data-l10n-args', JSON.stringify(args));
    });
    (document as any).l10n = { setAttributes };
});

afterEach(() => {
    detachAllTableOpenLabels();
    popup.remove();
    delete (document as any).l10n;
});

describe('labelling the open entries of a table', () => {
    it('names a single table in both the tab and the window entry', () => {
        const tab = addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        const win = addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'window' });

        labelTableOpenEntries(popup, [table]);

        expect(setAttributes).toHaveBeenCalledWith(tab, 'beaver-item-menu-view-table', { count: 1, openIn: 'tab' });
        expect(setAttributes).toHaveBeenCalledWith(win, 'beaver-item-menu-view-table', { count: 1, openIn: 'window' });
    });

    it('counts several selected tables', () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 2, openIn: 'tab' });
        labelTableOpenEntries(popup, [table, table]);
        expect(setAttributes).toHaveBeenCalledWith(expect.anything(), 'beaver-item-menu-view-table', { count: 2, openIn: 'tab' });
    });

    it("keeps Zotero's label when the selection mixes tables and other snapshots", () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 2, openIn: 'tab' });
        labelTableOpenEntries(popup, [table, snapshot]);
        expect(setAttributes).not.toHaveBeenCalled();
    });

    it('treats an item that cannot be checked as not a table', () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        labelTableOpenEntries(popup, [{ broken: true } as unknown as Zotero.Item]);
        expect(setAttributes).not.toHaveBeenCalled();
    });

    it('leaves an entry that opens the file in an external viewer', () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'external' });
        labelTableOpenEntries(popup, [table]);
        expect(setAttributes).not.toHaveBeenCalled();
    });

    it("leaves Zotero's other entries and unknown argument shapes alone", () => {
        addEntry({ attachmentType: 'snapshot', openIn: 'tab' }, 'menu-file-show-in-finder');
        addEntry({ attachmentType: 'pdf', numAttachments: 1, openIn: 'tab' });
        const broken = addEntry({});
        broken.setAttribute('data-l10n-args', '{not json');

        labelTableOpenEntries(popup, [table]);

        expect(setAttributes).not.toHaveBeenCalled();
    });

    it("keeps Zotero's translated label in a language Beaver has no strings for", () => {
        Z.locale = 'de';
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        labelTableOpenEntries(popup, [table]);
        expect(setAttributes).not.toHaveBeenCalled();
    });

    it('applies to every English locale', () => {
        Z.locale = 'en-GB';
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        labelTableOpenEntries(popup, [table]);
        expect(setAttributes).toHaveBeenCalledOnce();
    });

    it('does nothing without a popup, a selection or a localization', () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        labelTableOpenEntries(null, [table]);
        labelTableOpenEntries(popup, []);
        delete (document as any).l10n;
        labelTableOpenEntries(popup, [table]);
        expect(setAttributes).not.toHaveBeenCalled();
    });
});

describe('relabelling when the item menu opens', () => {
    let selection: Zotero.Item[];
    let win: Window;

    beforeEach(() => {
        popup.id = 'zotero-itemmenu';
        selection = [table];
        win = { document, ZoteroPane: { getSelectedItems: () => selection } } as unknown as Window;
    });

    function openMenu(target: Element = popup): void {
        target.dispatchEvent(new Event('popupshowing', { bubbles: true }));
    }

    it('labels the entries from the selection each time the item menu opens', () => {
        const entry = addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        attachTableOpenLabels(win);

        openMenu();
        expect(setAttributes).toHaveBeenCalledWith(entry, 'beaver-item-menu-view-table', { count: 1, openIn: 'tab' });

        // Zotero rebuilds the entries for the next opening.
        entry.remove();
        const next = addEntry({ attachmentType: 'snapshot', numAttachments: 2, openIn: 'window' });
        selection = [table, table];
        openMenu();
        expect(setAttributes).toHaveBeenLastCalledWith(next, 'beaver-item-menu-view-table', { count: 2, openIn: 'window' });
    });

    it('relabels without opening any submenu, so grouped plugin entries do not matter', () => {
        // Zotero's overflow submenu for plugin entries stays closed.
        const group = document.createElement('menu');
        group.appendChild(document.createElement('menupopup'));
        popup.appendChild(group);
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        attachTableOpenLabels(win);

        openMenu();

        expect(setAttributes).toHaveBeenCalledOnce();
    });

    it("ignores a submenu's popupshowing bubbling up to the item menu", () => {
        const submenu = document.createElement('menupopup');
        popup.appendChild(submenu);
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        attachTableOpenLabels(win);

        openMenu(submenu);

        expect(setAttributes).not.toHaveBeenCalled();
    });

    it('attaches once however often the window is set up', () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        attachTableOpenLabels(win);
        attachTableOpenLabels(win);

        openMenu();

        expect(setAttributes).toHaveBeenCalledOnce();
    });

    it('stops relabelling once detached from the window or on shutdown', () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        attachTableOpenLabels(win);
        detachTableOpenLabels(win);
        openMenu();

        attachTableOpenLabels(win);
        detachAllTableOpenLabels();
        openMenu();

        expect(setAttributes).not.toHaveBeenCalled();
    });

    it("never breaks Zotero's menu when the selection cannot be read", () => {
        addEntry({ attachmentType: 'snapshot', numAttachments: 1, openIn: 'tab' });
        (win as any).ZoteroPane.getSelectedItems = () => { throw new Error('no items view'); };
        attachTableOpenLabels(win);

        expect(() => openMenu()).not.toThrow();
        expect(setAttributes).not.toHaveBeenCalled();
    });

    it('does nothing in a window without the item menu', () => {
        popup.id = '';
        expect(() => attachTableOpenLabels(win)).not.toThrow();
        detachTableOpenLabels(win);
    });
});

describe('opening tables in their own windows from the item menu', () => {
    let selection: Zotero.Item[];
    let win: Window;
    let open: ReturnType<typeof vi.fn>;
    let zoteroOpen: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        popup.id = 'zotero-itemmenu';
        selection = [table];
        win = { document, closed: false, ZoteroPane: { getSelectedItems: () => selection } } as unknown as Window;
        open = vi.fn(async () => ({ ok: true }));
        zoteroOpen = vi.fn();
    });

    /** Zotero's entry, with the command listener Zotero puts on it. */
    function zoteroEntry(openIn: string): HTMLElement {
        const entry = addEntry({ attachmentType: 'snapshot', numAttachments: selection.length, openIn });
        entry.addEventListener('command', zoteroOpen);
        return entry;
    }

    function choose(entry: Element): void {
        popup.dispatchEvent(new Event('popupshowing'));
        entry.dispatchEvent(new Event('command', { bubbles: true }));
    }

    it("opens each selected table in a window instead of Zotero's reader window", () => {
        const second = { table: true, libraryID: 2, key: 'SECONDKY' } as unknown as Zotero.Item;
        selection = [table, second];
        const entry = zoteroEntry('window');
        attachTableOpenLabels(win, open);

        choose(entry);

        expect(zoteroOpen).not.toHaveBeenCalled();
        expect(open.mock.calls.map((call) => call[0])).toEqual([
            { libraryID: 1, key: 'TABLEKEY' },
            { libraryID: 2, key: 'SECONDKY' },
        ]);
    });

    it('does so in every language, where the label stays Zotero\'s', () => {
        Z.locale = 'de';
        const entry = zoteroEntry('window');
        attachTableOpenLabels(win, open);

        choose(entry);

        expect(setAttributes).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledOnce();
        expect(zoteroOpen).not.toHaveBeenCalled();
    });

    it("leaves the tab entry and a mixed selection to Zotero's open", () => {
        const tab = zoteroEntry('tab');
        attachTableOpenLabels(win, open);
        choose(tab);
        expect(zoteroOpen).toHaveBeenCalledOnce();

        selection = [table, snapshot];
        tab.remove();
        const windowEntry = zoteroEntry('window');
        choose(windowEntry);
        expect(zoteroOpen).toHaveBeenCalledTimes(2);
        expect(open).not.toHaveBeenCalled();
    });

    it("leaves the window entry to Zotero without a table window to open", () => {
        const entry = zoteroEntry('window');
        attachTableOpenLabels(win);
        choose(entry);
        expect(zoteroOpen).toHaveBeenCalledOnce();
    });

    it('says why when a table could not be opened', async () => {
        (Zotero as any).alert = vi.fn();
        open.mockResolvedValueOnce({ error: 'Could not open table TABLEKEY — gone.' });
        const entry = zoteroEntry('window');
        attachTableOpenLabels(win, open);
        choose(entry);
        await vi.waitFor(() =>
            expect((Zotero as any).alert).toHaveBeenCalledWith(win, 'Beaver', 'Could not open table TABLEKEY — gone.'),
        );
    });

    it('stops opening table windows once detached', () => {
        const entry = zoteroEntry('window');
        attachTableOpenLabels(win, open);
        detachTableOpenLabels(win);
        choose(entry);
        expect(open).not.toHaveBeenCalled();
        expect(zoteroOpen).toHaveBeenCalledOnce();
    });
});
