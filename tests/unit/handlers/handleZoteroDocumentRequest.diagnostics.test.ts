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

const epubDocument = {
    content_kind: 'epub' as const,
    schemaVersion: '1',
    sectionCount: 1,
    sections: [
        {
            index: 0,
            rawHref: 'EPUB/chapter.xhtml',
            items: [
                {
                    id: 'p1',
                    kind: 'text' as const,
                    sectionIndex: 0,
                    order: 0,
                    text: 'First.',
                    sentences: [{ id: 's1', text: 'First.' }],
                },
            ],
        },
    ],
    citationIndex: {
        s1: {
            id: 's1',
            kind: 'sentence' as const,
            sectionIndex: 0,
            itemId: 'p1',
            sentenceId: 's1',
        },
    },
    diagnostics: {
        extractedTextChars: 6,
        sourceTextChars: 6,
        textCoverage: 1,
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

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
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
const mockLoadPdfData = vi.fn(async () => new Uint8Array([1, 2, 3]));

vi.mock('../../../src/services/documentExtraction/pdfData', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction/pdfData')>(
        '../../../src/services/documentExtraction/pdfData',
    );
    return {
        ...actual,
        loadPdfData: (...args: unknown[]) => mockLoadPdfData(...args),
        checkRemotePdfSize: vi.fn(() => null),
        isRemoteAccessAvailable: vi.fn(() => false),
    };
});

vi.mock('../../../src/services/documentExtraction', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction')>(
        '../../../src/services/documentExtraction',
    );
    return {
        ...actual,
        resolveToReadableAttachment: vi.fn(),
        validateZoteroItemReference: vi.fn(() => null),
    };
});

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveToReadableAttachment } from '../../../src/services/documentExtraction';

/**
 * `attachment_diagnostics` on successful document responses: gathered from the
 * Zotero DB in parallel with extraction, delivered only when complete and
 * within budget, and never allowed to fail or delay the document itself.
 */
describe('handleZoteroDocumentRequest attachment diagnostics', () => {
    const TEXT_REQUEST = {
        event: 'zotero_document_request' as const,
        request_id: 'req-diagnostics',
        attachment: { library_id: 1, zotero_key: 'TEXT1234' },
        mode: 'structured' as const,
    };

    function textItem(overrides: Record<string, unknown> = {}) {
        return {
            id: 5,
            libraryID: 1,
            key: 'TEXT1234',
            parentItemID: 9,
            loadAllData: vi.fn().mockResolvedValue(undefined),
            loadDataType: vi.fn().mockResolvedValue(undefined),
            getAnnotations: vi.fn(() => [{}, {}]),
            isAttachment: vi.fn(() => true),
            isPDFAttachment: vi.fn(() => false),
            attachmentContentType: 'text/plain',
            attachmentLinkMode: 0,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/TEXT1234/notes.txt'),
            ...overrides,
        };
    }

    function bestAttachmentRow(parentItemID: number, attachmentItemID: number) {
        return vi.fn(async (_sql: string, _params: unknown[], options: { onRow: (row: any) => void }) => {
            options.onRow({ getResultByIndex: (index: number) => (index === 0 ? parentItemID : attachmentItemID) });
        });
    }

    function serveText(item: ReturnType<typeof textItem>) {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Items.getAsync = vi.fn().mockResolvedValue(null);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item,
            key: '1-TEXT1234',
            contentKind: 'text',
            contentType: 'text/plain',
        } as any);
        (globalThis as any).IOUtils.read.mockResolvedValue(new TextEncoder().encode('Line one\nLine two'));
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).IOUtils.stat.mockResolvedValue({ lastModified: 0, size: 0 });
        (globalThis as any).Zotero.Items = {};
        (globalThis as any).Zotero.Attachments = {
            getTotalFileSize: vi.fn().mockResolvedValue(1024),
            LINK_MODE_LINKED_URL: 3,
        };
        (globalThis as any).Zotero.Beaver = { data: { env: 'test' } };
        (globalThis as any).Zotero.DB = { queryAsync: bestAttachmentRow(9, 5) };
    });

    it('reports the primary flag and annotation count on success', async () => {
        const item = textItem();
        serveText(item);

        const response = await handleZoteroDocumentRequest(TEXT_REQUEST);

        expect(response.error).toBeUndefined();
        expect(response.attachment_diagnostics).toEqual({ is_primary: true, annotations_count: 2 });
        expect(item.loadDataType).toHaveBeenCalledWith('childItems');
        expect((globalThis as any).Zotero.DB.queryAsync).toHaveBeenCalledTimes(1);
    });

    it('marks a sibling that is not the best attachment as not primary', async () => {
        (globalThis as any).Zotero.DB = { queryAsync: bestAttachmentRow(9, 6) };
        serveText(textItem());

        const response = await handleZoteroDocumentRequest(TEXT_REQUEST);

        expect(response.attachment_diagnostics).toEqual({ is_primary: false, annotations_count: 2 });
    });

    it('skips the best-attachment query for standalone attachments', async () => {
        serveText(textItem({ parentItemID: false, getAnnotations: vi.fn(() => []) }));

        const response = await handleZoteroDocumentRequest(TEXT_REQUEST);

        expect(response.attachment_diagnostics).toEqual({ is_primary: false, annotations_count: 0 });
        expect((globalThis as any).Zotero.DB.queryAsync).not.toHaveBeenCalled();
    });

    it('omits the field when the database reads exceed the budget', async () => {
        vi.useFakeTimers();
        try {
            (globalThis as any).Zotero.DB = { queryAsync: vi.fn(() => new Promise(() => {})) };
            serveText(textItem());

            const responsePromise = handleZoteroDocumentRequest(TEXT_REQUEST);
            await vi.advanceTimersByTimeAsync(1500);
            const response = await responsePromise;

            expect(response.error).toBeUndefined();
            expect(response.content_kind).toBe('text');
            expect(response).not.toHaveProperty('attachment_diagnostics');
        } finally {
            vi.useRealTimers();
        }
    });

    it('omits the field when a database read fails', async () => {
        (globalThis as any).Zotero.DB = { queryAsync: vi.fn().mockRejectedValue(new Error('db locked')) };
        serveText(textItem());

        const response = await handleZoteroDocumentRequest(TEXT_REQUEST);

        expect(response.error).toBeUndefined();
        expect(response).not.toHaveProperty('attachment_diagnostics');
    });

    it('never attaches diagnostics to error responses', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);

        const response = await handleZoteroDocumentRequest(TEXT_REQUEST);

        expect(response.error_code).toBe('not_found');
        expect(response).not.toHaveProperty('attachment_diagnostics');
    });
});
