import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/pdf', () => {
    class MockPDFExtractor {
        async getPageCount(): Promise<number> {
            return 3;
        }

        async extract(): Promise<{ pages: Array<{ index: number; label: string; content: string; width: number; height: number }>; pageLabels?: Record<number, string> }> {
            return {
                pages: [{ index: 0, label: '1', content: 'page-1', width: 100, height: 200 }],
                pageLabels: undefined,
            };
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
            NO_TEXT_LAYER: 'no_text_layer',
            INVALID_PDF: 'invalid_pdf',
            PAGE_OUT_OF_RANGE: 'page_out_of_range',
        },
    };
});

vi.mock('../src/services/agentDataProvider/utils', () => ({
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
}));

import { handleZoteroAttachmentPagesRequest } from '../src/services/agentDataProvider/handleZoteroAttachmentPagesRequest';
import { resolveToPdfAttachment } from '../src/services/agentDataProvider/utils';

describe('handleZoteroAttachmentPagesRequest page label persistence', () => {
    const mockIOUtils = (globalThis as any).IOUtils as {
        read: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('stores page_labels as {} when extraction checked labels and none were found', async () => {
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                is_encrypted: false,
                is_invalid: false,
                needs_ocr: false,
                page_count: 3,
            }),
            getContentRange: vi.fn().mockResolvedValue(null),
            setMetadataPreservingContentFields: vi.fn().mockResolvedValue(undefined),
            setContentPages: vi.fn().mockResolvedValue(undefined),
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
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            start_page: 1,
            end_page: 1,
            skip_local_limits: true,
        });

        expect(cache.setMetadataPreservingContentFields).toHaveBeenCalledWith(expect.objectContaining({
            item_id: 42,
            page_labels: {},
            page_count: 3,
        }));
    });
});
