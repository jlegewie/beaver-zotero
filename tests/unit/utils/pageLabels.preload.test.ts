import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
    isRemoteAccessAvailable: vi.fn(() => false),
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

describe('preloadPageLabelsForContent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsRemoteAccessAvailable.mockReturnValue(false);
    });

    it('no-ops when cache is unavailable', async () => {
        (globalThis as any).Zotero.Beaver = undefined;

        const labels = await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />');

        expect(labels).toEqual({});
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('skips items already in cache (cache hit via getMetadata)', async () => {
        const item = makeItem(42, 'ABCD1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 42, pageLabels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />');

        expect(labels).toEqual({ 42: { 0: 'i' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'ABCD1234' }, '/storage/ABCD1234/test.pdf');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
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
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-EFGH5678" />');

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
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-IJKL9012" />');

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
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-REMOTE01" />');

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
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-REMOTE02" />');

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
            getByLibraryAndKey: vi.fn(() => parent),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation att_id="1-PARENT01" />');

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
            getByLibraryAndKey: vi.fn(() => parent),
            get: vi.fn((itemID: number) => itemID === 77 ? attachment : false),
            getAsync: vi.fn(async (itemIDs: number[]) => itemIDs.map((id) => id === 77 ? attachment : false)),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent('<citation id="1-PARENT01" loc="page3" />');

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
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForContent(
            '<citation att_id="1-MNOP3456" /><citation att_id="1-MNOP3456" />'
        );

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
            getByLibraryAndKey: vi.fn((_libId: number, key: string) => {
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
        );

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

    it('loads cached labels for remote-only citation metadata', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(50, 'REMOTE03');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 50, pageLabels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'REMOTE03', pages: [1], parts: [] },
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
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'REMOTE04', pages: [1], parts: [] },
        ]);

        expect(labels).toEqual({});
    });

    it('returns empty labels when all citations are non-attachment parent items', async () => {
        const parent = makeParentItem(52, 'PARENT02');
        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => parent),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'PARENT02', pages: [1], parts: [] },
        ]);

        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(labels).toEqual({});
    });

    it('returns labels after running extraction on a local cache miss', async () => {
        const item = makeItem(53, 'LOCAL01');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 53, pageLabels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'LOCAL01', pages: [1], parts: [] },
        ]);

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
        expect(labels).toEqual({ 53: { 0: 'i' } });
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
                .mockResolvedValue({ item_id: 78, pageLabels: { 2: '3' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => parent),
            get: vi.fn((itemID: number) => itemID === 78 ? attachment : false),
            getAsync: vi.fn(async (itemIDs: number[]) => itemIDs.map((id) => id === 78 ? attachment : false)),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'PARENT03', pages: [3], parts: [] },
        ]);

        expect(labels).toEqual({ 78: { 2: '3' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'ATTACH02' }, '/storage/ATTACH02/test.pdf');
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
    });

    it('preloads citation metadata when only requested/resolved refs carry the page locator', async () => {
        const item = makeItem(55, 'LOCAL02');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ item_id: 55, pageLabels: { 3: '4' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            {
                parts: [],
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
        ]);

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
        expect(labels).toEqual({ 55: { 3: '4' } });
    });

    it('does not treat paragraph locators as page-label preload signals', async () => {
        const item = makeItem(56, 'LOCAL03');
        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadPageLabelsForCitations([
            {
                parts: [],
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
