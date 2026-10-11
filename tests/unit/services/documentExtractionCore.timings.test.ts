/**
 * `timings` on PDF results of `extractAndCacheResolvedPdfDocument`: where the
 * request spent its time in the plugin and how it got the document (cache,
 * its own extraction, or another request's).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { extractSerializedMock, getPageCountMock } = vi.hoisted(() => ({
    extractSerializedMock: vi.fn(),
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
        extract: vi.fn(),
        extractSerialized: extractSerializedMock,
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

import { extractAndCacheResolvedPdfDocument } from '../../../src/services/documentExtractionCore';
import type { WorkerCallTiming } from '../../../src/beaver-extract/MuPDFWorkerClient';

const serialized = {
    mode: 'structured',
    schemaVersion: '5',
    pageCount: 3,
    byteLength: 2,
    jsonBytes: new Uint8Array([123, 125]),
    cacheMetadata: { pageCount: 3, pageLabels: {}, pages: [] },
};
const stored = {
    schemaVersion: '5',
    mode: 'structured',
    document: { pageCount: 3 },
    byteLength: 2,
    jsonBytes: new Uint8Array([123, 125]),
    metadata: { pageCount: 3, pageLabels: {}, pages: [] },
};

const documentCacheMock = {
    getSourceIdentitySnapshot: vi.fn(),
    getMetadata: vi.fn(),
    getSerializedResult: vi.fn(),
    getOrCreateSerializedResult: vi.fn(),
};

const runPdf = () =>
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
        timeoutSeconds: 60,
        workerName: 'hot',
        serializedResult: true,
    });

/** The cache runs this request's extraction (`create`) and stores the result. */
const leaderCache = () =>
    documentCacheMock.getOrCreateSerializedResult.mockImplementation(async (input: { create: (s: AbortSignal) => Promise<unknown> }) => {
        await input.create(new AbortController().signal);
        return stored;
    });

describe('extractAndCacheResolvedPdfDocument timings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPageCountMock.mockImplementation(async (_data: unknown, _signal: unknown, timing?: WorkerCallTiming) => {
            if (timing) Object.assign(timing, { workerState: 'warm', clientQueueMs: 10, startMs: 0, queueMs: 0.4, opMs: 2 });
            return 3;
        });
        extractSerializedMock.mockImplementation(async (_data: unknown, _args: unknown, _signal: unknown, timing?: WorkerCallTiming) => {
            if (timing) Object.assign(timing, { workerState: 'first_extract', clientQueueMs: 50.2, startMs: 0, queueMs: 3.4, opMs: 120.6 });
            return serialized;
        });
        documentCacheMock.getSourceIdentitySnapshot.mockResolvedValue({ sourceSizeBytes: 1000 });
        documentCacheMock.getMetadata.mockResolvedValue(null);
        documentCacheMock.getSerializedResult.mockResolvedValue(null);
        (globalThis as any).Zotero = { ...(globalThis as any).Zotero };
        (globalThis as any).Zotero.Beaver = { data: { env: 'production' }, documentCache: documentCacheMock };
        (globalThis as any).IOUtils = {
            ...(globalThis as any).IOUtils,
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
        };
    });

    it('reports every stage of a request that extracts the document', async () => {
        leaderCache();
        const result = await runPdf();
        expect(result.kind).toBe('ok');
        const timings = result.kind === 'ok' ? result.timings : undefined;
        // Waits are summed over the page-count and extraction ops; the run time is the extraction's.
        expect(timings).toMatchObject({
            source: 'extracted',
            workerState: 'first_extract',
            clientQueueMs: 60,
            workerStartMs: 0,
            workerQueueMs: 4,
            workerOpMs: 121,
        });
        for (const stage of ['resolveMs', 'cacheLookupMs', 'fileReadMs', 'pageCountMs', 'extractMs', 'cacheWriteMs'] as const) {
            expect(timings?.[stage]).toBeGreaterThanOrEqual(0);
        }
        // The worker reported its own times to the extraction call.
        expect(extractSerializedMock.mock.calls[0][3]).toMatchObject({ clientQueueMs: 50.2, queueMs: 3.4, opMs: 120.6 });
    });

    it('reports a cache hit without worker stages', async () => {
        documentCacheMock.getSerializedResult.mockResolvedValue(stored);
        const result = await runPdf();
        const timings = result.kind === 'ok' ? result.timings : undefined;
        expect(timings?.source).toBe('cache');
        expect(timings?.cacheLookupMs).toBeGreaterThanOrEqual(0);
        expect(timings).not.toHaveProperty('extractMs');
        expect(timings).not.toHaveProperty('workerState');
        expect(timings).not.toHaveProperty('clientQueueMs');
        expect(extractSerializedMock).not.toHaveBeenCalled();
    });

    it('reports a result produced by another request as shared', async () => {
        documentCacheMock.getOrCreateSerializedResult.mockResolvedValue(stored);
        const result = await runPdf();
        const timings = result.kind === 'ok' ? result.timings : undefined;
        expect(timings?.source).toBe('shared');
        expect(timings).not.toHaveProperty('extractMs');
        expect(timings).not.toHaveProperty('cacheWriteMs');
    });

    it('reports a worker that was still starting when the request first used it', async () => {
        getPageCountMock.mockImplementation(async (_data: unknown, _signal: unknown, timing?: WorkerCallTiming) => {
            if (timing) timing.workerState = 'starting';
            return 3;
        });
        leaderCache();
        const result = await runPdf();
        expect(result.kind === 'ok' ? result.timings?.workerState : undefined).toBe('starting');
    });
});
