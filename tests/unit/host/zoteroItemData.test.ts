import { beforeEach, describe, expect, it, vi } from 'vitest';

declare const Zotero: any;

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
            creator: 'Smith',
        });
    });

    it('skips the attachment search when the caller does not want the flag', async () => {
        // A list row names the item; resolving whether it has a readable
        // attachment would cost a child-item load and a search per row.
        const getBestAttachment = vi.fn().mockResolvedValue({ id: 10 });
        resolveLibraryRef.mockReturnValue(7);
        getByLibraryAndKeyAsync.mockResolvedValue({
            isNote: () => false,
            isAttachment: () => false,
            isRegularItem: () => true,
            getBestAttachment,
            firstCreator: 'Smith',
            getField: (field: string) => field === 'date' ? '2024' : '',
            itemType: 'journalArticle',
        });

        const display = await zoteroItemData.resolveItemDisplay(
            { library_id: 7, zotero_key: 'ABCD1234' },
            { attachment: false },
        );

        expect(getBestAttachment).not.toHaveBeenCalled();
        expect(loadDataTypes).not.toHaveBeenCalledWith(expect.anything(), ['itemData', 'childItems']);
        expect(display?.displayName).toBe('Smith 2024');
        expect(display?.hasReadableAttachment).toBeUndefined();
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
        // The parent is resolved once for every field the row draws.
        expect(getAsync).toHaveBeenCalledTimes(1);
        expect(loadDataTypes).toHaveBeenCalledWith([parent], ['itemData', 'creators']);
        expect(display?.displayName).toBe('Jones 2022');
        expect(display?.creator).toBe('Jones');
    });
});

describe('zoteroItemData.resolveLinkedObject', () => {
    const getByLibraryAndKeyAsync = vi.fn();
    const getByLibraryAndKey = vi.fn();
    const ref = { library_id: 0, library_ref: 'u', zotero_key: 'ANVV522N' };

    /** A Zotero item of one kind; the rest of its type checks answer false. */
    function itemOf(kind: 'annotation' | 'note' | 'attachment' | 'regular', extra: Record<string, unknown> = {}) {
        return {
            isAnnotation: () => kind === 'annotation',
            isNote: () => kind === 'note',
            isAttachment: () => kind === 'attachment',
            isRegularItem: () => kind === 'regular',
            ...extra,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero as any).Items = { getByLibraryAndKeyAsync };
        (Zotero as any).Collections = { getByLibraryAndKey };
        resolveLibraryRef.mockReturnValue(1);
        getByLibraryAndKeyAsync.mockResolvedValue(false);
        getByLibraryAndKey.mockReturnValue(false);
    });

    it('names regular items, notes and annotations', async () => {
        getByLibraryAndKeyAsync.mockResolvedValueOnce(itemOf('regular'));
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toEqual({ kind: 'item' });
        getByLibraryAndKeyAsync.mockResolvedValueOnce(itemOf('note'));
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toEqual({ kind: 'note' });
        getByLibraryAndKeyAsync.mockResolvedValueOnce(itemOf('annotation'));
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toEqual({ kind: 'annotation' });
        expect(getByLibraryAndKeyAsync).toHaveBeenCalledWith(1, 'ANVV522N');
    });

    it('gives an attachment its content kind', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(itemOf('attachment', {
            attachmentContentType: 'application/pdf',
            attachmentFilename: 'paper.pdf',
            attachmentLinkMode: 0,
        }));
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toEqual({ kind: 'attachment', contentKind: 'pdf' });
    });

    it('falls back to a collection when the key names no item', async () => {
        getByLibraryAndKey.mockReturnValue({ key: 'ANVV522N' });
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toEqual({ kind: 'collection' });
        expect(getByLibraryAndKey).toHaveBeenCalledWith(1, 'ANVV522N');
    });

    it('says nothing for a key it cannot find or a library this computer lacks', async () => {
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toBeNull();
        resolveLibraryRef.mockReturnValue(null);
        expect(await zoteroItemData.resolveLinkedObject!(ref)).toBeNull();
    });
});
