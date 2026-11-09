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

import { labelTableOpenEntries } from '../../../src/modules/tableOpenMenuLabel';

const Z = (globalThis as any).Zotero;
const table = { table: true } as unknown as Zotero.Item;
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
