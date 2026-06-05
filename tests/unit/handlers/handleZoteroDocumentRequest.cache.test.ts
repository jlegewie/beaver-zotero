import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = {
    extractCalls: [] as any[],
};

const structuredResult = {
    schemaVersion: '4',
    mode: 'structured' as const,
    document: {
        pageCount: 1,
        pageLabels: { '0': '1' },
        bboxOrigin: 'top-left' as const,
        bboxPrecision: 2,
        pages: [{ index: 0, label: '1', width: 100, height: 200, viewBox: [0, 0, 100, 200], rotation: 0, items: [] }],
        citationIndex: {},
    },
};

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => 100),
}));

vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentAvailableRemotely: vi.fn(() => false),
}));

vi.mock('../../../src/beaver-extract', () => {
    class MockBeaverExtractor {
        async getPageCount(): Promise<number> {
            return 1;
        }
        async extract(_pdfData: Uint8Array, args: any): Promise<any> {
            mockState.extractCalls.push(args);
            return structuredResult;
        }
    }

    class MockExtractionError extends Error {
        code: string;
        pageLabels?: Record<number, string>;
        pageCount?: number;

        constructor(code: string, message: string, details?: unknown, pageLabels?: Record<number, string>, pageCount?: number) {
            super(message);
            this.code = code;
            this.pageLabels = pageLabels;
            this.pageCount = pageCount;
        }
    }

    class MockWorkerAbortError extends Error {
        constructor(message = 'worker operation aborted by caller') {
            super(message);
            this.name = 'WorkerAbortError';
        }
    }

    const mockClient = {
        async getPageCount(_pdfData: Uint8Array): Promise<number> {
            return 1;
        },
        async extract(_pdfData: Uint8Array, args: any, _signal?: AbortSignal): Promise<any> {
            mockState.extractCalls.push(args);
            return structuredResult;
        },
    };

    return {
        BeaverExtractor: MockBeaverExtractor,
        ExtractionError: MockExtractionError,
        WorkerAbortError: MockWorkerAbortError,
        ExtractionErrorCode: {
            ENCRYPTED: 'encrypted',
            NO_TEXT_LAYER: 'no_text_layer',
            INVALID_PDF: 'invalid_pdf',
            EMPTY_DOCUMENT: 'empty_document',
            PAGE_OUT_OF_RANGE: 'page_out_of_range',
            WASM_ERROR: 'wasm_error',
            HEAP_EXHAUSTION: 'heap_exhaustion',
        },
        getMuPDFWorkerClient: vi.fn(() => mockClient),
        getExistingMuPDFWorkerClient: vi.fn(() => null),
        disposeMuPDFWorker: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

// `documentExtractionCore` imports these helpers directly from
// `documentExtraction`. `utils.ts` only re-exports them — mocking it would
// not intercept the call, so mock the shared module instead.
vi.mock('../../../src/services/documentExtraction', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction')>(
        '../../../src/services/documentExtraction',
    );
    return {
        ...actual,
        resolveToReadableAttachment: vi.fn(),
        validateZoteroItemReference: vi.fn(() => null),
        loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        checkRemotePdfSize: vi.fn(() => null),
        isRemoteAccessAvailable: vi.fn(() => false),
    };
});

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveToReadableAttachment, loadPdfData } from '../../../src/services/documentExtraction';

describe('handleZoteroDocumentRequest document cache integration', () => {
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

    beforeEach(() => {
        vi.clearAllMocks();
        mockState.extractCalls = [];
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(requestItem),
        };
        (globalThis as any).Zotero.Attachments = {
            getTotalFileSize: vi.fn().mockResolvedValue(1024),
        };
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedPdfItem,
            key: '1-ABCD1234',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        } as any);
    });

    it('returns a cached payload without loading or extracting the PDF', async () => {
        const documentCache = {
            getSourceIdentitySnapshot: vi.fn().mockResolvedValue(null),
            getMetadata: vi.fn().mockResolvedValue({
                pageCount: 1,
                pageLabels: { '0': '1' },
                errorCode: null,
                contentType: 'application/pdf',
            }),
            getResult: vi.fn().mockResolvedValue(structuredResult),
        };
        (globalThis as any).Zotero.Beaver = { data: { env: 'test' }, documentCache };

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(response.content_kind).toBe('pdf');
        expect(response.result).toEqual({ ...structuredResult, content_kind: 'pdf' });
        expect(loadPdfData).not.toHaveBeenCalled();
        expect(mockState.extractCalls).toHaveLength(0);
    });

    it('passes the request abort signal into cache-backed cold extraction', async () => {
        let abortSignal: AbortSignal | undefined;
        const documentCache = {
            getSourceIdentitySnapshot: vi.fn().mockResolvedValue(null),
            getMetadata: vi.fn().mockResolvedValue({
                pageCount: 1,
                pageLabels: { '0': '1' },
                errorCode: null,
                contentType: 'application/pdf',
            }),
            getResult: vi.fn().mockResolvedValue(null),
            getOrCreateResult: vi.fn(async (input: any) => {
                abortSignal = input.abortSignal;
                return structuredResult;
            }),
        };
        (globalThis as any).Zotero.Beaver = { data: { env: 'test' }, documentCache };

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-2',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(response.content_kind).toBe('pdf');
        expect(response.result).toEqual({ ...structuredResult, content_kind: 'pdf' });
        expect(abortSignal).toBeInstanceOf(AbortSignal);
        expect(abortSignal?.aborted).toBe(false);
    });

    it('omits success-only fields when page-count validation returns an error', async () => {
        const documentCache = {
            getSourceIdentitySnapshot: vi.fn().mockResolvedValue(null),
            getMetadata: vi.fn().mockResolvedValue({
                pageCount: 23,
                pageLabels: null,
                errorCode: null,
                contentType: 'application/pdf',
            }),
            getResult: vi.fn(),
        };
        (globalThis as any).Zotero.Beaver = { data: { env: 'test' }, documentCache };

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-too-many-pages',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
            max_pages: 20,
        });

        expect(response).toEqual({
            type: 'zotero_document',
            request_id: 'req-too-many-pages',
            content_kind: 'pdf',
            total_pages: 23,
            error: 'The PDF file for 1-ABCD1234 has 23 pages, which exceeds the 20-page limit.',
            error_code: 'too_many_pages',
        });
        expect(response).not.toHaveProperty('result');
        expect(response).not.toHaveProperty('resolved_attachment');
        expect(response).not.toHaveProperty('content_type');
        expect(documentCache.getResult).not.toHaveBeenCalled();
    });

    it('routes non-PDF text attachments to unsupported_type with the resolved extract kind', async () => {
        const textItem = {
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isPDFAttachment: vi.fn(() => false),
            attachmentContentType: 'text/plain',
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(textItem);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: textItem,
            key: '1-TEXT1234',
            contentKind: 'text',
            contentType: 'text/plain',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-text',
            attachment: { library_id: 1, zotero_key: 'TEXT1234' },
            mode: 'structured',
        });

        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-text',
            content_kind: 'text',
            error_code: 'unsupported_type',
        });
        expect(response.error).toContain('currently supports PDF only');
        expect(response.result).toBeUndefined();
    });

    it('does not report unsupported image attachments as PDF', async () => {
        const imageItem = {
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isPDFAttachment: vi.fn(() => false),
            attachmentContentType: 'image/png',
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(imageItem);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: imageItem,
            key: '1-IMG12345',
            contentKind: 'image',
            contentType: 'image/png',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-image',
            attachment: { library_id: 1, zotero_key: 'IMG12345' },
            mode: 'structured',
        });

        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-image',
            error_code: 'unsupported_type',
        });
        expect(response).not.toHaveProperty('content_kind');
        expect(response.result).toBeUndefined();
    });
});
