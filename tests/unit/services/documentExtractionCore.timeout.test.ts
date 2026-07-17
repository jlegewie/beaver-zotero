import { afterEach, describe, expect, it, vi } from 'vitest';

const workerClientMocks = vi.hoisted(() => ({
    getPageCount: vi.fn(),
    extract: vi.fn(),
}));

vi.mock('../../../src/beaver-extract', () => ({
    ExtractionError: class MockExtractionError extends Error {},
    StaleWorkerError: class MockStaleWorkerError extends Error {},
    WorkerAbortError: class MockWorkerAbortError extends Error {},
    WorkerDeadlineError: class MockWorkerDeadlineError extends Error {
        constructor(message = 'worker busy-age lease exceeded') {
            super(message);
            this.name = 'WorkerDeadlineError';
        }
    },
    WorkerSpawnError: class MockWorkerSpawnError extends Error {},
    isWorkerDeadlineError: (error: unknown) =>
        (error as { name?: unknown } | null | undefined)?.name === 'WorkerDeadlineError',
    ExtractionErrorCode: {
        ENCRYPTED: 'encrypted',
        NO_TEXT_LAYER: 'no_text_layer',
        INVALID_PDF: 'invalid_pdf',
        EMPTY_DOCUMENT: 'empty_document',
        PAGE_OUT_OF_RANGE: 'page_out_of_range',
        WASM_ERROR: 'wasm_error',
        HEAP_EXHAUSTION: 'heap_exhaustion',
    },
    getMuPDFWorkerClient: vi.fn(() => workerClientMocks),
}));

vi.mock('../../../src/services/documentExtraction', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction')>(
        '../../../src/services/documentExtraction',
    );
    return {
        ...actual,
        validateZoteroItemReference: vi.fn(() => null),
        resolveToReadableAttachment: vi.fn(() => new Promise(() => {})),
    };
});

import { WorkerDeadlineError } from '../../../src/beaver-extract';
import {
    extractAndCacheDocument,
    extractAndCacheResolvedPdfDocument,
} from '../../../src/services/documentExtractionCore';

describe('extractAndCacheDocument timeout handling', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        vi.restoreAllMocks();
        // Mirrors the absence of Zotero.Beaver in the default test setup so
        // tests that rely on the unshared (no document cache) path are not
        // affected by a documentCache stub left behind by another test.
        delete (globalThis as any).Zotero.Beaver;
    });

    it('times out while resolving the Zotero item', async () => {
        vi.useFakeTimers();
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(() => new Promise(() => {})),
        };

        const pending = extractAndCacheDocument({
            libraryId: 1,
            zoteroKey: 'ABCD1234',
            mode: 'structured',
            maxPages: null,
            maxFileSizeMB: 0,
            timeoutSeconds: 0.01,
            workerName: 'background',
        });

        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toMatchObject({
            kind: 'timeout',
            phase: 'zotero_item_lookup',
            timeoutSeconds: 0.01,
            pageCount: null,
            resolvedAttachment: null,
        });
    });

    it('honors external abort while loading Zotero item data', async () => {
        vi.useFakeTimers();
        const external = new AbortController();
        const item = {
            loadAllData: vi.fn(() => new Promise(() => {})),
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(item),
        };

        const pending = extractAndCacheDocument({
            libraryId: 1,
            zoteroKey: 'ABCD1234',
            mode: 'structured',
            maxPages: null,
            maxFileSizeMB: 0,
            timeoutSeconds: 60,
            workerName: 'background',
            externalAbortSignal: external.signal,
        });

        await vi.advanceTimersByTimeAsync(0);
        external.abort();

        await expect(pending).resolves.toMatchObject({
            kind: 'external_abort',
            phase: 'zotero_item_load',
            pageCount: null,
            resolvedAttachment: null,
        });
    });

    it('maps a worker busy-age deadline to a timeout result', async () => {
        (globalThis as any).IOUtils.stat = vi.fn().mockResolvedValue({ size: 4 });
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        );
        workerClientMocks.getPageCount.mockRejectedValueOnce(
            new WorkerDeadlineError(),
        );

        const result = await extractAndCacheResolvedPdfDocument({
            source: {
                kind: 'external',
                filePath: '/tmp/deadline-test.pdf',
                itemRef: { id: 0, libraryID: -1, key: 'EXTTEST1' },
            },
            resolvedKey: 'external-EXTTEST1',
            contentType: 'application/pdf',
            mode: 'structured',
            maxPages: null,
            maxFileSizeMB: 10,
            timeoutSeconds: 40,
            workerName: 'hot',
        });

        expect(result).toMatchObject({
            kind: 'timeout',
            phase: 'unknown',
            timeoutSeconds: 40,
            pageCount: null,
            leaseReaped: true,
            workerDispatched: true,
            resolvedAttachment: {
                libraryId: -1,
                zoteroKey: 'EXTTEST1',
            },
        });
    });

    it('preserves worker dispatch metadata when an external deadline aborts a worker call', async () => {
        vi.useFakeTimers();
        const external = new AbortController();
        (globalThis as any).IOUtils.stat = vi.fn().mockResolvedValue({ size: 4 });
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        );
        workerClientMocks.getPageCount.mockImplementation(
            (_data: Uint8Array, signal: AbortSignal) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        );

        const pending = extractAndCacheResolvedPdfDocument({
            source: {
                kind: 'external',
                filePath: '/tmp/external-deadline-test.pdf',
                itemRef: { id: 0, libraryID: -1, key: 'EXTTEST4' },
            },
            resolvedKey: 'external-EXTTEST4',
            contentType: 'application/pdf',
            mode: 'structured',
            maxPages: null,
            maxFileSizeMB: 10,
            timeoutSeconds: 40,
            workerName: 'hot',
            externalAbortSignal: external.signal,
        });

        await vi.advanceTimersByTimeAsync(0);
        external.abort();

        await expect(pending).resolves.toMatchObject({
            kind: 'external_abort',
            workerDispatched: true,
            resolvedAttachment: {
                libraryId: -1,
                zoteroKey: 'EXTTEST4',
            },
        });
        expect(workerClientMocks.getPageCount).toHaveBeenCalled();
    });

    it('does not mark worker dispatch when the cache stalls before extraction', async () => {
        vi.useFakeTimers();
        (globalThis as any).IOUtils.stat = vi.fn().mockResolvedValue({ size: 4 });
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        );

        // Stalls in the cache's own pre-work (metadata/payload reads) without
        // ever invoking the supplied create callback, so the extraction never
        // reaches the worker.
        const getOrCreateResult = vi.fn(() => new Promise(() => {}));
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'production' },
            documentCache: {
                getSourceIdentitySnapshot: vi.fn().mockResolvedValue(null),
                getMetadata: vi.fn().mockResolvedValue({ pageCount: 3 }),
                getResult: vi.fn().mockResolvedValue(null),
                getSerializedResult: vi.fn().mockResolvedValue(null),
                getOrCreateResult,
                getOrCreateSerializedResult: vi.fn(),
            },
        };

        const pending = extractAndCacheResolvedPdfDocument({
            source: {
                kind: 'external',
                filePath: '/tmp/stalled-cache-test.pdf',
                itemRef: { id: 0, libraryID: -1, key: 'EXTTEST2' },
            },
            resolvedKey: 'external-EXTTEST2',
            contentType: 'application/pdf',
            mode: 'structured',
            maxPages: null,
            maxFileSizeMB: 10,
            timeoutSeconds: 1,
            workerName: 'hot',
        });

        await vi.advanceTimersByTimeAsync(1000);
        const result = await pending;

        expect(result).toMatchObject({
            kind: 'timeout',
            timeoutSeconds: 1,
            leaseReaped: false,
            resolvedAttachment: {
                libraryId: -1,
                zoteroKey: 'EXTTEST2',
            },
        });
        expect((result as { workerDispatched?: boolean }).workerDispatched).toBeFalsy();
        expect(getOrCreateResult).toHaveBeenCalled();
        expect(workerClientMocks.extract).not.toHaveBeenCalled();
        expect(workerClientMocks.getPageCount).not.toHaveBeenCalled();
    });

    it('marks worker dispatch when the shared extraction reached the worker', async () => {
        vi.useFakeTimers();
        (globalThis as any).IOUtils.stat = vi.fn().mockResolvedValue({ size: 4 });
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        );
        workerClientMocks.extract.mockImplementation(() => new Promise(() => {})); // worker call never resolves

        const getOrCreateResult = vi.fn((opts: any) => opts.create(new AbortController().signal));
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'production' },
            documentCache: {
                getSourceIdentitySnapshot: vi.fn().mockResolvedValue(null),
                getMetadata: vi.fn().mockResolvedValue({ pageCount: 3 }),
                getResult: vi.fn().mockResolvedValue(null),
                getSerializedResult: vi.fn().mockResolvedValue(null),
                getOrCreateResult,
                getOrCreateSerializedResult: vi.fn(),
            },
        };

        const pending = extractAndCacheResolvedPdfDocument({
            source: {
                kind: 'external',
                filePath: '/tmp/dispatched-worker-test.pdf',
                itemRef: { id: 0, libraryID: -1, key: 'EXTTEST3' },
            },
            resolvedKey: 'external-EXTTEST3',
            contentType: 'application/pdf',
            mode: 'structured',
            maxPages: null,
            maxFileSizeMB: 10,
            timeoutSeconds: 1,
            workerName: 'hot',
        });

        await vi.advanceTimersByTimeAsync(1000);

        await expect(pending).resolves.toMatchObject({
            kind: 'timeout',
            timeoutSeconds: 1,
            leaseReaped: false,
            workerDispatched: true,
            resolvedAttachment: {
                libraryId: -1,
                zoteroKey: 'EXTTEST3',
            },
        });
        expect(getOrCreateResult).toHaveBeenCalled();
        expect(workerClientMocks.extract).toHaveBeenCalled();
    });
});
