import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveLibraryRef = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveLibraryRef,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getLibraryByIdOrName: vi.fn(),
    getCollectionByIdOrName: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroItemHelpers', () => ({
    getBestPDFAttachment: vi.fn(),
}));

import { zoteroItemData } from '../../../react/host/zotero/itemData';

describe('zoteroItemData.resolveItemDisplay', () => {
    const getByLibraryAndKeyAsync = vi.fn();
    const getAsync = vi.fn();
    const loadDataTypes = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero as any).Items = {
            getByLibraryAndKeyAsync,
            getAsync,
            loadDataTypes,
        };
    });

    it('loads display metadata from the resolved local library', async () => {
        resolveLibraryRef.mockReturnValue(7);
        getByLibraryAndKeyAsync.mockResolvedValue({
            isNote: () => false,
            isAttachment: () => false,
            isRegularItem: () => true,
            getBestAttachment: vi.fn().mockResolvedValue({ id: 10 }),
            firstCreator: 'Smith',
            getField: (field: string) => field === 'date' ? '2024' : '',
            itemType: 'journalArticle',
        });

        const display = await zoteroItemData.resolveItemDisplay({
            library_id: 99,
            library_ref: 'g42',
            zotero_key: 'ABCD1234',
        });

        expect(getByLibraryAndKeyAsync).toHaveBeenCalledWith(7, 'ABCD1234');
        expect(loadDataTypes).toHaveBeenCalledWith(
            [expect.objectContaining({ itemType: 'journalArticle' })],
            ['itemData', 'childItems'],
        );
        expect(display).toEqual({
            itemType: 'journalArticle',
            hasReadableAttachment: true,
            displayName: 'Smith 2024',
        });
    });

    it('does not read Zotero data when the library is unavailable on this device', async () => {
        resolveLibraryRef.mockReturnValue(null);

        await expect(zoteroItemData.resolveItemDisplay({
            library_id: 99,
            library_ref: 'g42',
            zotero_key: 'ABCD1234',
        })).resolves.toBeNull();
        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('loads an attachment parent asynchronously before deriving its display name', async () => {
        const attachment = {
            isNote: () => false,
            isAttachment: () => true,
            isRegularItem: () => false,
            parentItemID: 23,
            itemType: 'attachment',
        };
        const parent = {
            isNote: () => false,
            isAttachment: () => false,
            isRegularItem: () => true,
            firstCreator: 'Jones',
            getField: (field: string) => field === 'date' ? '2022' : '',
            itemType: 'book',
        };
        resolveLibraryRef.mockReturnValue(7);
        getByLibraryAndKeyAsync.mockResolvedValue(attachment);
        getAsync.mockResolvedValue(parent);

        const display = await zoteroItemData.resolveItemDisplay({
            library_id: 99,
            library_ref: 'g42',
            zotero_key: 'ATTACH01',
        });

        expect(getAsync).toHaveBeenCalledWith(23);
        expect(loadDataTypes).toHaveBeenCalledWith([parent], ['itemData', 'creators']);
        expect(display?.displayName).toBe('Jones 2022');
    });
});
