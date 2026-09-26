import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Speed up polling so queued/pending cases don't actually sleep.
vi.mock('../../../src/services/ocr/constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/services/ocr/constants')>();
    return {
        ...actual,
        OCR_POLL_INITIAL_MS: 1,
        OCR_POLL_MAX_MS: 1,
        OCR_TRACK_BUDGET_MS: 50,
    };
});

vi.mock('../../../src/services/ocr/ocrApiClient', () => ({
    ocrApiClient: {
        requestOcr: vi.fn(),
        markUploaded: vi.fn(),
        status: vi.fn(),
        reportOutcome: vi.fn(async () => ({ success: true })),
    },
}));

vi.mock('../../../src/services/ocr/gcsTransfer', () => ({
    putBytesToSignedUrl: vi.fn(async () => undefined),
    getBytesFromSignedUrl: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('../../../src/services/documentExtraction/ocrReextract', () => ({
    extractPdfBytesAndCacheAsOriginalAttachment: vi.fn(async () => ({ kind: 'ok', pageCount: 5 })),
}));

vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: vi.fn(async () => ({
        kind: 'ok',
        source: { kind: 'local', filePath: '/scan.pdf', isRemoteOnly: false },
    })),
    loadAttachmentData: vi.fn(async () => ({ kind: 'ok', data: new Uint8Array([4, 5, 6]) })),
    isRemoteAccessAvailable: vi.fn(() => true),
}));

vi.mock('../../../src/utils/zoteroItemUtils', () => ({
    safeIsInTrash: vi.fn(() => false),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const libraryScope = vi.hoisted(() => ({ initialized: true, searchableIds: [1] }));
import { DocumentExtractExecutor } from '../../../src/services/backgroundQueue/documentExtractExecutor';
import { OcrExecutor } from '../../../src/services/backgroundQueue/ocrExecutor';
import { ocrApiClient } from '../../../src/services/ocr/ocrApiClient';
import {
    getBytesFromSignedUrl,
    putBytesToSignedUrl,
} from '../../../src/services/ocr/gcsTransfer';
import { extractPdfBytesAndCacheAsOriginalAttachment } from '../../../src/services/documentExtraction/ocrReextract';
import {
    isRemoteAccessAvailable,
    loadAttachmentData,
    resolveAttachmentFileSource,
} from '../../../src/services/documentExtraction/attachmentSource';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_BACKFILL } from '../../../src/services/ocr/constants';
import { ApiError } from '@beaver/agent-core/types/apiErrors';
import type { JobExecutionContext } from '../../../src/services/backgroundQueue/jobExecutor';

const api = ocrApiClient as unknown as {
    requestOcr: ReturnType<typeof vi.fn>;
    markUploaded: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    reportOutcome: ReturnType<typeof vi.fn>;
};
const mockedReextract = vi.mocked(extractPdfBytesAndCacheAsOriginalAttachment);
const mockedResolveSource = vi.mocked(resolveAttachmentFileSource);
const mockedRemoteAccess = vi.mocked(isRemoteAccessAvailable);
const mockedLoad = vi.mocked(loadAttachmentData);
const mockedPut = vi.mocked(putBytesToSignedUrl);
const mockedGet = vi.mocked(getBytesFromSignedUrl);

const REMOTE_SOURCE = {
    kind: 'ok',
    source: { kind: 'remote', filePath: 'remote:AAAAAAAA', isRemoteOnly: true },
} as const;

function mockRemoteItem(syncedHash: string | undefined = 'synced999') {
    (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
        libraryID: 1,
        key: 'AAAAAAAA',
        id: 42,
        attachmentHash: undefined,
        attachmentSyncedHash: syncedHash,
        attachmentContentType: 'application/pdf',
    }));
    dbStub.getAttachmentProcessingState.mockResolvedValue({
        fileHash: syncedHash, extractStatus: 'done', ocrStatus: 'needed',
    });
}

const record = { id: 7, libraryId: 1, zoteroKey: 'AAAAAAAA' } as any;

let dbStub: any;
let fakePoller: { poll: ReturnType<typeof vi.fn> };

function makeCtx(overrides: Partial<JobExecutionContext> = {}): JobExecutionContext {
    const controller = new AbortController();
    return {
        db: dbStub,
        runOnMuPDFWorker: vi.fn(async (fn: () => Promise<any>) => fn()) as any,
        externalAbortSignal: controller.signal,
        shouldSkipDbWrites: () => false,
        enqueue: vi.fn(async () => undefined),
        ...overrides,
    } as JobExecutionContext;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedRemoteAccess.mockReturnValue(true);
    libraryScope.initialized = true;
    libraryScope.searchableIds.splice(0, libraryScope.searchableIds.length, 1);

    fakePoller = { poll: vi.fn() };

    dbStub = {
        isDocumentProcessingPermanentlyFailed: vi.fn(async () => false),
        getDocumentProcessingFailure: vi.fn(async () => null),
        clearDocumentProcessingFailure: vi.fn(async () => undefined),
        // Used by the slot-free track to wake a parked row for the finish phase.
        releaseBackgroundJob: vi.fn(async () => undefined),
        // Attachment-ledger surface consulted around re-extraction.
        ensureAttachmentProcessingState: vi.fn(async () => ({})),
        ensureAttachmentFileHash: vi.fn(async () => undefined),
        getAttachmentProcessingState: vi.fn(async () => ({ fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'needed' })),
        markAttachmentOcrDone: vi.fn(async () => true),
        markAttachmentOcrFailed: vi.fn(async () => undefined),
        markAttachmentOcrUnavailable: vi.fn(async () => true),
        clearAttachmentOcrUnavailable: vi.fn(async () => true),
        recordAttachmentReadingOutcome: vi.fn(async () => undefined),
    };

    (globalThis as any).Zotero.Items = {
        getByLibraryAndKeyAsync: vi.fn(async () => ({
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            attachmentHash: 'hash123',
            attachmentContentType: 'application/pdf',
        })),
    };

    // The background track reaches the queue + dispatcher through `Zotero.Beaver`
    // (the slot's ctx is gone once parked). ctx.db mirrors Zotero.Beaver.db.
    (globalThis as any).Zotero.Beaver = {
        hasOcrAccess: true,
        get libraryScopeInitialized() { return libraryScope.initialized; },
        get searchableLibraryIds() { return libraryScope.searchableIds; },
        documentCache: {
            getMetadata: vi.fn(async () => ({ pageCount: 5, errorCode: 'no_text_layer' })),
            getProtectedRepreparation: vi.fn(async () => null),
            getResult: vi.fn(async () => ({ pageCount: 5, pages: [] })),
        },
        db: dbStub,
        backgroundExtractor: { notify: vi.fn() },
    };
    (globalThis as any).Zotero.__beaverShuttingDown = false;

    (globalThis as any).IOUtils.read = vi.fn(async () => new Uint8Array([9, 9, 9]));

    mockedResolveSource.mockResolvedValue({
        kind: 'ok',
        source: { kind: 'local', filePath: '/scan.pdf', isRemoteOnly: false },
    } as any);
    mockedReextract.mockResolvedValue({ kind: 'ok', pageCount: 5 } as any);
    mockedLoad.mockResolvedValue({ kind: 'ok', data: new Uint8Array([4, 5, 6]) } as any);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('OcrExecutor', () => {
    let executor: OcrExecutor;

    beforeEach(() => {
        executor = new OcrExecutor(fakePoller as any);
    });

    it('does not request, upload, or resume OCR without effective access', async () => {
        Zotero.Beaver.hasOcrAccess = false;
        const outcome = await executor.execute(record, makeCtx());
        expect(outcome).toEqual({ kind: 'release', reason: 'aborted' });
        expect(api.requestOcr).not.toHaveBeenCalled();
        expect(api.markUploaded).not.toHaveBeenCalled();
        expect(api.status).not.toHaveBeenCalled();
    });

    it('exposes the document_ocr job type', () => {
        expect(executor.jobType).toBe('document_ocr');
    });

    const preparation = { ...record, priority: OCR_PRIORITY_BACKFILL, payload: {
        content_kind: 'pdf', maxPages: null, timeoutSeconds: 120, prepare_cache: true,
    } };

    it('stops queued preparation OCR after an earlier continuation fills the cache', async () => {
        let usedBytes = 0;
        (Zotero.Beaver!.documentCache as any).getStats = vi.fn(async () => ({
            payload_budget_bytes: 1000, payload_total_bytes: usedBytes,
        }));
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockImplementationOnce(async () => {
            usedBytes = 950;
            return { kind: 'ok', pageCount: 5 } as any;
        });
        expect(await executor.execute(preparation, makeCtx())).toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(await executor.execute({ ...preparation, id: 8, zoteroKey: 'BBBBBBBB' }, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'cache_budget_reached' });
        expect(api.requestOcr).toHaveBeenCalledOnce();
        expect(mockedGet).toHaveBeenCalledOnce();
        expect(mockedReextract).toHaveBeenCalledOnce();
        expect(dbStub.markAttachmentOcrFailed).not.toHaveBeenCalled();
    });

    it('rechecks space after the backend responds, before downloading OCR output', async () => {
        const getStats = vi.fn()
            .mockResolvedValueOnce({ payload_budget_bytes: 1000, payload_total_bytes: 0 })
            .mockResolvedValue({ payload_budget_bytes: 1000, payload_total_bytes: 950 });
        (Zotero.Beaver!.documentCache as any).getStats = getStats;
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        expect(await executor.execute(preparation, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'cache_budget_reached' });
        expect(mockedGet).not.toHaveBeenCalled();
        expect(mockedReextract).not.toHaveBeenCalled();
    });

    it('retires a parked preparation ticket when the cache fills before its next claim', async () => {
        let usedBytes = 0;
        (Zotero.Beaver!.documentCache as any).getStats = vi.fn(async () => ({
            payload_budget_bytes: 1000, payload_total_bytes: usedBytes,
        }));
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'preparation-job' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });
        expect(await executor.execute(preparation, makeCtx())).toEqual({ kind: 'defer', reason: 'ocr_polling' });
        await executor.drainTracks();
        usedBytes = 950;
        expect(await executor.execute(preparation, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'cache_budget_reached' });
        expect(api.requestOcr).toHaveBeenCalledOnce();
        expect(mockedGet).not.toHaveBeenCalled();
        expect(mockedReextract).not.toHaveBeenCalled();
    });

    it('rechecks space when the serialized worker becomes available', async () => {
        let usedBytes = 0;
        (Zotero.Beaver!.documentCache as any).getStats = vi.fn(async () => ({
            payload_budget_bytes: 1000, payload_total_bytes: usedBytes,
        }));
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const ctx = makeCtx({ runOnMuPDFWorker: async (fn) => { usedBytes = 950; return fn(); } });
        expect(await executor.execute(preparation, ctx))
            .toEqual({ kind: 'complete', reason: 'cache_budget_reached' });
        expect(mockedGet).toHaveBeenCalledOnce();
        expect(mockedReextract).not.toHaveBeenCalled();
        expect(dbStub.markAttachmentOcrDone).not.toHaveBeenCalled();
    });

    it('allows a preparation ticket promoted to on-demand OCR to run with a full cache', async () => {
        (Zotero.Beaver!.documentCache as any).getStats = vi.fn(async () => ({
            payload_budget_bytes: 1000, payload_total_bytes: 1000,
        }));
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        expect(await executor.execute({ ...preparation, priority: 90 }, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(mockedReextract).toHaveBeenCalledOnce();
    });

    it('downloads, re-extracts, and completes on a cache hit (ready)', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5, 'backfill');
        expect(mockedGet).toHaveBeenCalledWith('https://gcs/get', expect.anything());
        expect(mockedPut).not.toHaveBeenCalled();
        expect(ctx.runOnMuPDFWorker).toHaveBeenCalledOnce();
        expect(dbStub.clearDocumentProcessingFailure).toHaveBeenCalledWith('hash123', 'ocr', OCR_ENGINE_VERSION);
        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('uploads, confirms, defers (slot-free), then finishes on re-claim (pending)', async () => {
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-1', put_url: 'https://gcs/put' });
        api.markUploaded.mockResolvedValue({ status: 'queued', job_id: 'job-1' });
        // The slot-free track observes completion and wakes the parked row.
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });

        // First claim: upload + confirm, then park without holding the slot.
        const first = await executor.execute(record, makeCtx());

        expect(mockedPut).toHaveBeenCalledWith('https://gcs/put', expect.any(Uint8Array), expect.anything());
        expect(api.markUploaded).toHaveBeenCalledWith('job-1');
        expect(fakePoller.poll).toHaveBeenCalledWith('job-1', expect.objectContaining({ deadline: expect.any(Number) }));
        expect(first).toEqual({ kind: 'defer', reason: 'ocr_polling' });
        // Download and re-extraction wait until the row is re-claimed.
        expect(mockedGet).not.toHaveBeenCalled();
        expect(mockedReextract).not.toHaveBeenCalled();

        // The track wakes the parked queue row for the finish phase.
        await executor.drainTracks();
        expect(dbStub.releaseBackgroundJob).toHaveBeenCalledWith(7, expect.any(Number));
        expect((globalThis as any).Zotero.Beaver.backgroundExtractor.notify).toHaveBeenCalled();

        // Re-claim: status confirms completion, then download + re-extract.
        api.status.mockResolvedValue({ status: 'completed', get_url: 'https://gcs/get' });
        const second = await executor.execute(record, makeCtx());

        expect(api.status).toHaveBeenCalledWith('job-1');
        expect(mockedGet).toHaveBeenCalledWith('https://gcs/get', expect.anything());
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('defers an already-queued job, then finishes on re-claim', async () => {
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-2' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });

        const first = await executor.execute(record, makeCtx());

        expect(mockedPut).not.toHaveBeenCalled();
        expect(fakePoller.poll).toHaveBeenCalledTimes(1);
        expect(fakePoller.poll).toHaveBeenCalledWith('job-2', expect.objectContaining({ deadline: expect.any(Number) }));
        expect(first).toEqual({ kind: 'defer', reason: 'ocr_polling' });

        await executor.drainTracks();
        expect(dbStub.releaseBackgroundJob).toHaveBeenCalledWith(7, expect.any(Number));

        api.status.mockResolvedValue({ status: 'completed', get_url: 'https://gcs/get' });
        const second = await executor.execute(record, makeCtx());
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('records a recoverable unavailable state when the backend reports disabled', async () => {
        api.requestOcr
            .mockResolvedValueOnce({ status: 'disabled' })
            .mockResolvedValueOnce({ status: 'ready', get_url: 'https://gcs/get' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(mockedPut).not.toHaveBeenCalled();
        expect(ctx.runOnMuPDFWorker).not.toHaveBeenCalled();
        expect(dbStub.markAttachmentOcrUnavailable).toHaveBeenCalledWith(
            1, 'AAAAAAAA', 'hash123', 'ocr_service_unavailable',
        );
        expect(dbStub.markAttachmentOcrFailed).not.toHaveBeenCalled();
        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_disabled' });

        await expect(executor.execute(record, makeCtx())).resolves.toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(dbStub.clearAttachmentOcrUnavailable).toHaveBeenCalledWith(1, 'AAAAAAAA', 'hash123');
        expect(dbStub.markAttachmentOcrUnavailable).toHaveBeenCalledOnce();
    });

    it('recovers legacy detection metadata through native extraction before requesting OCR', async () => {
        const metadata = Zotero.Beaver.documentCache!.getMetadata as ReturnType<typeof vi.fn>;
        metadata.mockResolvedValueOnce(null);
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute').mockResolvedValueOnce({ kind: 'complete', reason: 'needs_ocr' });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'needed',
        });
        api.requestOcr.mockResolvedValue({ status: 'disabled' });
        await executor.execute(record, makeCtx());
        expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'document_extract', payload: expect.objectContaining({ content_kind: 'pdf' }) }), expect.anything());
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5, 'backfill');
        recovery.mockRestore();
    });

    it('does not upload when metadata recovery finds valid native text', async () => {
        (Zotero.Beaver.documentCache!.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute').mockResolvedValueOnce({ kind: 'complete', reason: 'ok' });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'na',
        });
        expect(await executor.execute(record, makeCtx())).toEqual({ kind: 'complete', reason: 'ok' });
        expect(api.requestOcr).not.toHaveBeenCalled();
        recovery.mockRestore();
    });

    it('retires an OCR ticket after the replacement is indexed with native text', async () => {
        (Zotero.Beaver.documentCache!.getMetadata as ReturnType<typeof vi.fn>)
            .mockResolvedValue({ pageCount: 1, errorCode: null });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'na',
        });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute');

        expect(await executor.execute(record, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'ocr_not_needed' });
        expect(recovery).not.toHaveBeenCalled();
        expect(api.requestOcr).not.toHaveBeenCalled();
        expect(dbStub.markAttachmentOcrFailed).not.toHaveBeenCalled();
        recovery.mockRestore();
    });

    it('detects a native replacement before reconciliation despite its cached page count', async () => {
        (Zotero.Beaver.documentCache!.getMetadata as ReturnType<typeof vi.fn>)
            .mockResolvedValue({ pageCount: 1, errorCode: null });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'old-scan-hash', extractStatus: 'done', ocrStatus: 'needed',
        });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute')
            .mockResolvedValueOnce({ kind: 'complete', reason: 'ok' });

        expect(await executor.execute(record, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'ok' });
        expect(recovery).toHaveBeenCalledOnce();
        expect(api.requestOcr).not.toHaveBeenCalled();
        expect(dbStub.markAttachmentOcrFailed).not.toHaveBeenCalled();
        recovery.mockRestore();
    });

    it('continues OCR after a scanned replacement is detected', async () => {
        (Zotero.Beaver.documentCache!.getMetadata as ReturnType<typeof vi.fn>)
            .mockResolvedValue({ pageCount: 3, errorCode: 'no_text_layer' });
        dbStub.getAttachmentProcessingState
            .mockResolvedValueOnce({ fileHash: 'old-scan-hash', extractStatus: 'done', ocrStatus: 'needed' })
            .mockResolvedValue({ fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'needed' });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute')
            .mockResolvedValueOnce({ kind: 'complete', reason: 'needs_ocr' });
        api.requestOcr.mockResolvedValue({ status: 'disabled' });

        expect(await executor.execute(record, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'ocr_disabled' });
        expect(recovery).toHaveBeenCalledOnce();
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 3, 'backfill');
        recovery.mockRestore();
    });

    it('allows cache preparation to restore a processed scan', async () => {
        (Zotero.Beaver!.documentCache as any).getStats = vi.fn(async () => ({
            payload_budget_bytes: 1000, payload_total_bytes: 0,
        }));
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'done',
        });
        api.requestOcr.mockResolvedValue({ status: 'disabled' });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute');

        expect(await executor.execute(preparation, makeCtx()))
            .toEqual({ kind: 'complete', reason: 'ocr_disabled' });
        expect(recovery).not.toHaveBeenCalled();
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5, 'backfill');
        recovery.mockRestore();
    });

    it('prepares a processed scan again from its OCR artifact after an extraction-schema update', async () => {
        const cache = Zotero.Beaver.documentCache as any;
        // Retained metadata of the older schema is not served, but it still
        // identifies this source as a prepared scan.
        cache.getMetadata.mockResolvedValue(null);
        cache.getProtectedRepreparation.mockResolvedValue({ pageCount: 5, sourceSizeBytes: 0 });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'done', ocrEngineVersion: OCR_ENGINE_VERSION,
        });
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute');

        expect(await executor.execute(record, makeCtx())).toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(recovery).not.toHaveBeenCalled();
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5, 'backfill');
        expect(mockedPut).not.toHaveBeenCalled();
        expect(mockedReextract).toHaveBeenCalledWith(expect.objectContaining({ expectedPageCount: 5 }));
        expect(dbStub.markAttachmentOcrDone).toHaveBeenCalledWith(expect.objectContaining({
            expectedOcrStatus: 'done', expectedExtractStatus: 'done',
        }));
        expect(dbStub.markAttachmentOcrFailed).not.toHaveBeenCalled();
        recovery.mockRestore();
    });

    it('prepares a processed scan again after a payload-format update without re-detecting it', async () => {
        const cache = Zotero.Beaver.documentCache as any;
        // Current metadata written by the OCR preparation carries no error verdict.
        cache.getMetadata.mockResolvedValue({ pageCount: 5, errorCode: null });
        cache.getProtectedRepreparation.mockResolvedValue({ pageCount: 5, sourceSizeBytes: 0 });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'done',
        });
        api.requestOcr.mockResolvedValue({ status: 'disabled' });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute');

        expect(await executor.execute(record, makeCtx())).toEqual({ kind: 'complete', reason: 'ocr_disabled' });
        expect(recovery).not.toHaveBeenCalled();
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5, 'backfill');
        recovery.mockRestore();
    });

    it('continues OCR when recovery detection finds a scan whose preparation is retained', async () => {
        const cache = Zotero.Beaver.documentCache as any;
        cache.getMetadata.mockResolvedValue(null);
        // Detection cannot overwrite retained preparation metadata, so the
        // evidence only becomes visible alongside the refreshed ledger.
        cache.getProtectedRepreparation
            .mockResolvedValueOnce(null)
            .mockResolvedValue({ pageCount: 3, sourceSizeBytes: 0 });
        dbStub.getAttachmentProcessingState
            .mockResolvedValueOnce({ fileHash: 'hash123', extractStatus: null, ocrStatus: null })
            .mockResolvedValue({ fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'needed' });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute')
            .mockResolvedValueOnce({ kind: 'complete', reason: 'needs_ocr' });
        api.requestOcr.mockResolvedValue({ status: 'disabled' });

        expect(await executor.execute(record, makeCtx())).toEqual({ kind: 'complete', reason: 'ocr_disabled' });
        expect(recovery).toHaveBeenCalledOnce();
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 3, 'backfill');
        recovery.mockRestore();
    });

    it('does not prepare a processed scan again while its preparation is still servable', async () => {
        (Zotero.Beaver.documentCache as any).getMetadata.mockResolvedValue({ pageCount: 5, errorCode: null });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'done',
        });
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute')
            .mockResolvedValueOnce({ kind: 'complete', reason: 'ok' });

        expect(await executor.execute(record, makeCtx())).toEqual({ kind: 'complete', reason: 'ok' });
        expect(api.requestOcr).not.toHaveBeenCalled();
        recovery.mockRestore();
    });

    it('settles failed metadata recovery visibly without requesting cloud work', async () => {
        (Zotero.Beaver.documentCache!.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const recovery = vi.spyOn(DocumentExtractExecutor.prototype, 'execute').mockResolvedValueOnce({ kind: 'complete', reason: 'needs_ocr' });
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hash123', extractStatus: 'done', ocrStatus: 'needed',
        });
        expect(await executor.execute(record, makeCtx())).toMatchObject({ reason: 'ocr_metadata_unavailable' });
        expect(dbStub.markAttachmentOcrFailed).toHaveBeenCalledWith(1, 'AAAAAAAA', 'hash123', expect.stringContaining('ocr_metadata_unavailable'));
        expect(api.requestOcr).not.toHaveBeenCalled();
        recovery.mockRestore();
    });

    it('persists a terminal page-cap rejection instead of leaving progress pending', async () => {
        api.requestOcr.mockResolvedValue({ status: 'rejected', reason: 'page_cap', limit: 100, page_count: 250 });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('failPermanent');
        expect((outcome as any).reason).toBe('terminal:ocr_page_cap');
        expect(dbStub.markAttachmentOcrFailed).toHaveBeenCalledWith(1, 'AAAAAAAA', expect.any(String), expect.stringContaining('OCR limit 100'));
    });

    it('records a terminal failure on a permanent backend error', async () => {
        api.requestOcr.mockResolvedValue({
            status: 'failed',
            error: { code: 'encrypted_pdf', message: 'nope', kind: 'permanent' },
        });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('failPermanent');
        if (outcome.kind === 'failPermanent') {
            expect(outcome.failure.task).toBe('ocr');
            expect(outcome.failure.fileHash).toBe('hash123');
            expect(outcome.failure.terminalCode).toBe('ocr_failed_permanent');
            expect(outcome.failure.engineVersion).toBe(OCR_ENGINE_VERSION);
        }
        // Backend-permanent failures are already logged backend-side; don't re-report.
        expect(api.reportOutcome).not.toHaveBeenCalled();
    });

    it('retries on a transient backend error', async () => {
        api.requestOcr.mockResolvedValue({
            status: 'failed',
            error: { code: 'oom', message: 'crashed', kind: 'transient' },
        });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('retry');
    });

    it('retries a changed source without publishing success for its old artifact', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockResolvedValue({ kind: 'source_changed' });
        expect(await executor.execute(record, makeCtx()))
            .toMatchObject({ kind: 'retry', reason: 'source_changed' });
        expect(mockedReextract).toHaveBeenCalledWith(expect.objectContaining({ expectedFileHash: 'hash123' }));
        expect(dbStub.markAttachmentOcrDone).not.toHaveBeenCalled();
        expect(api.reportOutcome).not.toHaveBeenCalled();
    });

    it('rechecks source content after extraction and before marking local publication', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const item = await Zotero.Items.getByLibraryAndKeyAsync(1, 'AAAAAAAA');
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(item);
        mockedReextract.mockImplementationOnce(async () => {
            Object.defineProperty(item, 'attachmentHash', { value: 'replacement-hash' });
            return { kind: 'ok', pageCount: 5 };
        });
        expect(await executor.execute(record, makeCtx()))
            .toMatchObject({ kind: 'retry', reason: 'source_changed' });
        expect(dbStub.markAttachmentOcrDone).not.toHaveBeenCalled();
        expect(api.reportOutcome).not.toHaveBeenCalled();
    });

    it('reports local publication only after the ledger accepts the validated cache', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        await executor.execute(record, makeCtx());
        expect(api.reportOutcome).toHaveBeenCalledWith(expect.objectContaining({
            outcome_code: 'ocr_extracted', source_ref: '1-AAAAAAAA',
            download_ms: expect.any(Number), publication_ms: expect.any(Number),
            quality_result: 'text_and_geometry_passed',
        }));
        expect(dbStub.markAttachmentOcrDone).toHaveBeenCalledWith(expect.objectContaining({ attemptedAt: expect.any(Number) }));
        api.reportOutcome.mockClear();
        dbStub.markAttachmentOcrDone.mockResolvedValue(false);
        expect(await executor.execute(record, makeCtx())).toMatchObject({ reason: 'stale_completion_ignored' });
        expect(api.reportOutcome).not.toHaveBeenCalled();
    });

    it('records the OCR_NO_TEXT loop-guard terminal when re-extraction finds no text', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockResolvedValue({ kind: 'no_text' } as any);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('failPermanent');
        if (outcome.kind === 'failPermanent') {
            expect(outcome.failure.terminalCode).toBe('ocr_no_text');
            expect(dbStub.markAttachmentOcrFailed).toHaveBeenCalledWith(1, 'AAAAAAAA', 'hash123', 'ocr_no_text: OCR produced no usable text layer');
            expect(outcome.failure.task).toBe('ocr');
        }
        // Client-detected terminal is reported to the backend for observability.
        expect(api.reportOutcome).toHaveBeenCalledWith(expect.objectContaining({
            file_hash: 'hash123',
            outcome_code: 'ocr_no_text',
            engine_version: OCR_ENGINE_VERSION,
            page_count: 5,
            detail: undefined,
        }));
    });

    it('records a terminal failure on a geometry mismatch', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockResolvedValue({ kind: 'geometry_mismatch', detail: 'page 0 width' } as any);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('failPermanent');
        if (outcome.kind === 'failPermanent') {
            expect(outcome.failure.terminalCode).toBe('ocr_geometry_mismatch');
        }
        // The geometry detail rides along (truncated) for observability.
        expect(api.reportOutcome).toHaveBeenCalledWith(expect.objectContaining({
            file_hash: 'hash123',
            outcome_code: 'ocr_geometry_mismatch',
            engine_version: OCR_ENGINE_VERSION,
            page_count: 5,
            detail: 'page 0 width',
        }));
    });

    it('still returns the terminal outcome when the outcome report fails (fire-and-forget)', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockResolvedValue({ kind: 'geometry_mismatch', detail: 'page 0 width' } as any);
        api.reportOutcome.mockRejectedValue(new Error('network down'));
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('failPermanent');
        if (outcome.kind === 'failPermanent') {
            expect(outcome.failure.terminalCode).toBe('ocr_geometry_mismatch');
        }
    });

    it('retries when re-extraction fails transiently', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockResolvedValue({ kind: 'error', message: 'worker crash' } as any);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('retry');
    });

    it('short-circuits a terminal scan via the loop guard', async () => {
        dbStub.isDocumentProcessingPermanentlyFailed.mockResolvedValue(true);
        dbStub.getDocumentProcessingFailure.mockResolvedValue({
            terminalCode: 'ocr_page_cap',
            lastError: 'ocr_page_cap: 501 pages exceeds OCR limit 500',
            failureCount: 1,
        });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(api.requestOcr).not.toHaveBeenCalled();
        expect(dbStub.markAttachmentOcrFailed).toHaveBeenCalledWith(
            1, 'AAAAAAAA', 'hash123', 'ocr_page_cap: 501 pages exceeds OCR limit 500',
        );
        expect(dbStub.clearDocumentProcessingFailure).not.toHaveBeenCalled();
        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_perm_failed' });
    });

    it('completes when the attachment is missing', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => null);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome).toEqual({ kind: 'complete', reason: 'item_missing' });
    });

    it('discards a queued OCR job when its library is no longer searchable', async () => {
        libraryScope.searchableIds.splice(0, libraryScope.searchableIds.length);

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'library_excluded' });
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(mockedResolveSource).not.toHaveBeenCalled();
        expect(api.requestOcr).not.toHaveBeenCalled();
    });

    it('releases a queued OCR job while the library scope is uninitialized', async () => {
        libraryScope.initialized = false;

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'release', reason: 'library_scope_uninitialized' });
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(api.requestOcr).not.toHaveBeenCalled();
    });

    it('completes file_not_local when the scan is not retrievable', async () => {
        mockedResolveSource.mockResolvedValue({ kind: 'error', code: 'file_missing' } as any);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        // Recoverable skip (no permanent-failure row), re-enqueued once local.
        expect(outcome).toEqual({ kind: 'complete', reason: 'file_not_local' });
    });

    it('completes file_not_local_remote when on server but remote access is disabled', async () => {
        mockedResolveSource.mockResolvedValue({ kind: 'error', code: 'file_missing', remoteAvailable: true } as any);

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'file_not_local_remote' });
    });

    it('completes file_too_large when the resolver rejects on size', async () => {
        mockedResolveSource.mockResolvedValue({ kind: 'error', code: 'file_too_large' } as any);

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'file_too_large' });
    });

    it('downloads a remote-only scan in-memory, uploads it, and caches size-keyed', async () => {
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });
        api.markUploaded.mockResolvedValue({ status: 'queued', job_id: 'job-rem' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });

        // First claim: backend dedup uses the synced hash; bytes come from the
        // in-memory download, not the (absent) local file.
        const first = await executor.execute(record, makeCtx());
        expect(first).toEqual({ kind: 'defer', reason: 'ocr_polling' });
        expect(api.requestOcr).toHaveBeenCalledWith('synced999', 5, 'backfill');
        expect(mockedLoad).toHaveBeenCalledOnce();
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(mockedPut).toHaveBeenCalledWith('https://gcs/put', expect.any(Uint8Array), expect.anything());

        await executor.drainTracks();

        // Re-claim: finish + cache the OCR result keyed by the original byte length.
        api.status.mockResolvedValue({ status: 'completed', get_url: 'https://gcs/get' });
        const second = await executor.execute(record, makeCtx());
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(mockedReextract).toHaveBeenCalledWith(
            expect.objectContaining({ isRemoteOnly: true, sourceSizeBytes: 12345 }),
        );
    });

    it('runs the full remote round trip for a backfill-priority job', async () => {
        // `accessRemoteFiles` is the only download permission, and priority does
        // not narrow it: a backfill ticket for a server-only scan gets the same
        // treatment as an on-demand one.
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-bf', put_url: 'https://gcs/put' });
        api.markUploaded.mockResolvedValue({ status: 'queued', job_id: 'job-bf' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });
        const backfillRecord = { ...record, priority: OCR_PRIORITY_BACKFILL };

        const outcome = await executor.execute(backfillRecord, makeCtx());

        expect(outcome).toEqual({ kind: 'defer', reason: 'ocr_polling' });
        expect(api.requestOcr).toHaveBeenCalledWith('synced999', 5, 'backfill');
        expect(mockedLoad).toHaveBeenCalledOnce();
    });

    it('releases without downloading when remote access is withdrawn mid-job', async () => {
        // The bytes load lazily, only once `/ocr/request` has asked for an
        // upload, so the permission can change across that round trip. The
        // download must not go ahead on the strength of the earlier resolve.
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        api.requestOcr.mockImplementation(async () => {
            mockedRemoteAccess.mockReturnValue(false);
            return { status: 'pending', job_id: 'job-rev', put_url: 'https://gcs/put' };
        });

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'release', reason: 'aborted' });
        expect(mockedLoad).not.toHaveBeenCalled();
        expect(mockedPut).not.toHaveBeenCalled();
    });

    it('completes no_file_hash when a remote scan has no synced hash', async () => {
        mockRemoteItem('');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'no_file_hash' });
        expect(api.requestOcr).not.toHaveBeenCalled();
    });

    it('retries when the remote scan download fails on the upload path', async () => {
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        mockedLoad.mockResolvedValue({ kind: 'error', code: 'download_failed' } as any);
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome.kind).toBe('retry');
        expect((outcome as any).reason).toBe('ocr_remote_download_failed');
        expect(mockedPut).not.toHaveBeenCalled();
    });

    it('retires a permanently-unavailable scan instead of burning the retry budget', async () => {
        // A 404 on the OCR original: retrying costs three attempts on the
        // largest files Beaver downloads, and the answer will not change.
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        mockedLoad.mockResolvedValue({ kind: 'error', code: 'download_failed', permanent: true } as any);
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome).toEqual({ kind: 'complete', reason: 'terminal:download_failed' });
        expect(mockedPut).not.toHaveBeenCalled();
    });

    it('stamps the OCR ledger when retiring a permanently-unavailable scan', async () => {
        // Without the stamp the row stays `ocr_status='needed'` and the
        // reconciler re-enqueues it on every pass — a worse outcome than the
        // retries this replaces.
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        mockedLoad.mockResolvedValue({ kind: 'error', code: 'download_failed', permanent: true } as any);
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });
        const ctx = makeCtx();
        ctx.db.getAttachmentProcessingState = vi.fn(async () => ({
            fileHash: 'synced999', extractStatus: 'done', ocrStatus: 'needed',
        })) as any;
        ctx.db.markAttachmentOcrFailed = vi.fn(async () => undefined) as any;

        await executor.execute(record, ctx);

        expect(ctx.db.markAttachmentOcrFailed).toHaveBeenCalledWith(
            record.libraryId,
            record.zoteroKey,
            'synced999',
            expect.stringContaining('download_failed'),
        );
    });

    it('completes file_too_large when the remote download exceeds the cap', async () => {
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345, errorCode: 'no_text_layer' }));
        mockedLoad.mockResolvedValue({ kind: 'error', code: 'file_too_large' } as any);
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'file_too_large' });
    });

    it('passes local identity (isRemoteOnly false, sourceSizeBytes 0) to the cache write', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(mockedReextract).toHaveBeenCalledWith(
            expect.objectContaining({ isRemoteOnly: false, sourceSizeBytes: 0 }),
        );
    });

    it('releases (not fails) when the lane is aborted mid-flight', async () => {
        const controller = new AbortController();
        api.requestOcr.mockImplementation(async () => {
            controller.abort();
            return { status: 'queued', job_id: 'job-3' };
        });
        const ctx = makeCtx({ externalAbortSignal: controller.signal });

        const outcome = await executor.execute(record, ctx);

        expect(outcome).toEqual({ kind: 'release', reason: 'aborted' });
    });

    it('stops before the next data operation when its library becomes excluded', async () => {
        api.requestOcr.mockImplementation(async () => {
            libraryScope.searchableIds.splice(0, libraryScope.searchableIds.length);
            return { status: 'ready', get_url: 'https://gcs/get' };
        });

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome).toEqual({ kind: 'release', reason: 'aborted' });
        expect(mockedGet).not.toHaveBeenCalled();
        expect(mockedReextract).not.toHaveBeenCalled();
    });

    it('defers; a track timeout leaves the row parked (no early wake)', async () => {
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-4' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });

        const outcome = await executor.execute(record, makeCtx());
        expect(outcome).toEqual({ kind: 'defer', reason: 'ocr_polling' });

        await executor.drainTracks();
        // A timeout leaves the row parked until its visibility window re-surfaces it.
        expect(dbStub.releaseBackgroundJob).not.toHaveBeenCalled();
        expect((globalThis as any).Zotero.Beaver.backgroundExtractor.notify).not.toHaveBeenCalled();
    });

    it('resumes by job_id after deferring and avoids another OCR request', async () => {
        const ex = new OcrExecutor(fakePoller as any);

        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-r' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        const first = await ex.execute(record, makeCtx());
        expect(first.kind).toBe('defer');
        expect(api.requestOcr).toHaveBeenCalledTimes(1);
        await ex.drainTracks();

        // Resume: the job is now complete, so the known job_id is checked
        // without creating another backend request.
        api.status.mockResolvedValue({ status: 'completed', get_url: 'https://gcs/get' });
        const second = await ex.execute(record, makeCtx());

        expect(api.requestOcr).toHaveBeenCalledTimes(1);
        expect(api.status).toHaveBeenCalledWith('job-r');
        expect(mockedGet).toHaveBeenCalledWith('https://gcs/get', expect.anything());
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('promotes a parked backfill job through request once, then returns to status polling', async () => {
        const ex = new OcrExecutor(fakePoller as any);
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'same-job' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        await ex.execute(record, makeCtx());
        await ex.drainTracks();
        const promoted = { ...record, payload: { request_context: 'interactive' } };
        await ex.execute(promoted, makeCtx());
        await ex.drainTracks();
        expect(api.requestOcr).toHaveBeenLastCalledWith('hash123', 5, 'interactive');
        api.status.mockResolvedValue({ status: 'completed', get_url: 'https://gcs/get' });
        expect(await ex.execute(promoted, makeCtx())).toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(api.requestOcr).toHaveBeenCalledTimes(2);
        expect(api.status).toHaveBeenCalledWith('same-job');
        ex.dispose();
    });

    it('retains interactive admission after executor restart without persisting signed URLs', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const persisted = JSON.parse(JSON.stringify({ ...record, payload: { request_context: 'interactive' } }));
        const restarted = new OcrExecutor(fakePoller as any);
        expect(await restarted.execute(persisted, makeCtx())).toEqual({ kind: 'complete', reason: 'ocr_ok' });
        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5, 'interactive');
        expect(mockedPut).not.toHaveBeenCalled();
        restarted.dispose();
    });

    it('falls back to /ocr/request when the resumed status 404s', async () => {
        const ex = new OcrExecutor(fakePoller as any);
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-404' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        await ex.execute(record, makeCtx());
        await ex.drainTracks();
        expect(api.requestOcr).toHaveBeenCalledTimes(1);

        api.status.mockRejectedValueOnce(new ApiError(404, 'Not Found'));
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const second = await ex.execute(record, makeCtx());

        expect(api.requestOcr).toHaveBeenCalledTimes(2);
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('falls back to /ocr/request when the resumed status is still pending', async () => {
        const ex = new OcrExecutor(fakePoller as any);
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-p' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        await ex.execute(record, makeCtx());
        await ex.drainTracks();

        api.status.mockResolvedValue({ status: 'pending' });
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const second = await ex.execute(record, makeCtx());

        expect(api.requestOcr).toHaveBeenCalledTimes(2);
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('ignores a stale hint when the file hash changed between defer and resume', async () => {
        const ex = new OcrExecutor(fakePoller as any);
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-h' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        await ex.execute(record, makeCtx());
        await ex.drainTracks();
        expect(api.requestOcr).toHaveBeenCalledTimes(1);
        const statusCallsAfterFirst = api.status.mock.calls.length;

        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            attachmentHash: 'hashCHANGED',
            attachmentContentType: 'application/pdf',
        }));
        dbStub.getAttachmentProcessingState.mockResolvedValue({
            fileHash: 'hashCHANGED', extractStatus: 'done', ocrStatus: 'needed',
        });
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const second = await ex.execute(record, makeCtx());

        expect(api.requestOcr).toHaveBeenCalledTimes(2);
        expect(api.requestOcr).toHaveBeenLastCalledWith('hashCHANGED', 5, 'backfill');
        expect(api.status.mock.calls.length).toBe(statusCallsAfterFirst);
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('dispose() aborts an in-flight track without waking the row', async () => {
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-d' });
        // A track that only settles when its abort signal fires.
        fakePoller.poll.mockImplementation(
            (_id: string, opts: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
        );

        const outcome = await executor.execute(record, makeCtx());
        expect(outcome).toEqual({ kind: 'defer', reason: 'ocr_polling' });

        executor.dispose();
        await executor.drainTracks();

        expect(dbStub.releaseBackgroundJob).not.toHaveBeenCalled();
        expect((globalThis as any).Zotero.Beaver.backgroundExtractor.notify).not.toHaveBeenCalled();
    });

    it('suspend() waits for an aborted slot-free track to settle', async () => {
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-s' });
        let releaseTrack!: () => void;
        const trackBarrier = new Promise<void>((resolve) => { releaseTrack = resolve; });
        let observeAbort!: () => void;
        const abortObserved = new Promise<void>((resolve) => { observeAbort = resolve; });
        fakePoller.poll.mockImplementation(
            (_id: string, opts: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    opts.signal.addEventListener('abort', async () => {
                        observeAbort();
                        await trackBarrier;
                        reject(new Error('aborted'));
                    }, { once: true });
                }),
        );

        expect(await executor.execute(record, makeCtx()))
            .toEqual({ kind: 'defer', reason: 'ocr_polling' });
        let suspended = false;
        const suspension = executor.suspend().then(() => { suspended = true; });
        await abortObserved;
        expect(suspended).toBe(false);
        releaseTrack();
        await suspension;

        expect(dbStub.releaseBackgroundJob).not.toHaveBeenCalled();
        expect(executor.getRemoteWaitingCount()).toBe(0);
    });
});
