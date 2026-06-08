import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/beaver-extract', () => ({
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
    getMuPDFWorkerClient: vi.fn(() => ({
        getPageCount: vi.fn(),
        extract: vi.fn(),
    })),
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

import { extractAndCacheDocument } from '../../../src/services/documentExtractionCore';

describe('extractAndCacheDocument timeout handling', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
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
});
