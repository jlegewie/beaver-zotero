import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    extractCalls: [] as any[],
    extractImpl: null as null | ((args: any) => Promise<any>),
}));

function structuredResult(schemaVersion: string) {
    return {
        schemaVersion,
        mode: 'structured' as const,
        document: {
            pageCount: 1,
            pageLabels: { '0': '1' },
            bboxOrigin: 'top-left' as const,
            bboxPrecision: 1,
            pages: [{ index: 0, label: '1', width: 100, height: 200, viewBox: [0, 0, 100, 200], rotation: 0, items: [] }],
        },
    };
}

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => key === 'installedVersion' ? '0.99.0' : 100),
    setPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentAvailableRemotely: vi.fn(() => false),
}));

vi.mock('../../../src/beaver-extract', () => {
    class MockExtractionError extends Error {
        code: string;
        constructor(code: string, message: string) {
            super(message);
            this.name = 'ExtractionError';
            this.code = code;
        }
    }
    class MockWorkerAbortError extends Error {
        constructor(message = 'worker operation aborted by caller') {
            super(message);
            this.name = 'WorkerAbortError';
        }
    }
    const run = async (args: any) => {
        mockState.extractCalls.push(args);
        if (mockState.extractImpl) return mockState.extractImpl(args);
        return structuredResult(args.schemaVersion ?? '5');
    };
    const mockClient = {
        getPageCount: async () => 1,
        extract: (_pdf: Uint8Array, args: any) => run(args),
        extractSerialized: async (_pdf: Uint8Array, args: any) => {
            const result = await run(args);
            const jsonBytes = new TextEncoder().encode(JSON.stringify(result));
            return {
                mode: result.mode,
                schemaVersion: result.schemaVersion,
                pageCount: 1,
                byteLength: jsonBytes.byteLength,
                jsonBytes,
                cacheMetadata: { pageCount: 1, pageLabels: {}, pages: [null] },
            };
        },
    };
    return {
        ExtractionError: MockExtractionError,
        WorkerAbortError: MockWorkerAbortError,
        StaleWorkerError: class extends Error {},
        WorkerSpawnError: class extends Error {},
        ExtractionErrorCode: {
            ENCRYPTED: 'encrypted',
            NO_TEXT_LAYER: 'no_text_layer',
            INVALID_PDF: 'invalid_pdf',
            EMPTY_DOCUMENT: 'empty_document',
            PAGE_OUT_OF_RANGE: 'page_out_of_range',
            WASM_ERROR: 'wasm_error',
            HEAP_EXHAUSTION: 'heap_exhaustion',
        },
        isWorkerDeadlineError: () => false,
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

vi.mock('../../../src/services/documentExtraction/pdfData', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction/pdfData')>(
        '../../../src/services/documentExtraction/pdfData',
    );
    return {
        ...actual,
        loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
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
import { DocumentCache } from '../../../src/services/documentCache';
import type { BeaverDB } from '../../../src/services/database';

const CACHE_STORAGE_METHODS = [
    'getSourceIdentitySnapshot',
    'getMetadata',
    'getResult',
    'getSerializedResult',
    'getOrCreateResult',
    'getOrCreateSerializedResult',
    'putErrorMetadata',
] as const;

function request(overrides: Record<string, unknown> = {}) {
    return {
        event: 'zotero_document_request' as const,
        request_id: 'req',
        attachment: { library_id: 1, zotero_key: 'ABCD1234' },
        mode: 'structured' as const,
        ...overrides,
    };
}

describe('handleZoteroDocumentRequest schema_version', () => {
    let cache: DocumentCache;
    let storage: Record<(typeof CACHE_STORAGE_METHODS)[number], ReturnType<typeof vi.fn>>;
    let recordAttachmentReadingOutcome: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockState.extractCalls = [];
        mockState.extractImpl = null;
        (globalThis as any).IOUtils.stat.mockResolvedValue({ lastModified: 0, size: 3 });
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue({ loadAllData: vi.fn().mockResolvedValue(undefined) }),
        };
        (globalThis as any).Zotero.Attachments = { getTotalFileSize: vi.fn().mockResolvedValue(3) };

        // A real cache object for its single-flight; storage access is stubbed
        // so the tests can assert the uncached path never reaches it.
        cache = new DocumentCache({} as BeaverDB);
        storage = {} as typeof storage;
        for (const method of CACHE_STORAGE_METHODS) {
            storage[method] = vi.spyOn(cache as any, method).mockResolvedValue(null) as any;
        }
        recordAttachmentReadingOutcome = vi.fn();
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'test' },
            documentCache: cache,
            db: { recordAttachmentReadingOutcome },
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
        };
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: {
                id: 42,
                key: 'ABCD1234',
                libraryID: 1,
                attachmentContentType: 'application/pdf',
                getFilePathAsync: vi.fn().mockResolvedValue('/storage/ABCD1234/test.pdf'),
            },
            key: '1-ABCD1234',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        } as any);
    });

    it('extracts a producible non-current version without reading or writing the cache', async () => {
        const response = await handleZoteroDocumentRequest(request({ schema_version: '4' }));

        expect(response.error_code).toBeUndefined();
        expect((response.result as any).schemaVersion).toBe('4');
        expect(mockState.extractCalls).toEqual([expect.objectContaining({ schemaVersion: '4' })]);
        for (const method of CACHE_STORAGE_METHODS) {
            expect(storage[method], method).not.toHaveBeenCalled();
        }
        expect(recordAttachmentReadingOutcome).not.toHaveBeenCalled();
    });

    it('serves the pre-serialized websocket response in the requested version', async () => {
        const response = await handleZoteroDocumentRequest(
            request({ schema_version: '4' }),
            { responseMode: 'websocket' },
        );

        const json = JSON.stringify(response);
        expect(json).toContain('\\"schemaVersion\\":\\"4\\"');
        expect(mockState.extractCalls).toEqual([expect.objectContaining({ schemaVersion: '4' })]);
        expect(storage.getSerializedResult).not.toHaveBeenCalled();
        expect(storage.getOrCreateSerializedResult).not.toHaveBeenCalled();
    });

    it('runs one extraction for concurrent requests of the same attachment and version', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        mockState.extractImpl = async (args) => {
            await gate;
            return structuredResult(args.schemaVersion);
        };

        const first = handleZoteroDocumentRequest(request({ request_id: 'a', schema_version: '4' }));
        const second = handleZoteroDocumentRequest(request({ request_id: 'b', schema_version: '4' }));
        await vi.waitFor(() => expect(mockState.extractCalls).toHaveLength(1));
        release();

        const responses = await Promise.all([first, second]);
        expect(responses.map((r) => (r.result as any)?.schemaVersion)).toEqual(['4', '4']);
        expect(mockState.extractCalls).toHaveLength(1);
    });

    it('does not record cache error metadata for a failed non-current extraction', async () => {
        const { ExtractionError } = await import('../../../src/beaver-extract');
        mockState.extractImpl = async () => {
            throw new (ExtractionError as any)('encrypted', 'password required');
        };

        const response = await handleZoteroDocumentRequest(request({ schema_version: '4' }));

        expect(response.error_code).toBe('encrypted');
        expect(storage.putErrorMetadata).not.toHaveBeenCalled();
        expect(recordAttachmentReadingOutcome).not.toHaveBeenCalled();
    });

    it('treats the current version like an unversioned request', async () => {
        storage.getOrCreateResult.mockResolvedValue(structuredResult('5'));
        const response = await handleZoteroDocumentRequest(request({ schema_version: '5' }));

        expect(response.error_code).toBeUndefined();
        expect(storage.getMetadata).toHaveBeenCalled();
        expect(storage.getOrCreateResult).toHaveBeenCalled();
        expect(recordAttachmentReadingOutcome).toHaveBeenCalled();
    });

    it('rejects a version the plugin cannot produce', async () => {
        const response = await handleZoteroDocumentRequest(request({ schema_version: '3' }));

        expect(response).toMatchObject({ error_code: 'unsupported_schema_version', content_kind: 'pdf' });
        expect(mockState.extractCalls).toHaveLength(0);
        expect(storage.getMetadata).not.toHaveBeenCalled();
    });

    it('rejects a non-current version in markdown mode', async () => {
        const response = await handleZoteroDocumentRequest(request({ mode: 'markdown', schema_version: '4' }));

        expect(response).toMatchObject({ error_code: 'unsupported_schema_version', content_kind: 'pdf' });
        expect(response.error).toContain('structured mode');
        expect(mockState.extractCalls).toHaveLength(0);
    });

    it('rejects a PDF schema version on a non-PDF attachment', async () => {
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: { id: 43, key: 'EPUB1234', libraryID: 1, attachmentContentType: 'application/epub+zip' },
            key: '1-EPUB1234',
            contentKind: 'epub',
            contentType: 'application/epub+zip',
        } as any);

        const response = await handleZoteroDocumentRequest(request({ schema_version: '5' }));

        expect(response).toMatchObject({ error_code: 'unsupported_schema_version', content_kind: 'epub' });
    });
});
