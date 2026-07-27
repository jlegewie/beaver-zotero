/**
 * Slot-dependent shared-extraction budget.
 *
 * The hot (interactive) worker slot serves one extraction at a time, so a
 * detached shared extraction must be aborted near the request's own deadline
 * instead of the full MAX_PDF_TIMEOUT_SECONDS ceiling — otherwise it
 * head-of-line-blocks every subsequent interactive read. The background slot
 * keeps the full ceiling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    extractMock,
    getPageCountMock,
} = vi.hoisted(() => ({
    extractMock: vi.fn(),
    getPageCountMock: vi.fn(),
}));

vi.mock('../../../src/beaver-extract', () => ({
    StaleWorkerError: class MockStaleWorkerError extends Error {},
    WorkerSpawnError: class MockWorkerSpawnError extends Error {},
    ExtractionError: class MockExtractionError extends Error {},
    WorkerAbortError: class MockWorkerAbortError extends Error {},
    ExtractionErrorCode: {
        ENCRYPTED: 'encrypted',
        NO_TEXT_LAYER: 'no_text_layer',
        INVALID_PDF: 'invalid_pdf',
        EMPTY_DOCUMENT: 'empty_document',
        PAGE_OUT_OF_RANGE: 'page_out_of_range',
        WASM_ERROR: 'wasm_error',
        HEAP_EXHAUSTION: 'heap_exhaustion',
    },
    isTransientWorkerError: () => false,
    isWorkerDeadlineError: () => false,
    getMuPDFWorkerClient: vi.fn(() => ({
        getPageCount: getPageCountMock,
        extract: extractMock,
        extractSerialized: vi.fn(),
    })),
}));

vi.mock('../../../src/services/documentExtraction', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction')>(
        '../../../src/services/documentExtraction',
    );
    return {
        ...actual,
        loadAttachmentData: vi.fn().mockResolvedValue({
            kind: 'ok',
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        }),
    };
});

import {
    extractAndCacheResolvedPdfDocument,
    HOT_SHARED_EXTRACTION_GRACE_MS,
    type ExtractAndCacheResolvedPdfArgs,
} from '../../../src/services/documentExtractionCore';
import {
    MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
    MAX_PDF_TIMEOUT_SECONDS,
    TimeoutError,
} from '../../../src/services/agentDataProvider/timeout';
// Deep import: the '../../../src/beaver-extract' barrel is mocked above, but
// the lease constant must be the real value for the invariant check.
import { DEFAULT_BUSY_LEASE_MS_HOT } from '../../../src/beaver-extract/MuPDFWorkerClient';

const extractedResult = (pageCount: number) => ({
    mode: 'structured',
    schemaVersion: '4',
    document: { pageCount, pages: [], citationIndex: {} },
});

const documentCacheMock = {
    getSourceIdentitySnapshot: vi.fn(),
    getMetadata: vi.fn(),
    getResult: vi.fn(),
    getSerializedResult: vi.fn(),
    getOrCreateResult: vi.fn(),
    getOrCreateSerializedResult: vi.fn(),
};

const runPdf = (overrides: Partial<ExtractAndCacheResolvedPdfArgs> = {}) =>
    extractAndCacheResolvedPdfDocument({
        source: {
            kind: 'external',
            filePath: '/tmp/does-not-matter.pdf',
            itemRef: { id: 0, libraryID: -1, key: 'EXTKEY01' },
        },
        resolvedKey: 'ext-EXTKEY01',
        contentType: 'application/pdf',
        mode: 'structured',
        maxPages: null,
        maxFileSizeMB: 0,
        timeoutSeconds: 60,
        workerName: 'hot',
        ...overrides,
    });

describe('extractAndCacheResolvedPdfDocument shared-extraction budget', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPageCountMock.mockResolvedValue(3);
        documentCacheMock.getSourceIdentitySnapshot.mockResolvedValue({ sourceSizeBytes: 1000 });
        documentCacheMock.getMetadata.mockResolvedValue(null);
        documentCacheMock.getResult.mockResolvedValue(null);
        documentCacheMock.getSerializedResult.mockResolvedValue(null);
        documentCacheMock.getOrCreateResult.mockResolvedValue(extractedResult(3));
        (globalThis as any).Zotero = { ...(globalThis as any).Zotero };
        (globalThis as any).Zotero.Beaver = { data: { env: 'production' }, documentCache: documentCacheMock };
        (globalThis as any).IOUtils = {
            ...(globalThis as any).IOUtils,
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
        };
    });

    it('caps the hot-slot shared extraction near the request deadline', async () => {
        const result = await runPdf({ timeoutSeconds: 60 });

        expect(result).toMatchObject({ kind: 'ok', totalPages: 3 });
        expect(documentCacheMock.getOrCreateResult).toHaveBeenCalledWith(
            expect.objectContaining({
                lockScope: 'hot',
                sharedTimeoutMs: 60 * 1000 + HOT_SHARED_EXTRACTION_GRACE_MS,
            }),
        );
    });

    it('keeps the full ceiling for the background slot', async () => {
        const result = await runPdf({ workerName: 'background', timeoutSeconds: 60 });

        expect(result).toMatchObject({ kind: 'ok', totalPages: 3 });
        expect(documentCacheMock.getOrCreateResult).toHaveBeenCalledWith(
            expect.objectContaining({
                lockScope: 'background',
                sharedTimeoutMs: MAX_PDF_TIMEOUT_SECONDS * 1000,
            }),
        );
    });

    it('clamps a hot-slot request timeout to the interactive ceiling', async () => {
        const result = await runPdf({ timeoutSeconds: MAX_PDF_TIMEOUT_SECONDS });

        expect(result).toMatchObject({ kind: 'ok', totalPages: 3 });
        expect(documentCacheMock.getOrCreateResult).toHaveBeenCalledWith(
            expect.objectContaining({
                lockScope: 'hot',
                sharedTimeoutMs:
                    MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS * 1000
                    + HOT_SHARED_EXTRACTION_GRACE_MS,
            }),
        );
    });

    it('does not clamp a background-slot request timeout to the interactive ceiling', async () => {
        documentCacheMock.getOrCreateResult.mockRejectedValue(
            new TimeoutError(170, 170_000, 'pdf_extract'),
        );

        const result = await runPdf({ workerName: 'background', timeoutSeconds: 170 });

        expect(result).toMatchObject({ kind: 'timeout', timeoutSeconds: 170 });
    });
});

describe('hot busy-lease budget invariant', () => {
    it('keeps the interactive ceiling plus shared grace below the hot busy lease', () => {
        expect(
            MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS * 1000 + HOT_SHARED_EXTRACTION_GRACE_MS,
        ).toBeLessThan(DEFAULT_BUSY_LEASE_MS_HOT);
    });
});

describe('extractAndCacheResolvedPdfDocument page caps around the cache', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        documentCacheMock.getSourceIdentitySnapshot.mockResolvedValue({ sourceSizeBytes: 1000 });
        documentCacheMock.getMetadata.mockResolvedValue(null);
        documentCacheMock.getResult.mockResolvedValue(null);
        documentCacheMock.getSerializedResult.mockResolvedValue(null);
        documentCacheMock.getOrCreateResult.mockResolvedValue(extractedResult(3));
        (globalThis as any).Zotero = { ...(globalThis as any).Zotero };
        (globalThis as any).Zotero.Beaver = { data: { env: 'production' }, documentCache: documentCacheMock };
        (globalThis as any).IOUtils = {
            ...(globalThis as any).IOUtils,
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
        };
    });

    it('rejects an over-cap document with too_many_pages before extracting', async () => {
        getPageCountMock.mockResolvedValue(2000);

        const result = await runPdf({ maxPages: 1500 });

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'too_many_pages',
            pageCount: 2000,
        });
        expect(documentCacheMock.getOrCreateResult).not.toHaveBeenCalled();
        expect(extractMock).not.toHaveBeenCalled();
    });
});
