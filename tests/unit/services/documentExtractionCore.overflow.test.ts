/**
 * Interactive overflow through the extraction core: a whole request runs on
 * the worker chosen at its first op, interactive rules hold on the background
 * worker, and hot and overflow requests share one single-flight extraction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockClient = {
    slot: string;
    inFlight: number;
    queued: number;
    warm: boolean;
    isWarm: () => boolean;
    prewarm: ReturnType<typeof vi.fn>;
    getPageCount: ReturnType<typeof vi.fn>;
    extract: ReturnType<typeof vi.fn>;
    extractSerialized: ReturnType<typeof vi.fn>;
};

const workers = vi.hoisted(() => ({
    hot: null as unknown as MockClient,
    background: null as unknown as MockClient,
}));

vi.mock('../../../src/beaver-extract', () => ({
    StaleWorkerError: class MockStaleWorkerError extends Error {},
    WorkerSpawnError: class MockWorkerSpawnError extends Error {},
    ExtractionError: class MockExtractionError extends Error {},
    WorkerAbortError: class MockWorkerAbortError extends Error {
        constructor() {
            super('worker operation aborted by caller');
        }
    },
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
    getMuPDFWorkerClient: vi.fn((name: string = 'hot') => (name === 'background' ? workers.background : workers.hot)),
    getExistingMuPDFWorkerClient: vi.fn((name: string = 'hot') => (name === 'background' ? workers.background : workers.hot)),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

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
import { MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS } from '../../../src/services/agentDataProvider/timeout';
import { InteractiveOverflow } from '../../../src/services/backgroundQueue/interactiveOverflow';
import { MuPDFSerialLane } from '../../../src/services/backgroundQueue/muPDFSerialLane';

const extractedResult = (pageCount: number) => ({
    mode: 'structured',
    schemaVersion: '4',
    document: { pageCount, pages: [], citationIndex: {} },
});

function client(slot: string, warm: boolean): MockClient {
    const c: MockClient = {
        slot,
        inFlight: 0,
        queued: 0,
        warm,
        isWarm: () => c.warm,
        prewarm: vi.fn(() => Promise.resolve()),
        getPageCount: vi.fn(async () => 3),
        extract: vi.fn(async () => extractedResult(3)),
        extractSerialized: vi.fn(),
    };
    return c;
}

/**
 * Document-cache stand-in with single-flight keyed by document and
 * `lockScope`, like the real cache: the first caller's `create` runs, later
 * callers with the same key share its promise.
 */
function createDocumentCache() {
    const inFlight = new Map<string, Promise<unknown>>();
    return {
        getSourceIdentitySnapshot: vi.fn().mockResolvedValue({ sourceSizeBytes: 1000 }),
        getMetadata: vi.fn().mockResolvedValue(null),
        getResult: vi.fn().mockResolvedValue(null),
        getSerializedResult: vi.fn().mockResolvedValue(null),
        getUnwrittenResult: vi.fn().mockReturnValue(null),
        getOrCreateSerializedResult: vi.fn(),
        getOrCreateResult: vi.fn((input: {
            item: { key: string };
            lockScope?: string;
            abortSignal?: AbortSignal;
            create: (signal: AbortSignal) => Promise<unknown>;
        }) => {
            const key = `${input.item.key}/${input.lockScope}`;
            let shared = inFlight.get(key);
            if (!shared) {
                const controller = new AbortController();
                input.abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });
                shared = input.create(controller.signal).finally(() => inFlight.delete(key));
                inFlight.set(key, shared);
            }
            return shared;
        }),
    };
}

let documentCache: ReturnType<typeof createDocumentCache>;
let lane: MuPDFSerialLane;
let overflow: InteractiveOverflow;

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
        timeoutSeconds: 60,
        workerName: 'hot',
        ...overrides,
    });

/** A promise the test settles, for an op that must stay in flight. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('extractAndCacheResolvedPdfDocument interactive overflow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workers.hot = client('hot', true);
        workers.background = client('background', true);
        documentCache = createDocumentCache();
        lane = new MuPDFSerialLane();
        overflow = new InteractiveOverflow({
            lane,
            isAvailable: () => true,
            hasWorkerJobInFlight: () => false,
            onDrained: vi.fn(),
        });
        (globalThis as any).Zotero = { ...(globalThis as any).Zotero };
        (globalThis as any).Zotero.Prefs.get = vi.fn(() => undefined);
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'production' },
            documentCache,
            backgroundExtractor: { interactiveOverflow: overflow },
        };
        (globalThis as any).IOUtils = {
            ...(globalThis as any).IOUtils,
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
        };
    });

    it('runs on hot while the hot worker is idle', async () => {
        const result = await runPdf();

        expect(result).toMatchObject({ kind: 'ok', timings: { workerSlot: 'hot' } });
        expect(workers.hot.getPageCount).toHaveBeenCalledTimes(1);
        expect(workers.hot.extract).toHaveBeenCalledTimes(1);
        expect(workers.background.extract).not.toHaveBeenCalled();
        expect((result as { timings: object }).timings).not.toHaveProperty('overflowSkip');
    });

    it('runs the whole request on a warm background worker when hot is busy, with interactive rules', async () => {
        workers.hot.inFlight = 1;
        // Hot drains after the page count; the extraction still stays on background.
        workers.background.getPageCount.mockImplementation(async () => {
            workers.hot.inFlight = 0;
            expect(lane.isFree).toBe(false);
            return 3;
        });

        const result = await runPdf({ timeoutSeconds: 170 });

        expect(result).toMatchObject({ kind: 'ok', totalPages: 3, timings: { workerSlot: 'background' } });
        expect(workers.background.getPageCount).toHaveBeenCalledTimes(1);
        expect(workers.background.extract).toHaveBeenCalledTimes(1);
        expect(workers.hot.getPageCount).not.toHaveBeenCalled();
        expect(workers.hot.extract).not.toHaveBeenCalled();
        expect(documentCache.getOrCreateResult).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: 'hot',
            writeAfterResolve: true,
            sharedTimeoutMs: MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS * 1000 + HOT_SHARED_EXTRACTION_GRACE_MS,
        }));
        expect(lane.isFree).toBe(true);
        expect(overflow.getStats()).toMatchObject({ hotRoutes: 0, overflowRoutes: 0 });
    });

    it('queues on hot and records why when the background worker is cold', async () => {
        workers.hot.inFlight = 1;
        workers.background.warm = false;

        const result = await runPdf();

        expect(result).toMatchObject({ kind: 'ok', timings: { workerSlot: 'hot', overflowSkip: 'bg_not_warm' } });
        expect(workers.background.prewarm).toHaveBeenCalledTimes(1);
        expect(workers.background.extract).not.toHaveBeenCalled();
    });

    it('keeps everything on hot when the kill switch is off', async () => {
        (globalThis as any).Zotero.Prefs.get = vi.fn((pref: string) =>
            pref === 'extensions.zotero.beaver.pdf.backgroundOverflow' ? false : undefined);
        workers.hot.inFlight = 1;

        const result = await runPdf();

        expect(result).toMatchObject({ kind: 'ok', timings: { workerSlot: 'hot', overflowSkip: 'disabled' } });
        expect(workers.background.getPageCount).not.toHaveBeenCalled();
        expect(workers.background.prewarm).not.toHaveBeenCalled();
    });

    it('never routes background-queue requests', async () => {
        workers.hot.inFlight = 1;

        const result = await runPdf({ workerName: 'background' });

        expect(result).toMatchObject({ kind: 'ok', timings: { workerSlot: 'background' } });
        expect(overflow.getStats().decisions).toMatchObject({ hot_idle: 0, overflow: 0 });
        expect(lane.isFree).toBe(true);
        expect(documentCache.getOrCreateResult).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: 'background',
            writeAfterResolve: false,
        }));
    });

    it('shares one extraction between a hot request and an overflow request for the same document', async () => {
        const hotExtract = deferred<ReturnType<typeof extractedResult>>();
        workers.hot.extract.mockImplementation(() => hotExtract.promise);

        const first = runPdf();
        await vi.waitFor(() => expect(workers.hot.extract).toHaveBeenCalledTimes(1));
        // The first request is open on hot, so the second overflows for its
        // page count and then joins the running extraction.
        const second = runPdf();
        await vi.waitFor(() => expect(workers.background.getPageCount).toHaveBeenCalledTimes(1));
        hotExtract.resolve(extractedResult(3));

        const [a, b] = await Promise.all([first, second]);
        expect(a).toMatchObject({ kind: 'ok', timings: { source: 'extracted', workerSlot: 'hot' } });
        expect(b).toMatchObject({ kind: 'ok', timings: { source: 'shared', workerSlot: 'background' } });
        expect(workers.hot.extract).toHaveBeenCalledTimes(1);
        expect(workers.background.extract).not.toHaveBeenCalled();
        expect(lane.isFree).toBe(true);
    });

    it('times out an overflow request at its own deadline, aborts the op and releases the lane', async () => {
        workers.hot.inFlight = 1;
        let extractSignal: AbortSignal | undefined;
        workers.background.extract.mockImplementation((_bytes: unknown, _args: unknown, signal: AbortSignal) => {
            extractSignal = signal;
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(new Error('worker operation aborted by caller')), { once: true });
            });
        });

        const startedAt = Date.now();
        const result = await runPdf({ timeoutSeconds: 0.2 });

        expect(result).toMatchObject({ kind: 'timeout', workerDispatched: true, workerSlot: 'background' });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(extractSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(lane.isFree).toBe(true));
        expect(overflow.getStats().overflowRoutes).toBe(0);
    });
});
