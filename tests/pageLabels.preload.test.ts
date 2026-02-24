import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
}));

import { preloadPageLabelsForContent } from '../react/utils/pageLabels';
import { getAttachmentFileStatus } from '../src/services/agentDataProvider/utils';

const mockGetAttachmentFileStatus = vi.mocked(getAttachmentFileStatus);

function makeItem(id: number, key: string) {
    return {
        id,
        key,
        libraryID: 1,
        attachmentContentType: 'application/pdf',
        isAttachment: () => true,
        getFilePathAsync: vi.fn().mockResolvedValue(`/storage/${key}/test.pdf`),
    };
}

describe('preloadPageLabelsForContent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
