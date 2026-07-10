/**
 * Focused unit tests for buildThreadItemFilter (react/utils/threadItemFilter.ts).
 *
 * `react/utils/sourceUtils.ts` has a wide transitive dependency surface
 * (React components, Jotai atoms, the Supabase-backed store) that
 * buildThreadItemFilter itself never touches beyond getDisplayNameFromItem,
 * so it — and the Zotero data-loading/library-identity helpers — are
 * stubbed out to keep this test isolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockItem, createMockAttachment, createMockNote } from '../../helpers/factories';

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(() => 'u'),
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    getDisplayNameFromItem: vi.fn(() => 'Mock Display Name'),
}));

import { buildThreadItemFilter } from '../../../react/utils/threadItemFilter';
import { loadFullItemData } from '../../../src/utils/zoteroUtils';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { getDisplayNameFromItem } from '../../../react/utils/sourceUtils';

/** Attach a getItemTypeIconName stub — the shared factories don't include it. */
function withItemTypeIcon(item: any, itemType = 'journalArticle') {
    item.getItemTypeIconName = vi.fn(() => itemType);
    return item;
}

describe('buildThreadItemFilter', () => {
    let previousZoteroItems: any;

    beforeEach(() => {
        vi.clearAllMocks();
        (libraryRefForLibraryID as any).mockReturnValue('u');
        (getDisplayNameFromItem as any).mockReturnValue('Mock Display Name');
        previousZoteroItems = (globalThis as any).Zotero.Items;
    });

    afterEach(() => {
        (globalThis as any).Zotero.Items = previousZoteroItems;
    });

    it('returns null when the item is in an excluded library', async () => {
        const item = withItemTypeIcon(createMockItem({ libraryID: 5 }));

        const result = await buildThreadItemFilter(item as any, [1, 2]);

        expect(result).toBeNull();
        expect(loadFullItemData).not.toHaveBeenCalled();
    });

    it('expands a regular item to its key plus child attachment and note keys', async () => {
        const attachment = createMockAttachment({ id: 10, key: 'ATTCH001' });
        const note = createMockNote({ id: 11, key: 'NOTE0001' });
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map(id => (id === 10 ? attachment : id === 11 ? note : null)).filter(Boolean),
            ),
        };
        const item = withItemTypeIcon(createMockItem({
            id: 1, key: 'REG00001', libraryID: 1,
            attachmentIDs: [10], noteIDs: [11],
        }));

        const result = await buildThreadItemFilter(item as any, [1]);

        expect(result?.keys).toEqual(['REG00001', 'ATTCH001', 'NOTE0001']);
        expect(loadFullItemData).toHaveBeenCalledWith([item]);
    });

    it('resolves child keys through Zotero.Items.getAsync and drops unresolved ids', async () => {
        const attachment = createMockAttachment({ id: 10, key: 'ATTCH001' });
        (globalThis as any).Zotero.Items = {
            // id 999 (deleted/unresolved) is filtered out
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map(id => (id === 10 ? attachment : null)).filter(Boolean),
            ),
        };
        const item = withItemTypeIcon(createMockItem({
            id: 1, key: 'REG00002', libraryID: 1,
            attachmentIDs: [10, 999],
        }));

        const result = await buildThreadItemFilter(item as any, [1]);

        expect(result?.keys).toEqual(['REG00002', 'ATTCH001']);
    });

    it('expands an attachment with a parent to [key, parentKey]', async () => {
        const item: any = withItemTypeIcon(createMockAttachment({ id: 20, key: 'ATTCH002', libraryID: 1 }));
        item.parentKey = 'PARENT01';

        const result = await buildThreadItemFilter(item, [1]);

        expect(result?.keys).toEqual(['ATTCH002', 'PARENT01']);
    });

    it('expands a standalone attachment (no parent) to just its own key', async () => {
        const item: any = withItemTypeIcon(createMockAttachment({ id: 21, key: 'ATTCH003', libraryID: 1 }));

        const result = await buildThreadItemFilter(item, [1]);

        expect(result?.keys).toEqual(['ATTCH003']);
    });

    it('expands a note with a parent to [key, parentKey]', async () => {
        const item: any = withItemTypeIcon(createMockNote({ id: 22, key: 'NOTE0002', libraryID: 1 }));
        item.parentKey = 'PARENT02';

        const result = await buildThreadItemFilter(item, [1]);

        expect(result?.keys).toEqual(['NOTE0002', 'PARENT02']);
    });

    it('returns null for item types that are neither regular, attachment, nor note', async () => {
        const item: any = withItemTypeIcon(createMockItem({
            id: 23, key: 'ANNOT001', libraryID: 1,
            isAttachment: false, isNote: false, isRegularItem: false,
        }));

        const result = await buildThreadItemFilter(item, [1]);

        expect(result).toBeNull();
    });

    it('populates libraryRef, itemType, and label on the built filter', async () => {
        (libraryRefForLibraryID as any).mockReturnValue('g42');
        const item = withItemTypeIcon(createMockItem({ id: 1, key: 'REG00003', libraryID: 7 }), 'book');

        const result = await buildThreadItemFilter(item as any, [7]);

        expect(result).toMatchObject({
            libraryId: 7,
            libraryRef: 'g42',
            itemKey: 'REG00003',
            itemType: 'book',
            label: 'Mock Display Name',
        });
    });

    it('omits libraryRef when it cannot be computed', async () => {
        (libraryRefForLibraryID as any).mockReturnValue(null);
        const item = withItemTypeIcon(createMockItem({ id: 1, key: 'REG00004', libraryID: 1 }));

        const result = await buildThreadItemFilter(item as any, [1]);

        expect(result?.libraryRef).toBeUndefined();
    });
});
