/**
 * A worker lifecycle failure (the local PDF engine could not start / died and
 * could not be respawned) surfaces as a distinct, retryable `worker_unavailable`
 * code — never the generic `extraction_failed` bucket — with a clean,
 * non-leaky message. Heap exhaustion (an ExtractionError) must still map to
 * `pdf_too_complex`, so the transient branch sits after the ExtractionError
 * handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the (hoisted) vi.mock factory AND the test bodies share the exact
// same class objects — `instanceof` in the module under test relies on identity.
const {
    MockStaleWorkerError,
    MockExtractionError,
    EXTRACTION_ERROR_CODES,
    extractMock,
    getPageCountMock,
} = vi.hoisted(() => {
    class MockStaleWorkerError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'StaleWorkerError';
        }
    }
    class MockExtractionError extends Error {}
    const EXTRACTION_ERROR_CODES = {
        ENCRYPTED: 'encrypted',
        NO_TEXT_LAYER: 'no_text_layer',
        INVALID_PDF: 'invalid_pdf',
        EMPTY_DOCUMENT: 'empty_document',
        PAGE_OUT_OF_RANGE: 'page_out_of_range',
        WASM_ERROR: 'wasm_error',
        HEAP_EXHAUSTION: 'heap_exhaustion',
    };
    return {
        MockStaleWorkerError,
        MockExtractionError,
        EXTRACTION_ERROR_CODES,
        extractMock: vi.fn(),
        getPageCountMock: vi.fn(),
    };
});

vi.mock('../../../src/beaver-extract', () => ({
    StaleWorkerError: MockStaleWorkerError,
    WorkerSpawnError: class MockWorkerSpawnError extends Error {},
    ExtractionError: MockExtractionError,
    WorkerAbortError: class MockWorkerAbortError extends Error {},
    ExtractionErrorCode: EXTRACTION_ERROR_CODES,
    // Faithful to the real predicate for the classes under test.
    isTransientWorkerError: (error: unknown) => {
        const name = (error as { name?: unknown } | null | undefined)?.name;
        return name === 'StaleWorkerError' || name === 'WorkerSpawnError';
    },
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

import { extractAndCacheResolvedPdfDocument } from '../../../src/services/documentExtractionCore';

describe('extractAndCacheResolvedPdfDocument worker-lifecycle classification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPageCountMock.mockResolvedValue(3);
        // No document cache -> the unshared path calls the worker directly. The
        // `Beaver` key must be ABSENT (not just undefined) so `"Beaver" in Zotero`
        // in isDevelopment() short-circuits instead of dereferencing undefined.
        (globalThis as any).Zotero = { ...(globalThis as any).Zotero };
        delete (globalThis as any).Zotero.Beaver;
        (globalThis as any).IOUtils = {
            ...(globalThis as any).IOUtils,
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
        };
    });

    // Note: no vi.restoreAllMocks() here — it would wipe the factory vi.fn
    // implementations (e.g. getMuPDFWorkerClient), so the next test's client
    // would be undefined. beforeEach's clearAllMocks resets call history only.

    const runExternalPdf = () =>
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
        });

    it('maps a StaleWorkerError to worker_unavailable, not extraction_failed', async () => {
        extractMock.mockRejectedValue(
            new MockStaleWorkerError('stale worker: worker.onerror: worker onerror'),
        );

        const result = await runExternalPdf();

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'worker_unavailable',
            pageCount: 3,
        });
        // The internal StaleWorkerError text must not leak to the model.
        expect((result as { message: string }).message).not.toContain('StaleWorkerError');
        expect((result as { message: string }).message).not.toContain('worker.onerror');
    });

    it('still maps heap exhaustion to pdf_too_complex (not worker_unavailable)', async () => {
        // A non-transient ExtractionError must keep its document-verdict mapping.
        const heap = Object.assign(new MockExtractionError(), {
            name: 'ExtractionError',
            code: EXTRACTION_ERROR_CODES.HEAP_EXHAUSTION,
        });
        extractMock.mockRejectedValue(heap);

        const result = await runExternalPdf();

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'pdf_too_complex',
        });
    });

    it('maps a cross-bundle heap exhaustion (not instanceof) to pdf_too_complex', async () => {
        // Simulate an ExtractionError rehydrated in the *other* bundle: same
        // structural shape, but not an instanceof this bundle's class. It must
        // still be classified as a document verdict, never worker_unavailable.
        const heap = Object.assign(new Error('heap'), {
            name: 'ExtractionError',
            code: EXTRACTION_ERROR_CODES.HEAP_EXHAUSTION,
        });
        extractMock.mockRejectedValue(heap);

        const result = await runExternalPdf();

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'pdf_too_complex',
        });
    });

    it('maps a cross-bundle StaleWorkerError (not instanceof) to worker_unavailable', async () => {
        // A lifecycle error from the other bundle is matched by its name.
        const stale = Object.assign(new Error('stale worker: worker.onerror: worker onerror'), {
            name: 'StaleWorkerError',
        });
        extractMock.mockRejectedValue(stale);

        const result = await runExternalPdf();

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'worker_unavailable',
        });
    });
});
