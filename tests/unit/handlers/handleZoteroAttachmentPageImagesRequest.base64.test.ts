import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderBytesByPage = new Map<number, Uint8Array>();

vi.mock('../../../src/services/pdf', () => {
    class MockPDFExtractor {
        async getPageCount(): Promise<number> {
            return renderBytesByPage.size;
        }

        async getPageCountAndLabels(): Promise<{ count: number; labels: Record<number, string> }> {
            return { count: renderBytesByPage.size, labels: {} };
        }

        async renderPagesToImagesWithMeta(
            _pdfData: Uint8Array | ArrayBuffer,
            args: any,
        ): Promise<{ pageCount: number; pageLabels: Record<number, string>; pages: any[] }> {
            const indices: number[] = args?.pageIndices ?? Array.from(renderBytesByPage.keys());
            return {
                pageCount: renderBytesByPage.size,
                pageLabels: {},
                pages: indices.map((pageIndex) => ({
                    pageIndex,
                    data: renderBytesByPage.get(pageIndex) ?? new Uint8Array(),
                    format: 'png' as const,
                    width: 100,
                    height: 200,
                    scale: 1,
                    dpi: 72,
                })),
            };
        }
    }

    class MockExtractionError extends Error {
        code: string;
        pageCount?: number;
        constructor(code: string, message: string, _details?: unknown, _pageLabels?: Record<number, string>, pageCount?: number) {
            super(message);
            this.code = code;
            this.pageCount = pageCount;
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

function nodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function setupZoteroEnv(pageCount: number) {
    const cache = {
        getMetadata: vi.fn().mockResolvedValue({
            is_encrypted: false,
            is_invalid: false,
            page_count: pageCount,
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

    const mockIOUtils = (globalThis as any).IOUtils as { read: ReturnType<typeof vi.fn> };
    mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
}

describe('handleZoteroAttachmentPageImagesRequest base64 encoding', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        renderBytesByPage.clear();
    });

    it('encodes low bytes (ASCII range) correctly', async () => {
        const bytes = new Uint8Array([0x00, 0x01, 0x41, 0x7f]);
        renderBytesByPage.set(0, bytes);
        setupZoteroEnv(1);

        const response = await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(response.pages[0].image_data).toBe(nodeBase64(bytes));
    });

    it('encodes high bytes (0x80-0xFF) correctly via Latin-1 mapping', async () => {
        const bytes = new Uint8Array([0x80, 0x81, 0xc3, 0xff, 0xfe, 0xab]);
        renderBytesByPage.set(0, bytes);
        setupZoteroEnv(1);

        const response = await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(response.pages[0].image_data).toBe(nodeBase64(bytes));
    });

    it('encodes a realistic PNG header signature correctly', async () => {
        const pngHeader = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        ]);
        renderBytesByPage.set(0, pngHeader);
        setupZoteroEnv(1);

        const response = await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(response.pages[0].image_data).toBe(nodeBase64(pngHeader));
    });

    it('encodes a large payload (covers all 256 byte values, repeated)', async () => {
        const pattern = new Uint8Array(256);
        for (let i = 0; i < 256; i++) pattern[i] = i;
        const big = new Uint8Array(256 * 200); // ~51 KB, includes every byte value
        for (let i = 0; i < 200; i++) big.set(pattern, i * 256);
        renderBytesByPage.set(0, big);
        setupZoteroEnv(1);

        const response = await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(response.pages[0].image_data).toBe(nodeBase64(big));
    });
});
