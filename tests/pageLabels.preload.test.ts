import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/pdf/MuPDFService', () => {
    let mockLabels: Record<number, string> = {};
    class MockMuPDFService {
        async open(): Promise<void> {}
        getPageCount(): number { return 7; }
        getAllPageLabels(): Record<number, string> { return mockLabels; }
        close(): void {}
    }
    return {
        MuPDFService: MockMuPDFService,
        __setMockLabels: (labels: Record<number, string>) => { mockLabels = labels; },
    };
});

import { preloadPageLabelsForContent } from '../react/utils/pageLabels';

const mockIOUtils = (globalThis as any).IOUtils as {
    exists: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
};

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

    it('updates labels on an existing record (case 1: record exists with null labels)', async () => {
        // Simulate: record exists but page_labels is null (file-status wrote OCR info but not labels).
        // After updatePageLabels, hasResolvedPageLabels returns true → no new record created.
        const state = { resolved: false };
        const cache = {
            getPageLabelsSync: vi.fn().mockReturnValue(null),
            hasResolvedPageLabels: vi.fn(() => state.resolved),
            ensureInMemoryCache: vi.fn().mockResolvedValue(undefined),
            getMetadata: vi.fn(async () => {
                // Simulate staleness invalidation: record was resolved earlier,
                // but file signature changed so it is now treated as missing.
                // After re-fetch, the record will be updated.
                return null;
            }),
            updatePageLabels: vi.fn(async () => {
                // Simulate: DB row existed, so update succeeded and labels are now resolved.
                state.resolved = true;
            }),
            setMetadataPreservingContentFields: vi.fn().mockResolvedValue(undefined),
        };

        const item = makeItem(42, 'ABCD1234');

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
            getAsync: vi.fn(async () => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        mockIOUtils.exists.mockResolvedValue(true);
        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        await preloadPageLabelsForContent('<citation att_id="1-ABCD1234" />');

        expect(cache.updatePageLabels).toHaveBeenCalledWith(42, {});
        // hasResolvedPageLabels returned true after update → no new record created
        expect(cache.setMetadataPreservingContentFields).not.toHaveBeenCalled();
    });

    it('creates a full record when no cache record exists (case 2: no record)', async () => {
        const { __setMockLabels } = await import('../src/services/pdf/MuPDFService') as any;
        __setMockLabels({ 0: 'i', 1: 'ii', 2: '1' });

        // hasResolvedPageLabels stays false because updatePageLabels is a no-op (no DB row).
        const cache = {
            getPageLabelsSync: vi.fn().mockReturnValue(null),
            hasResolvedPageLabels: vi.fn().mockReturnValue(false),
            ensureInMemoryCache: vi.fn().mockResolvedValue(undefined),
            getMetadata: vi.fn().mockResolvedValue(null),
            updatePageLabels: vi.fn().mockResolvedValue(undefined),
            setMetadataPreservingContentFields: vi.fn().mockResolvedValue(undefined),
        };

        const item = makeItem(43, 'EFGH5678');

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
            getAsync: vi.fn(async () => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        mockIOUtils.exists.mockResolvedValue(true);
        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        await preloadPageLabelsForContent('<citation att_id="1-EFGH5678" />');

        // updatePageLabels called first (no-op since no DB row)
        expect(cache.updatePageLabels).toHaveBeenCalledWith(43, { 0: 'i', 1: 'ii', 2: '1' });
        // hasResolvedPageLabels still false → full record created
        expect(cache.setMetadataPreservingContentFields).toHaveBeenCalledWith(
            expect.objectContaining({
                item_id: 43,
                library_id: 1,
                zotero_key: 'EFGH5678',
                file_path: '/storage/EFGH5678/test.pdf',
                file_mtime_ms: 1700000000000,
                file_size_bytes: 123456,
                page_count: 7,
                page_labels: { 0: 'i', 1: 'ii', 2: '1' },
                has_text_layer: null,
                needs_ocr: null,
                is_encrypted: false,
                is_invalid: false,
            })
        );

        __setMockLabels({});
    });

    it('creates a full record with empty labels when PDF has no custom labels', async () => {
        const { __setMockLabels } = await import('../src/services/pdf/MuPDFService') as any;
        __setMockLabels({});

        const cache = {
            getPageLabelsSync: vi.fn().mockReturnValue(null),
            hasResolvedPageLabels: vi.fn().mockReturnValue(false),
            ensureInMemoryCache: vi.fn().mockResolvedValue(undefined),
            getMetadata: vi.fn().mockResolvedValue(null),
            updatePageLabels: vi.fn().mockResolvedValue(undefined),
            setMetadataPreservingContentFields: vi.fn().mockResolvedValue(undefined),
        };

        const item = makeItem(44, 'IJKL9012');

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
            getAsync: vi.fn(async () => item),
        };
        (globalThis as any).Zotero.Beaver = { attachmentFileCache: cache };

        mockIOUtils.exists.mockResolvedValue(true);
        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        await preloadPageLabelsForContent('<citation att_id="1-IJKL9012" />');

        // Full record created with page_labels: {} (resolved, no custom labels)
        expect(cache.setMetadataPreservingContentFields).toHaveBeenCalledWith(
            expect.objectContaining({
                item_id: 44,
                page_labels: {},
            })
        );
    });
});
