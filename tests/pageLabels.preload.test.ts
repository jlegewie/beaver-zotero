import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/pdf/MuPDFService', () => {
    class MockMuPDFService {
        async open(): Promise<void> {}
        getPageCount(): number { return 7; }
        getAllPageLabels(): Record<number, string> { return {}; }
        close(): void {}
    }
    return { MuPDFService: MockMuPDFService };
});

import { preloadPageLabelsForContent } from '../react/utils/pageLabels';

const mockIOUtils = (globalThis as any).IOUtils as {
    exists: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
};

describe('preloadPageLabelsForContent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('revalidates stale resolved no-label metadata before skipping PDF extraction', async () => {
        const state = { resolved: true };
        const cache = {
            getPageLabelsSync: vi.fn().mockReturnValue(null),
            hasResolvedPageLabels: vi.fn(() => state.resolved),
            ensureInMemoryCache: vi.fn().mockResolvedValue(undefined),
            getMetadata: vi.fn(async () => {
                // Simulate staleness invalidation: record was resolved earlier,
                // but file signature changed so it is now treated as missing.
                state.resolved = false;
                return null;
            }),
            setMetadataIfNotExists: vi.fn().mockResolvedValue(true),
            updatePageLabels: vi.fn().mockResolvedValue(undefined),
        };

        const item = {
            id: 42,
            key: 'ABCD1234',
            libraryID: 1,
            attachmentContentType: 'application/pdf',
            isAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/ABCD1234/test.pdf'),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
            getAsync: vi.fn(async () => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        mockIOUtils.exists.mockResolvedValue(true);
        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />');

        expect(cache.getMetadata).toHaveBeenCalledWith(42, '/storage/ABCD1234/test.pdf');
        expect(cache.setMetadataIfNotExists).toHaveBeenCalledTimes(1);
        expect(cache.setMetadataIfNotExists).toHaveBeenCalledWith(expect.objectContaining({
            item_id: 42,
            page_labels: {},
            file_path: '/storage/ABCD1234/test.pdf',
        }));
    });
});
