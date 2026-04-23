import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/pdf', () => {
    class MockPDFExtractor {
        async getPageCount(): Promise<number> {
            return 3;
        }

        async getPageCountAndLabels(): Promise<{ count: number; labels: Record<number, string> }> {
            return {
                count: 3,
                labels: { 0: 'i', 1: '1', 2: '2' },
            };
        }

        async renderPagesToImages(
            _pdfData: Uint8Array,
            pageIndices?: number[]
        ): Promise<Array<{ pageIndex: number; data: Uint8Array; format: 'png'; width: number; height: number; scale: number; dpi: number }>> {
            const indices = pageIndices ?? [0, 1, 2];
            return indices.map((pageIndex) => ({
                pageIndex,
                data: new Uint8Array([1, 2, 3]),
                format: 'png' as const,
                width: 100,
                height: 200,
                scale: 1,
                dpi: 72,
            }));
        }
    }

    class MockExtractionError extends Error {
        code: string;

        constructor(code: string, message: string) {
            super(message);
            this.code = code;
        }
    }

    return {
        PDFExtractor: MockPDFExtractor,
        ExtractionError: MockExtractionError,
        ExtractionErrorCode: {
            ENCRYPTED: 'encrypted',
            INVALID_PDF: 'invalid_pdf',
            PAGE_OUT_OF_RANGE: 'page_out_of_range',
        },
        // Passthrough — concurrency is exercised in heavyOpLimiter.test.ts.
        runHeavyPdfOp: <T,>(task: () => Promise<T>) => task(),
    };
});

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
    loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
    checkRemotePdfSize: vi.fn(() => null),
    isRemoteAccessAvailable: vi.fn(() => false),
}));

import { handleZoteroAttachmentPageImagesRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentPageImagesRequest';
import { resolveToPdfAttachment } from '../../../src/services/agentDataProvider/utils';

describe('handleZoteroAttachmentPageImagesRequest page labels', () => {
    const mockIOUtils = (globalThis as any).IOUtils as {
        read: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('hydrates page_label on cold caches even when prefer_page_labels is false', async () => {
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                is_encrypted: false,
                is_invalid: false,
                page_count: 3,
                page_labels: null,
            }),
        };

        const resolvedPdfItem = {
            id: 42,
            key: 'ABCD1234',
            libraryID: 1,
            attachmentContentType: 'application/pdf',
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/ABCD1234/test.pdf'),
        };

        const requestItem = {
            loadAllData: vi.fn().mockResolvedValue(undefined),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(requestItem),
        };
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'test' },
            attachmentFileCache: cache,
        };

        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedPdfItem,
            key: '1-ABCD1234',
        } as any);

        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const response = await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
            prefer_page_labels: false,
        });

        expect(response.pages).toEqual([
            expect.objectContaining({
                page_number: 1,
                page_label: 'i',
            }),
        ]);
    });
});
