import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

vi.mock('../../../src/services/externalFiles', () => ({
    EXTERNAL_LIBRARY_ID: -1,
    resolveExternalFile: vi.fn(),
}));

const { renderPagesMock, getPageCountMock, processImageBytesMock } = vi.hoisted(() => ({
    renderPagesMock: vi.fn(),
    getPageCountMock: vi.fn(),
    processImageBytesMock: vi.fn(),
}));
vi.mock('../../../src/beaver-extract', async () => {
    const actual = await vi.importActual<any>('../../../src/beaver-extract');
    class MockBeaverExtractor {
        getPageCount = getPageCountMock;
        renderPages = renderPagesMock;
    }
    return {
        ...actual,
        BeaverExtractor: MockBeaverExtractor,
    };
});

vi.mock('../../../src/services/agentDataProvider/imageProcessing', async () => {
    const actual = await vi.importActual<any>('../../../src/services/agentDataProvider/imageProcessing');
    return {
        ...actual,
        processImageBytes: processImageBytesMock,
    };
});

import { handleZoteroViewImagesRequest } from '../../../src/services/agentDataProvider/handleZoteroViewImagesRequest';
import { resolveExternalFile } from '../../../src/services/externalFiles';
import type { WSZoteroViewImagesRequest } from '../../../src/services/agentProtocol';

const EXT_KEY = 'AB12CD34';

const pdfRecord = {
    extKey: EXT_KEY,
    filename: 'paper.pdf',
    originalPath: '/home/user/paper.pdf',
    storedPath: '/mock/data/beaver/external-files/AB12CD34.pdf',
    contentKind: 'pdf' as const,
    mimeType: 'application/pdf',
    fileSize: 1024,
    mtimeMs: 1718000000000,
    pageCount: 12,
    createdAt: '2026-06-01T00:00:00.000Z',
};

function baseRequest(overrides: Partial<WSZoteroViewImagesRequest> = {}): WSZoteroViewImagesRequest {
    return {
        event: 'zotero_view_images_request',
        request_id: 'req-1',
        external_file_key: EXT_KEY,
        ...overrides,
    } as WSZoteroViewImagesRequest;
}

describe('handleZoteroViewImagesRequest (external files)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    });

    it('returns the different-computer file_missing error when the registry has no row', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: false, record: null });

        const response = await handleZoteroViewImagesRequest(baseRequest());

        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('different computer');
        expect(response.external_file_key).toBe(EXT_KEY);
        expect(response.attachment).toBeUndefined();
    });

    it('serves image files through the image conversion path', async () => {
        const record = {
            ...pdfRecord,
            filename: 'figure.png',
            contentKind: 'image' as const,
            mimeType: 'image/png',
        };
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record });
        processImageBytesMock.mockResolvedValue({
            data: new Uint8Array([4, 5, 6]),
            format: 'png',
            width: 80,
            height: 60,
            originalWidth: 80,
            originalHeight: 60,
            sourceMime: 'image/png',
            resized: false,
            converted: false,
        });

        const response = await handleZoteroViewImagesRequest(baseRequest());

        expect(response.error).toBeUndefined();
        expect(response.kind).toBe('image');
        expect(response.images).toHaveLength(1);
        expect(response.images[0].width).toBe(80);
        expect(response.external_file_key).toBe(EXT_KEY);
        // The served external file's own metadata is attached for the backend
        // tool-result view row; external files carry no Zotero parent.
        expect(response.served_attachment).toMatchObject({
            type: 'external_file',
            ext_key: EXT_KEY,
            filename: 'figure.png',
            content_kind: 'image',
        });
        expect(response.parent_item).toBeUndefined();
    });

    it('renders PDF pages via the MuPDF worker', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: pdfRecord });
        getPageCountMock.mockResolvedValue(12);
        renderPagesMock.mockResolvedValue({
            pageCount: 12,
            pageLabels: { 0: 'i' },
            pages: [
                { pageIndex: 0, data: new Uint8Array([9]), format: 'png', width: 100, height: 140 },
                { pageIndex: 1, data: new Uint8Array([9]), format: 'png', width: 100, height: 140 },
            ],
        });

        const response = await handleZoteroViewImagesRequest(baseRequest({ start_page: 1, end_page: 2 }));

        expect(response.error).toBeUndefined();
        expect(response.kind).toBe('pdf');
        expect(response.total_pages).toBe(12);
        expect(response.images.map((image) => image.page_number)).toEqual([1, 2]);
        expect(response.images[0].page_label).toBe('i');
        const renderArgs = renderPagesMock.mock.calls[0];
        expect(renderArgs[1].pageIndices).toEqual([0, 1]);
        expect(response.served_attachment).toMatchObject({
            type: 'external_file',
            ext_key: EXT_KEY,
            filename: 'paper.pdf',
            content_kind: 'pdf',
            page_count: 12,
        });
        expect(response.parent_item).toBeUndefined();
    });

    it('rejects text and EPUB files as not viewable', async () => {
        const record = { ...pdfRecord, filename: 'notes.txt', contentKind: 'text' as const, mimeType: 'text/plain' };
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record });

        const response = await handleZoteroViewImagesRequest(baseRequest());

        expect(response.error_code).toBe('unsupported_type');
        expect(response.error).toContain('read tool');
    });

    it('rejects PDFs over the hard page-count cap before rendering', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: pdfRecord });
        getPageCountMock.mockResolvedValue(1501);

        const response = await handleZoteroViewImagesRequest(baseRequest({ start_page: 1, end_page: 1 }));

        expect(response.error_code).toBe('too_many_pages');
        expect(response.total_pages).toBe(1501);
        expect(renderPagesMock).not.toHaveBeenCalled();
    });

    it('reports out-of-range pages against the document length', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: pdfRecord });
        getPageCountMock.mockResolvedValue(3);

        const response = await handleZoteroViewImagesRequest(baseRequest({ start_page: 5, end_page: 6 }));

        expect(response.error_code).toBe('page_out_of_range');
        expect(response.total_pages).toBe(3);
    });
});
