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
        pages: [{ index: 0, label: '1', width: 100, height: 200, items: [] }],
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

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/agentDataProvider/utils')>(
        '../../../src/services/agentDataProvider/utils',
    );
    return {
        ...actual,
        resolveToPdfAttachment: vi.fn(),
        validateZoteroItemReference: vi.fn(() => null),
        loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        checkRemotePdfSize: vi.fn(() => null),
        isRemoteAccessAvailable: vi.fn(() => false),
    };
});

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveToPdfAttachment, loadPdfData } from '../../../src/services/agentDataProvider/utils';

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
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedPdfItem,
            key: '1-ABCD1234',
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

        expect(response.result).toEqual(structuredResult);
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

        expect(response.result).toEqual(structuredResult);
        expect(abortSignal).toBeInstanceOf(AbortSignal);
        expect(abortSignal?.aborted).toBe(false);
    });
});
