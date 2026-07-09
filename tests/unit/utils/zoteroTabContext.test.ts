import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getReaderOrNoteContextItem, getCurrentContextItemForFilter } from '../../../react/utils/zoteroTabContext';
import { createMockItem } from '../../helpers/factories';

/** Baseline Zotero stub covering the APIs this module touches, layered over tests/setup.ts. */
function stubZotero(previous: any) {
    (globalThis as any).Zotero = {
        ...previous,
        Reader: { getByTabID: vi.fn(() => null) },
        Items: { get: vi.fn(() => null) },
        getMainWindow: vi.fn(() => ({ Zotero_Tabs: { _tabs: [] } })),
    };
}

describe('getReaderOrNoteContextItem', () => {
    let previousZotero: any;

    beforeEach(() => {
        previousZotero = (globalThis as any).Zotero;
        stubZotero(previousZotero);
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('resolves a reader tab to its item and includes the parent key', () => {
        const parent = createMockItem({ id: 1, key: 'PARENT01', libraryID: 1 });
        const attachment: any = createMockItem({ id: 2, key: 'ATTCH001', libraryID: 1 });
        attachment.parentItemID = 1;

        (globalThis as any).Zotero.Reader.getByTabID = vi.fn((tabId: string) =>
            tabId === 'tab-1' ? { itemID: 2 } : null,
        );
        (globalThis as any).Zotero.Items.get = vi.fn((id: number) =>
            id === 2 ? attachment : id === 1 ? parent : null,
        );

        const result = getReaderOrNoteContextItem('tab-1');

        expect(result).toMatchObject({
            item: attachment,
            libraryId: 1,
            keys: ['ATTCH001', 'PARENT01'],
            source: 'reader',
        });
    });

    it('resolves a reader tab without a parent item to just its own key', () => {
        const attachment = createMockItem({ id: 2, key: 'ATTCH002', libraryID: 1 });

        (globalThis as any).Zotero.Reader.getByTabID = vi.fn(() => ({ itemID: 2 }));
        (globalThis as any).Zotero.Items.get = vi.fn((id: number) => (id === 2 ? attachment : null));

        const result = getReaderOrNoteContextItem('tab-1');

        expect(result?.keys).toEqual(['ATTCH002']);
        expect(result?.source).toBe('reader');
    });

    it.each(['note', 'note-unloaded', 'note-loading'] as const)(
        'resolves a %s tab to its item and includes the parent key',
        (tabType) => {
            const parent = createMockItem({ id: 5, key: 'PARENT05', libraryID: 1 });
            const note: any = createMockItem({ id: 6, key: 'NOTE0001', libraryID: 1, isNote: true });
            note.parentItemID = 5;

            (globalThis as any).Zotero.getMainWindow = vi.fn(() => ({
                Zotero_Tabs: {
                    _tabs: [{ id: 'tab-2', type: tabType, data: { itemID: 6 } }],
                },
            }));
            (globalThis as any).Zotero.Items.get = vi.fn((id: number) =>
                id === 6 ? note : id === 5 ? parent : null,
            );

            const result = getReaderOrNoteContextItem('tab-2');

            expect(result).toMatchObject({
                item: note,
                libraryId: 1,
                keys: ['NOTE0001', 'PARENT05'],
                source: 'note',
            });
        },
    );

    it('returns null when the tab is neither a reader nor a note tab', () => {
        (globalThis as any).Zotero.getMainWindow = vi.fn(() => ({
            Zotero_Tabs: { _tabs: [{ id: 'tab-3', type: 'library', data: {} }] },
        }));

        const result = getReaderOrNoteContextItem('tab-3');

        expect(result).toBeNull();
    });

    it('returns null when selectedTabId is null', () => {
        expect(getReaderOrNoteContextItem(null)).toBeNull();
    });

    it('returns null when no tab matches the given id', () => {
        (globalThis as any).Zotero.getMainWindow = vi.fn(() => ({
            Zotero_Tabs: { _tabs: [] },
        }));

        expect(getReaderOrNoteContextItem('missing-tab')).toBeNull();
    });
});

describe('getCurrentContextItemForFilter', () => {
    let previousZotero: any;

    beforeEach(() => {
        previousZotero = (globalThis as any).Zotero;
        stubZotero(previousZotero);
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('returns the first selected item on the library tab', () => {
        const first = createMockItem({ id: 1, key: 'ITEM0001' });
        const second = createMockItem({ id: 2, key: 'ITEM0002' });

        const result = getCurrentContextItemForFilter(true, null, [first as any, second as any]);

        expect(result).toBe(first);
    });

    it('returns null on the library tab with no selection', () => {
        expect(getCurrentContextItemForFilter(true, null, [])).toBeNull();
    });

    it('delegates to the reader/note tab lookup outside the library tab', () => {
        const attachment = createMockItem({ id: 2, key: 'ATTCH009', libraryID: 1 });
        (globalThis as any).Zotero.Reader.getByTabID = vi.fn(() => ({ itemID: 2 }));
        (globalThis as any).Zotero.Items.get = vi.fn((id: number) => (id === 2 ? attachment : null));

        const result = getCurrentContextItemForFilter(false, 'tab-1', []);

        expect(result).toBe(attachment);
    });

    it('returns null outside the library tab when no reader/note context resolves', () => {
        expect(getCurrentContextItemForFilter(false, null, [])).toBeNull();
    });
});
