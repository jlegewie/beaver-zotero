import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
    isRemoteAccessAvailable: vi.fn(() => false),
    isLibrarySearchable: vi.fn(() => true),
    checkLibraryExcluded: vi.fn(() => null),
}));

import { preloadPageLabelsForCitations, preloadPageLabelsForContent } from '../../../react/utils/pageLabels';
import { getAttachmentFileStatus, isRemoteAccessAvailable } from '../../../src/services/agentDataProvider/utils';

const mockGetAttachmentFileStatus = vi.mocked(getAttachmentFileStatus);
const mockIsRemoteAccessAvailable = vi.mocked(isRemoteAccessAvailable);

function makeItem(id: number, key: string) {
    return {
        id,
        key,
        libraryID: 1,
        version: 7,
        attachmentSyncedHash: null,
        attachmentContentType: 'application/pdf',
        isAttachment: () => true,
        isFileAttachment: () => true,
        isPDFAttachment: () => true,
        isStoredFileAttachment: () => false,
        getFilePathAsync: vi.fn().mockResolvedValue(`/storage/${key}/test.pdf`),
    };
}

function makeRemoteItem(id: number, key: string) {
    return {
        ...makeItem(id, key),
        attachmentSyncedHash: 'syncedhash',
        isStoredFileAttachment: () => true,
        getFilePathAsync: vi.fn().mockResolvedValue(null),
    };
}

// Mirrors real Zotero behavior: getFilePathAsync throws on non-attachment
// items (e.g., parent items referenced via <citation id="...">).
function makeParentItem(id: number, key: string) {
    return {
        id,
        key,
        libraryID: 1,
        version: 7,
        attachmentSyncedHash: null,
        attachmentContentType: null,
        isAttachment: () => false,
        isStoredFileAttachment: () => false,
        getFilePathAsync: vi.fn().mockRejectedValue(
            new Error('getFilePathAsync() can only be called on attachment items')
        ),
    };
}

// Only the async lookup resolves; the sync one throws, as Zotero does for items
// of a library that has not been loaded yet.
function itemLookups(lookup: (libraryId: number, key: string) => unknown) {
    return {
        getByLibraryAndKey: vi.fn(() => {
            throw new Error('Item 1 not yet loaded');
        }),
        getByLibraryAndKeyAsync: vi.fn(async (libraryId: number, key: string) => lookup(libraryId, key)),
    };
}

describe('preloadPageLabelsForContent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsRemoteAccessAvailable.mockReturnValue(false);
    });

    it('no-ops when cache is unavailable', async () => {
        (globalThis as any).Zotero.Beaver = undefined;

        const labels = await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />', 'locator');

        expect(labels).toEqual({});
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('skips items already in cache (cache hit via getMetadata)', async () => {
        const item = makeItem(42, 'ABCD1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 42, pageLabels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />', 'locator');

        expect(labels).toEqual({ 42: { 0: 'i' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'ABCD1234' }, '/storage/ABCD1234/test.pdf');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('loads the labels of the requested namespace', async () => {
        const item = makeItem(44, 'NSPACE01');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                pageCount: 2,
                pageLabels: { 0: '1', 1: '2' },
                derivedPageLabels: { 1: '1202' },
            }),
        };
        (globalThis as any).Zotero.Items = { ...itemLookups(() => item) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };
        const content = '<citation att_id="1-NSPACE01" page="1"/>';

        // Locator labels are printed labels, with the declared label on a page that prints none.
        expect(await preloadPageLabelsForContent(content, 'locator')).toEqual({ 44: { 0: '1', 1: '1202' } });
        expect(await preloadPageLabelsForContent(content, 'printed')).toEqual({ 44: { 1: '1202' } });
    });

    it('loads declared labels for a standalone attachment whose link cannot carry its page', async () => {
        const item = { ...makeItem(45, 'ALONE003'), parentID: false, isFileAttachment: () => true, fileExistsCached: () => false };
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                pageCount: 2,
                pageLabels: { 0: '1', 1: '2' },
                derivedPageLabels: { 1: '1202' },
            }),
        };
        (globalThis as any).Zotero.Items = { ...itemLookups(() => item) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };
        const content = '<citation att_id="1-ALONE003" page="2"/>';

        expect(await preloadPageLabelsForContent(content, 'locator')).toEqual({ 45: { 0: '1', 1: '2' } });
        expect(await preloadPageLabelsForContent(content, 'printed')).toEqual({ 45: { 1: '1202' } });
    });

    it('calls getAttachmentFileStatus on cache miss', async () => {
        const item = makeItem(43, 'EFGH5678');
        // Miss on first read, labels available after getAttachmentFileStatus.
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 43, pageLabels: { 0: 'ii' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-EFGH5678" />', 'locator');

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
        expect(labels).toEqual({ 43: { 0: 'ii' } });
    });

    it('skips items without file path', async () => {
        const item = makeItem(44, 'IJKL9012');
        item.getFilePathAsync = vi.fn().mockResolvedValue(null);

        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-IJKL9012" />', 'locator');

        expect(labels).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('loads cached labels for remote-only attachments without downloading', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(48, 'REMOTE01');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 48, pageLabels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-REMOTE01" />', 'locator');

        expect(labels).toEqual({ 48: { 0: 'i' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'REMOTE01' }, 'remote:h:syncedhash');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('does not download remote-only attachments on cache miss', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(49, 'REMOTE02');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-REMOTE02" />', 'locator');

        expect(labels).toEqual({});
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'REMOTE02' }, 'remote:h:syncedhash');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('skips non-attachment items without invoking getFilePathAsync', async () => {
        // Citations may reference parent items via item_id — getFilePathAsync
        // throws on non-attachment items in real Zotero, so the resolver must
        // short-circuit before calling it.
        const parent = makeParentItem(50, 'PARENT01');
        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => parent),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-PARENT01" />', 'locator');

        expect(labels).toEqual({});
        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('preloads parent-item citations against the selected PDF attachment', async () => {
        const parent = {
            ...makeParentItem(50, 'PARENT01'),
            isRegularItem: () => true,
            getAttachments: vi.fn(() => [77]),
        };
        const attachment = makeItem(77, 'ATTACH01');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 77, pageLabels: { 2: '3' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => parent),
            get: vi.fn((itemID: number) => itemID === 77 ? attachment : false),
            getAsync: vi.fn(async (itemIDs: number[]) => itemIDs.map((id) => id === 77 ? attachment : false)),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation id="1-PARENT01" loc="page3" />', 'locator');

        expect(labels).toEqual({ 77: { 2: '3' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'ATTACH01' }, '/storage/ATTACH01/test.pdf');
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
    });

    it('deduplicates by item ID', async () => {
        const item = makeItem(45, 'MNOP3456');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 45, pageLabels: { 0: '1' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent(
            '<citation att_id="1-MNOP3456" /><citation att_id="1-MNOP3456" />'
        , 'locator');

        // Only called once despite two citations referencing the same item
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledTimes(1);
        expect(labels).toEqual({ 45: { 0: '1' } });
    });

    it('continues after individual item failure', async () => {
        const item1 = makeItem(46, 'QRST7890');
        const item2 = makeItem(47, 'UVWX1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 47, pageLabels: { 0: '1' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups((_libId: number, key: string) => {
                if (key === 'QRST7890') return item1;
                if (key === 'UVWX1234') return item2;
                return null;
            }),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        // First item's getMetadata throws; second item misses on first read,
        // then resolves to labels after getAttachmentFileStatus runs.
        cache.getMetadata
            .mockRejectedValueOnce(new Error('DB error'))
            .mockResolvedValueOnce(null);

        const labels = await preloadPageLabelsForContent(
            '<citation att_id="1-QRST7890" /><citation att_id="1-UVWX1234" />'
        , 'locator');

        // Second item still processed despite first failing
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item2, false);
        expect(labels).toEqual({ 47: { 0: '1' } });
    });
});

describe('preloadPageLabelsForCitations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsRemoteAccessAvailable.mockReturnValue(false);
    });

    it('loads printed labels, not the labels the PDF declares', async () => {
        const item = makeItem(60, 'PRINTED1');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                pageCount: 3,
                pageLabels: { 0: '1', 1: '2', 2: '3' },
                derivedPageLabels: { 1: '1202', 2: '1203' },
            }),
        };
        (globalThis as any).Zotero.Items = { ...itemLookups(() => item) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'PRINTED1' }, pages: [2] },
        ]);

        expect(labels).toEqual({ 60: { 1: '1202', 2: '1203' } });
    });

    it('recovers printed labels from the cached structured payload for metadata written without them', async () => {
        const item = makeItem(62, 'PRINTED3');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                libraryId: 1, zoteroKey: 'PRINTED3', contentKind: 'pdf',
                pageCount: 3, pageLabels: { 0: '1', 1: '2', 2: '3' },
            }),
            getSerializedResult: vi.fn().mockResolvedValue({ metadata: { derivedPageLabels: { 1: '1202' } } }),
        };
        (globalThis as any).Zotero.Items = { ...itemLookups(() => item) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'PRINTED3' }, pages: [2] },
        ]);

        expect(labels).toEqual({ 62: { 1: '1202' } });
        expect(cache.getSerializedResult).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: 'PRINTED3' }, 'structured', '/storage/PRINTED3/test.pdf',
        );
        // Locator labels recover the printed labels the same way.
        cache.getSerializedResult.mockClear();
        expect(await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'PRINTED3' }, pages: [2] },
        ], 'locator')).toEqual({ 62: { 0: '1', 1: '1202', 2: '3' } });
        expect(cache.getSerializedResult).toHaveBeenCalledTimes(1);
    });

    it('loads no labels for a document whose printed labels are not known', async () => {
        const item = makeItem(61, 'PRINTED2');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ pageCount: 3, pageLabels: { 0: '1', 1: '2', 2: '3' } }),
        };
        (globalThis as any).Zotero.Items = { ...itemLookups(() => item) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'PRINTED2' }, pages: [2] },
        ]);

        expect(labels).toEqual({});
    });

    it('loads cached labels for remote-only citation metadata', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(50, 'REMOTE03');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 50, pageLabels: { 0: '1' }, derivedPageLabels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'REMOTE03' }, pages: [1] },
        ]);

        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'REMOTE03' }, 'remote:h:syncedhash');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
        expect(labels).toEqual({ 50: { 0: 'i' } });
    });

    it('returns empty labels when nothing was loaded (all remote-only cache misses)', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(51, 'REMOTE04');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'REMOTE04' }, pages: [1] },
        ]);

        expect(labels).toEqual({});
    });

    it('returns empty labels when all citations are non-attachment parent items', async () => {
        const parent = makeParentItem(52, 'PARENT02');
        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => parent),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'PARENT02' }, pages: [1] },
        ]);

        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(labels).toEqual({});
    });

    it('skips the PDF analysis on a printed-label cache miss, which could not record printed labels', async () => {
        const item = makeItem(56, 'LOCAL03');
        const cache = { getMetadata: vi.fn().mockResolvedValue(null) };
        (globalThis as any).Zotero.Items = { ...itemLookups(() => item) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'LOCAL03' }, pages: [1] },
        ]);

        expect(labels).toEqual({});
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('returns the declared labels as locator labels after analyzing the PDF on a local cache miss', async () => {
        // The analysis records the labels the PDF declares, not printed ones.
        const item = makeItem(53, 'LOCAL01');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 53, pageLabels: { 0: '1' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'LOCAL01' }, pages: [1] },
        ], 'locator');

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
        expect(labels).toEqual({ 53: { 0: '1' } });
    });

    it('preloads parent-item citation metadata against the selected PDF attachment', async () => {
        const parent = {
            ...makeParentItem(54, 'PARENT03'),
            isRegularItem: () => true,
            getAttachments: vi.fn(() => [78]),
        };
        const attachment = makeItem(78, 'ATTACH02');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 78, pageLabels: { 2: '9' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => parent),
            get: vi.fn((itemID: number) => itemID === 78 ? attachment : false),
            getAsync: vi.fn(async (itemIDs: number[]) => itemIDs.map((id) => id === 78 ? attachment : false)),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { resolved_ref: { kind: 'zotero' as const, library_id: 1, zotero_key: 'PARENT03' }, pages: [3] },
        ], 'locator');

        expect(labels).toEqual({ 78: { 2: '9' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'ATTACH02' }, '/storage/ATTACH02/test.pdf');
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
    });

    it('preloads citation metadata when only requested/resolved refs carry the page locator', async () => {
        const item = makeItem(55, 'LOCAL02');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 55, pageLabels: { 3: '9' } }),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            {
                requested_ref: {
                    kind: 'zotero',
                    library_id: 1,
                    zotero_key: 'REQUESTED',
                    loc: { kind: 'page', value: '4', raw: 'page4' },
                },
                resolved_ref: {
                    kind: 'zotero',
                    library_id: 1,
                    zotero_key: 'LOCAL02',
                },
            },
        ], 'locator');

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
        expect(labels).toEqual({ 55: { 3: '9' } });
    });

    it('does not treat paragraph locators as page-label preload signals', async () => {
        const item = makeItem(56, 'LOCAL03');
        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            ...itemLookups(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            {
                resolved_ref: {
                    kind: 'zotero',
                    library_id: 1,
                    zotero_key: 'LOCAL03',
                },
                raw_tag: '<citation id="1-LOCAL03" loc="p3"/>',
            },
        ]);

        expect(labels).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });
});
