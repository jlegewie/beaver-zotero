import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockAttachment, createMockItem } from '../../helpers/factories';

type MockItem = ReturnType<typeof createMockItem>;

const mockExtractAndCacheDocument = vi.fn();
const mockExtractTextDocument = vi.fn();

vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheDocument: (...args: any[]) => mockExtractAndCacheDocument(...args),
}));

vi.mock('../../../src/services/documentExtraction', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction')>(
        '../../../src/services/documentExtraction',
    );
    return {
        ...actual,
        extractTextDocument: (...args: any[]) => mockExtractTextDocument(...args),
    };
});

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    notifyRemoteDownloadFailure: vi.fn(),
}));

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';

function request(key = 'TEXT0001') {
    return {
        event: 'zotero_document_request' as const,
        request_id: 'req-text',
        attachment: { library_id: 1, zotero_key: key },
        mode: 'markdown' as const,
    };
}

describe('handleZoteroDocumentRequest text fallback dispatch', () => {
    const itemsById = new Map<number, MockItem>();
    const itemsByKey = new Map<string, MockItem>();

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById.clear();
        itemsByKey.clear();
        (globalThis as any).Zotero.Items = {
            loadDataTypes: vi.fn(async () => undefined),
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => itemsById.get(id)).filter(Boolean),
            ),
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
                itemsByKey.get(`${libraryID}-${key}`) ?? false,
            ),
        };
        (globalThis as any).Zotero.Beaver = {
            db: { enqueueBackgroundJob: vi.fn() },
            backgroundExtractor: { notify: vi.fn() },
        };
        mockExtractAndCacheDocument.mockResolvedValue({
            kind: 'response_error',
            code: 'not_pdf',
            message: 'Attachment 1-TEXT0001 is not a PDF (type: text/plain)',
            pageCount: null,
        });
        mockExtractTextDocument.mockResolvedValue({
            kind: 'ok',
            result: {
                content_kind: 'text',
                schemaVersion: '1',
                sourceContentType: 'text/plain',
                lineCount: 2,
                text: 'alpha\nbravo',
            },
            resolvedAttachment: { libraryId: 1, zoteroKey: 'TEXT0001' },
            contentType: 'text/plain',
        });
    });

    it('extracts a direct text attachment after the PDF path rejects it as not_pdf', async () => {
        const text = createMockAttachment({
            id: 10,
            key: 'TEXT0001',
            contentType: 'text/plain',
            filename: 'notes.txt',
        });
        itemsByKey.set('1-TEXT0001', text);

        const response = await handleZoteroDocumentRequest(request());

        expect(mockExtractAndCacheDocument).toHaveBeenCalledOnce();
        expect(mockExtractTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            item: text,
            requestKey: '1-TEXT0001',
            contentType: 'text/plain',
        }));
        expect(response).toEqual({
            type: 'zotero_document',
            request_id: 'req-text',
            resolved_attachment: { library_id: 1, zotero_key: 'TEXT0001' },
            content_type: 'text/plain',
            result: {
                content_kind: 'text',
                schemaVersion: '1',
                sourceContentType: 'text/plain',
                lineCount: 2,
                text: 'alpha\nbravo',
            },
        });
    });

    it('returns not_implemented for direct readable non-text attachments', async () => {
        const epub = createMockAttachment({
            id: 11,
            key: 'EPUB0001',
            contentType: 'application/epub+zip',
            filename: 'book.epub',
        });
        itemsByKey.set('1-EPUB0001', epub);
        mockExtractAndCacheDocument.mockResolvedValue({
            kind: 'response_error',
            code: 'not_pdf',
            message: 'Attachment 1-EPUB0001 is not a PDF (type: application/epub+zip)',
            pageCount: null,
        });

        const response = await handleZoteroDocumentRequest(request('EPUB0001'));

        expect(mockExtractTextDocument).not.toHaveBeenCalled();
        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-text',
            error_code: 'not_implemented',
        });
    });

    it('returns not_readable for direct unreadable attachments', async () => {
        const zip = createMockAttachment({
            id: 12,
            key: 'ZIP00001',
            contentType: 'application/zip',
            filename: 'archive.zip',
        });
        itemsByKey.set('1-ZIP00001', zip);
        mockExtractAndCacheDocument.mockResolvedValue({
            kind: 'response_error',
            code: 'not_pdf',
            message: 'Attachment 1-ZIP00001 is not a PDF (type: application/zip)',
            pageCount: null,
        });

        const response = await handleZoteroDocumentRequest(request('ZIP00001'));

        expect(mockExtractTextDocument).not.toHaveBeenCalled();
        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-text',
            error_code: 'not_readable',
        });
    });

    it('does not divert a regular item with any PDF child to text fallback', async () => {
        const pdf = createMockAttachment({
            id: 20,
            key: 'PDF00001',
            contentType: 'application/pdf',
            filename: 'paper.pdf',
        });
        const text = createMockAttachment({
            id: 21,
            key: 'TEXT0001',
            contentType: 'text/plain',
            filename: 'notes.txt',
        });
        const regular = createMockItem({
            key: 'REG00001',
            attachmentIDs: [20, 21],
            bestAttachment: text,
        });
        itemsById.set(20, pdf);
        itemsById.set(21, text);
        itemsByKey.set('1-REG00001', regular);
        mockExtractAndCacheDocument.mockResolvedValue({
            kind: 'response_error',
            code: 'not_attachment',
            message: "The id '1-REG00001' is a regular item, not an attachment.",
            pageCount: null,
        });

        const response = await handleZoteroDocumentRequest(request('REG00001'));

        expect(mockExtractTextDocument).not.toHaveBeenCalled();
        expect(response).toEqual({
            type: 'zotero_document',
            request_id: 'req-text',
            total_pages: null,
            error: "The id '1-REG00001' is a regular item, not an attachment.",
            error_code: 'not_attachment',
        });
    });

    it('extracts a regular item with a single text child and no PDF children', async () => {
        const text = createMockAttachment({
            id: 21,
            key: 'TEXT0001',
            contentType: 'text/plain',
            filename: 'notes.txt',
        });
        const regular = createMockItem({
            key: 'REG00001',
            attachmentIDs: [21],
            bestAttachment: text,
        });
        itemsById.set(21, text);
        itemsByKey.set('1-REG00001', regular);
        itemsByKey.set('1-TEXT0001', text);
        mockExtractAndCacheDocument.mockResolvedValue({
            kind: 'response_error',
            code: 'not_attachment',
            message: "The id '1-REG00001' is a regular item, not an attachment.",
            pageCount: null,
        });

        const response = await handleZoteroDocumentRequest(request('REG00001'));

        expect(mockExtractTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            item: text,
            requestKey: '1-TEXT0001',
        }));
        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-text',
            content_type: 'text/plain',
            result: { content_kind: 'text', lineCount: 2 },
        });
    });
});
