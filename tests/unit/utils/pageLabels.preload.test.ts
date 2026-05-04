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
// items (e.g., parent items referenced via <citation item_id="...">).
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

        await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />');

        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('skips items already in cache (cache hit via getMetadata)', async () => {
        const item = makeItem(42, 'ABCD1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 42, page_labels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />');

        expect(cache.getMetadata).toHaveBeenCalledWith(42, '/storage/ABCD1234/test.pdf');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('calls getAttachmentFileStatus on cache miss', async () => {
        const item = makeItem(43, 'EFGH5678');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent('<citation att_id="1-EFGH5678" />');

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
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
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent('<citation att_id="1-IJKL9012" />');

        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('loads cached labels for remote-only attachments without downloading', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(48, 'REMOTE01');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ item_id: 48, page_labels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent('<citation att_id="1-REMOTE01" />');

        expect(cache.getMetadata).toHaveBeenCalledWith(48, 'remote:h:syncedhash');
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
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent('<citation att_id="1-REMOTE02" />');

        expect(cache.getMetadata).toHaveBeenCalledWith(49, 'remote:h:syncedhash');
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
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent('<citation att_id="1-PARENT01" />');

        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('deduplicates by item ID', async () => {
        const item = makeItem(45, 'MNOP3456');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        await preloadPageLabelsForContent(
            '<citation att_id="1-MNOP3456" /><citation att_id="1-MNOP3456" />'
        );

        // Only called once despite two citations referencing the same item
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledTimes(1);
    });

    it('continues after individual item failure', async () => {
        const item1 = makeItem(46, 'QRST7890');
        const item2 = makeItem(47, 'UVWX1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn((libId: number, key: string) => {
                if (key === 'QRST7890') return item1;
                if (key === 'UVWX1234') return item2;
                return null;
            }),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        // First item's getMetadata throws
        cache.getMetadata
            .mockRejectedValueOnce(new Error('DB error'))
            .mockResolvedValueOnce(null);

        await preloadPageLabelsForContent(
            '<citation att_id="1-QRST7890" /><citation att_id="1-UVWX1234" />'
        );

        // Second item still processed despite first failing
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item2, false);
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
            getMetadata: vi.fn().mockResolvedValue({ item_id: 50, page_labels: { 0: 'i' } }),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        const loaded = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'REMOTE03', pages: [1], parts: [] },
        ]);

        expect(cache.getMetadata).toHaveBeenCalledWith(50, 'remote:h:syncedhash');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
        expect(loaded).toBe(true);
    });

    it('returns false when nothing was loaded (all remote-only cache misses)', async () => {
        mockIsRemoteAccessAvailable.mockReturnValue(true);
        const item = makeRemoteItem(51, 'REMOTE04');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        const loaded = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'REMOTE04', pages: [1], parts: [] },
        ]);

        expect(loaded).toBe(false);
    });

    it('returns false when all citations are non-attachment parent items', async () => {
        const parent = makeParentItem(52, 'PARENT02');
        const cache = {
            getMetadata: vi.fn(),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => parent),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        const loaded = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'PARENT02', pages: [1], parts: [] },
        ]);

        expect(parent.getFilePathAsync).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(loaded).toBe(false);
    });

    it('returns true after running extraction on a local cache miss', async () => {
        const item = makeItem(53, 'LOCAL01');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        const loaded = await preloadPageLabelsForCitations([
            { library_id: 1, zotero_key: 'LOCAL01', pages: [1], parts: [] },
        ]);

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(item, false);
        expect(loaded).toBe(true);
    });
});
