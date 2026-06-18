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
        mockLoadPdfData.mockResolvedValue(new Uint8Array([1, 2, 3]));
        (globalThis as any).IOUtils.stat.mockResolvedValue({ lastModified: 0, size: 0 });
        (globalThis as any).IOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
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

    it('returns timeout when Zotero item lookup exceeds timeout_seconds', async () => {
        vi.useFakeTimers();
        try {
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(() => new Promise(() => {}));

            const responsePromise = handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'req-lookup-timeout',
                attachment: { library_id: 1, zotero_key: 'ABCD1234' },
                mode: 'structured',
                timeout_seconds: 2,
            });

            await vi.advanceTimersByTimeAsync(2000);
            const response = await responsePromise;

            expect(response).toMatchObject({
                type: 'zotero_document',
                request_id: 'req-lookup-timeout',
                error_code: 'timeout',
            });
            expect(response).not.toHaveProperty('content_kind');
            expect(response.error).toContain('timed out after 2 seconds');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns timeout when Zotero item loading exceeds timeout_seconds', async () => {
        vi.useFakeTimers();
        try {
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue({
                loadAllData: vi.fn(() => new Promise(() => {})),
            });

            const responsePromise = handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'req-load-timeout',
                attachment: { library_id: 1, zotero_key: 'ABCD1234' },
                mode: 'structured',
                timeout_seconds: 2,
            });

            await vi.advanceTimersByTimeAsync(2000);
            const response = await responsePromise;

            expect(response).toMatchObject({
                type: 'zotero_document',
                request_id: 'req-load-timeout',
                error_code: 'timeout',
            });
            expect(response).not.toHaveProperty('content_kind');
            expect(response.error).toContain('timed out after 2 seconds');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns timeout when readable attachment resolution exceeds timeout_seconds', async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(resolveToReadableAttachment).mockImplementation(() => new Promise(() => {}));

            const responsePromise = handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'req-resolution-timeout',
                attachment: { library_id: 1, zotero_key: 'ABCD1234' },
                mode: 'structured',
                timeout_seconds: 2,
            });

            await vi.advanceTimersByTimeAsync(2000);
            const response = await responsePromise;

            expect(response).toMatchObject({
                type: 'zotero_document',
                request_id: 'req-resolution-timeout',
                error_code: 'timeout',
            });
            expect(response).not.toHaveProperty('content_kind');
            expect(response.error).toContain('timed out after 2 seconds');
        } finally {
            vi.useRealTimers();
        }
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
        expect(mockLoadPdfData).not.toHaveBeenCalled();
        expect(mockState.extractCalls).toHaveLength(0);
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);
    });

    it('emits the resolved attachment parent item for direct attachment requests', async () => {
        const parentItem = {
            id: 7,
            key: 'PARENT1',
            libraryID: 1,
            itemType: 'journalArticle',
            itemTypeID: 1,
            isRegularItem: vi.fn(() => true),
            getField: vi.fn((field: string) => {
                const fields: Record<string, string> = {
                    title: 'Parent Paper',
                    date: '2024',
                    publicationTitle: 'Journal',
                    abstractNote: 'Abstract',
                    language: 'en',
                    citationKey: '',
                    extra: '',
                };
                return fields[field] ?? '';
            }),
            getCreators: vi.fn(() => [
                {
                    firstName: 'Jane',
                    lastName: 'Smith',
                    fieldMode: 0,
                    creatorTypeID: 8,
                },
            ]),
            getTags: vi.fn(() => [{ tag: 'tag-1' }]),
            getCollections: vi.fn(() => []),
        };
        const attachmentWithParent = {
            ...resolvedPdfItem,
            isAttachment: vi.fn(() => true),
            parentItemID: parentItem.id,
        };
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
        (globalThis as any).Zotero.Items.getAsync = vi.fn().mockResolvedValue(parentItem);
        (globalThis as any).Zotero.Items.loadDataTypes = vi.fn().mockResolvedValue(undefined);
        (globalThis as any).Zotero.CreatorTypes = {
            getPrimaryIDForType: vi.fn(() => 8),
            getName: vi.fn(() => 'author'),
        };
        (globalThis as any).Zotero.Collections = { get: vi.fn() };
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: attachmentWithParent,
            key: '1-ABCD1234',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-parent',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(response.parent_item).toMatchObject({
            item_id: '1-PARENT1',
            item_type: 'journalArticle',
            title: 'Parent Paper',
            creators: 'Smith',
            year: 2024,
        });
        expect((globalThis as any).Zotero.Items.getAsync).toHaveBeenCalledWith(parentItem.id);
        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith(
            [parentItem],
            ['itemData', 'creators'],
        );
    });

    it('carries parent_item and served_attachment on a post-resolution error', async () => {
        const parentItem = {
            id: 7,
            key: 'PARENT1',
            libraryID: 1,
            itemType: 'journalArticle',
            isRegularItem: vi.fn(() => true),
            getField: vi.fn((field: string) => (({ title: 'Parent Paper', date: '2024' } as Record<string, string>)[field] ?? '')),
            getCreators: vi.fn(() => [{ firstName: 'Jane', lastName: 'Smith', fieldMode: 0, creatorTypeID: 8 }]),
        };
        const attachmentWithParent = {
            ...resolvedPdfItem,
            isAttachment: vi.fn(() => true),
            parentItemID: parentItem.id,
            parentKey: 'PARENT1',
            attachmentFilename: 'paper.pdf',
        };
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
        (globalThis as any).Zotero.Items.getAsync = vi.fn().mockResolvedValue(parentItem);
        (globalThis as any).Zotero.Items.loadDataTypes = vi.fn().mockResolvedValue(undefined);
        (globalThis as any).Zotero.CreatorTypes = {
            getPrimaryIDForType: vi.fn(() => 8),
            getName: vi.fn(() => 'author'),
        };
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: attachmentWithParent,
            key: '1-ABCD1234',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-error-parent',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
            max_pages: 20,
        });

        expect(response.error_code).toBe('too_many_pages');
        expect(response.result).toBeUndefined();
        expect(response.parent_item).toMatchObject({
            item_id: '1-PARENT1',
            item_type: 'journalArticle',
            title: 'Parent Paper',
            creators: 'Smith',
            year: 2024,
        });
        expect(response.served_attachment).toEqual({
            attachment_id: '1-ABCD1234',
            parent_item_id: '1-PARENT1',
            title: null,
            filename: 'paper.pdf',
            content_kind: 'pdf',
        });
    });

    it('still serves the document when parent-item resolution fails', async () => {
        const attachmentWithParent = {
            ...resolvedPdfItem,
            isAttachment: vi.fn(() => true),
            parentItemID: 7,
        };
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
        // Parent lookup rejects: the optional parent_item must degrade to absent
        // without failing the document delivery.
        (globalThis as any).Zotero.Items.getAsync = vi.fn().mockRejectedValue(new Error('db error'));
        (globalThis as any).Zotero.Items.loadDataTypes = vi.fn().mockResolvedValue(undefined);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: attachmentWithParent,
            key: '1-ABCD1234',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-parent-fail',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(response.error).toBeUndefined();
        expect(response.result).toBeTruthy();
        expect(response.parent_item).toBeUndefined();
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
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);
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
            // This is a post-resolution error, so the served-file stub rides along
            // for the view row; the heavier success-only fields stay omitted.
            served_attachment: {
                attachment_id: '1-ABCD1234',
                parent_item_id: null,
                title: null,
                filename: null,
                content_kind: 'pdf',
            },
        });
        expect(response).not.toHaveProperty('result');
        expect(response).not.toHaveProperty('resolved_attachment');
        expect(response).not.toHaveProperty('content_type');
        // The served PDF has no regular-item parent in this fixture.
        expect(response).not.toHaveProperty('parent_item');
        expect(documentCache.getResult).not.toHaveBeenCalled();
    });

    it('extracts plain-text attachments without using the PDF cache', async () => {
        const textItem = {
            libraryID: 1,
            key: 'TEXT1234',
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isPDFAttachment: vi.fn(() => false),
            attachmentContentType: 'text/plain',
            attachmentLinkMode: 0,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/TEXT1234/notes.txt'),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(textItem);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: textItem,
            key: '1-TEXT1234',
            contentKind: 'text',
            contentType: 'text/plain',
        } as any);
        (globalThis as any).IOUtils.read.mockResolvedValue(new TextEncoder().encode('Line one\nLine two'));

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
            content_type: 'text/plain',
            resolved_attachment: { library_id: 1, zotero_key: 'TEXT1234' },
        });
        expect(response.result).toMatchObject({
            content_kind: 'text',
            mode: 'text',
            document: {
                lineCount: 2,
                sourceContentType: 'text/plain',
                lines: [
                    { id: 'l1', line: 1, text: 'Line one' },
                    { id: 'l2', line: 2, text: 'Line two' },
                ],
            },
        });
        expect(mockState.extractCalls).toHaveLength(0);
    });

    it('returns cached EPUB documents through the document request handler', async () => {
        const epubItem = {
            id: 43,
            libraryID: 1,
            key: 'EPUB1234',
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isEPUBAttachment: vi.fn(() => true),
            attachmentContentType: 'application/epub+zip',
            attachmentLinkMode: 0,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/EPUB1234/book.epub'),
        };
        const documentCache = {
            getEpubResult: vi.fn().mockResolvedValue(epubDocument),
        };
        (globalThis as any).Zotero.Beaver = { data: { env: 'test' }, documentCache };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(epubItem);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: epubItem,
            key: '1-EPUB1234',
            contentKind: 'epub',
            contentType: 'application/epub+zip',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-epub',
            attachment: { library_id: 1, zotero_key: 'EPUB1234' },
            mode: 'structured',
        });

        expect(response).toEqual({
            type: 'zotero_document',
            request_id: 'req-epub',
            resolved_attachment: { library_id: 1, zotero_key: 'EPUB1234' },
            content_type: 'application/epub+zip',
            content_kind: 'epub',
            result: epubDocument,
            served_attachment: {
                attachment_id: '1-EPUB1234',
                parent_item_id: null,
                title: null,
                filename: null,
                content_kind: 'epub',
            },
        });
        expect(documentCache.getEpubResult).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: 'EPUB1234' },
            '/storage/EPUB1234/book.epub',
            expect.objectContaining({ maxSourceSizeBytes: expect.any(Number) }),
        );
        expect(mockState.extractCalls).toHaveLength(0);
    });

    it('passes the cache cold-create abort signal into EPUB extraction', async () => {
        const epubItem = {
            id: 45,
            libraryID: 1,
            key: 'COLDEPB1',
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isEPUBAttachment: vi.fn(() => true),
            attachmentContentType: 'application/epub+zip',
            attachmentLinkMode: 0,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/COLDEPB1/book.epub'),
        };
        let capturedCreate: ((signal: AbortSignal) => Promise<unknown>) | null = null;
        const documentCache = {
            getEpubResult: vi.fn().mockResolvedValue(null),
            getOrCreateResult: vi.fn(async (input: any) => {
                capturedCreate = input.create;
                return epubDocument;
            }),
        };
        (globalThis as any).Zotero.Beaver = { data: { env: 'test' }, documentCache };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(epubItem);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: epubItem,
            key: '1-COLDEPB1',
            contentKind: 'epub',
            contentType: 'application/epub+zip',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-cold-epub',
            attachment: { library_id: 1, zotero_key: 'COLDEPB1' },
            mode: 'structured',
        });

        expect(response.content_kind).toBe('epub');
        expect(capturedCreate).toBeTypeOf('function');
        const importESModule = vi.fn();
        (globalThis as any).ChromeUtils = { importESModule };
        const controller = new AbortController();
        controller.abort();
        await expect(capturedCreate!(controller.signal)).rejects.toThrow('Operation aborted');
        expect(importESModule).not.toHaveBeenCalled();
    });

    it('derives no_text_layer for cached EPUB documents with no extracted text', async () => {
        const epubItem = {
            id: 44,
            libraryID: 1,
            key: 'EMPTYEPB',
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isEPUBAttachment: vi.fn(() => true),
            attachmentContentType: 'application/epub+zip',
            attachmentLinkMode: 0,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/EMPTYEPB/book.epub'),
        };
        const emptyDocument = {
            ...epubDocument,
            diagnostics: {
                extractedTextChars: 0,
                sourceTextChars: 0,
                textCoverage: null,
            },
        };
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'test' },
            documentCache: {
                getEpubResult: vi.fn().mockResolvedValue(emptyDocument),
            },
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(epubItem);
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: epubItem,
            key: '1-EMPTYEPB',
            contentKind: 'epub',
            contentType: 'application/epub+zip',
        } as any);

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-empty-epub',
            attachment: { library_id: 1, zotero_key: 'EMPTYEPB' },
            mode: 'structured',
        });

        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-empty-epub',
            content_kind: 'epub',
            error_code: 'no_text_layer',
        });
        expect(response.result).toBeUndefined();
    });

    it('returns timeout when text file path resolution exceeds timeout_seconds', async () => {
        vi.useFakeTimers();
        try {
            const textItem = {
                libraryID: 1,
                key: 'TEXT1234',
                loadAllData: vi.fn().mockResolvedValue(undefined),
                isAttachment: vi.fn(() => true),
                isPDFAttachment: vi.fn(() => false),
                attachmentContentType: 'text/plain',
                attachmentLinkMode: 0,
                getFilePathAsync: vi.fn(() => new Promise<string>(() => {})),
            };
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(textItem);
            vi.mocked(resolveToReadableAttachment).mockResolvedValue({
                resolved: true,
                item: textItem,
                key: '1-TEXT1234',
                contentKind: 'text',
                contentType: 'text/plain',
            } as any);

            const responsePromise = handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'req-text-timeout',
                attachment: { library_id: 1, zotero_key: 'TEXT1234' },
                mode: 'structured',
                timeout_seconds: 2,
            });

            await vi.advanceTimersByTimeAsync(2000);
            const response = await responsePromise;

            expect(response).toMatchObject({
                type: 'zotero_document',
                request_id: 'req-text-timeout',
                content_kind: 'text',
                error_code: 'timeout',
            });
            expect(response.error).toContain('timed out after 2 seconds');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns timeout when text file stat exceeds timeout_seconds', async () => {
        vi.useFakeTimers();
        try {
            const textItem = {
                libraryID: 1,
                key: 'TEXT1234',
                loadAllData: vi.fn().mockResolvedValue(undefined),
                isAttachment: vi.fn(() => true),
                isPDFAttachment: vi.fn(() => false),
                attachmentContentType: 'text/plain',
                attachmentLinkMode: 0,
                getFilePathAsync: vi.fn().mockResolvedValue('/storage/TEXT1234/notes.txt'),
            };
            (globalThis as any).IOUtils.stat.mockImplementation(() => new Promise(() => {}));
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(textItem);
            vi.mocked(resolveToReadableAttachment).mockResolvedValue({
                resolved: true,
                item: textItem,
                key: '1-TEXT1234',
                contentKind: 'text',
                contentType: 'text/plain',
            } as any);

            const responsePromise = handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'req-text-stat-timeout',
                attachment: { library_id: 1, zotero_key: 'TEXT1234' },
                mode: 'structured',
                timeout_seconds: 2,
            });

            await vi.advanceTimersByTimeAsync(2000);
            const response = await responsePromise;

            expect(response).toMatchObject({
                type: 'zotero_document',
                request_id: 'req-text-stat-timeout',
                content_kind: 'text',
                error_code: 'timeout',
            });
            expect(response.error).toContain('timed out after 2 seconds');
            expect(mockLoadPdfData).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns timeout when text file read exceeds timeout_seconds', async () => {
        vi.useFakeTimers();
        try {
            const textItem = {
                libraryID: 1,
                key: 'TEXT1234',
                loadAllData: vi.fn().mockResolvedValue(undefined),
                isAttachment: vi.fn(() => true),
                isPDFAttachment: vi.fn(() => false),
                attachmentContentType: 'text/plain',
                attachmentLinkMode: 0,
                getFilePathAsync: vi.fn().mockResolvedValue('/storage/TEXT1234/notes.txt'),
            };
            (globalThis as any).IOUtils.read.mockImplementation(() => new Promise(() => {}));
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(textItem);
            vi.mocked(resolveToReadableAttachment).mockResolvedValue({
                resolved: true,
                item: textItem,
                key: '1-TEXT1234',
                contentKind: 'text',
                contentType: 'text/plain',
            } as any);

            const responsePromise = handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'req-text-read-timeout',
                attachment: { library_id: 1, zotero_key: 'TEXT1234' },
                mode: 'structured',
                timeout_seconds: 2,
            });

            await vi.advanceTimersByTimeAsync(2000);
            const response = await responsePromise;

            expect(response).toMatchObject({
                type: 'zotero_document',
                request_id: 'req-text-read-timeout',
                content_kind: 'text',
                error_code: 'timeout',
            });
            expect(response.error).toContain('timed out after 2 seconds');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns extraction_failed when text file read fails', async () => {
        const textItem = {
            libraryID: 1,
            key: 'TEXT1234',
            loadAllData: vi.fn().mockResolvedValue(undefined),
            isAttachment: vi.fn(() => true),
            isPDFAttachment: vi.fn(() => false),
            attachmentContentType: 'text/plain',
            attachmentLinkMode: 0,
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/TEXT1234/notes.txt'),
        };
        (globalThis as any).IOUtils.read.mockRejectedValue(new Error('disk read failed'));
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
            request_id: 'req-text-read-failed',
            attachment: { library_id: 1, zotero_key: 'TEXT1234' },
            mode: 'structured',
        });

        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-text-read-failed',
            content_kind: 'text',
            error_code: 'extraction_failed',
        });
        expect(response.error).toContain('Failed to read text attachment');
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
        expect(response.error).toContain('PDF, EPUB, and plain text only');
        expect(response.result).toBeUndefined();
    });
});
