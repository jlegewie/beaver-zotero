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
}));

vi.mock('../../../src/utils/zoteroItemUtils', () => ({
    safeIsInTrash: vi.fn(() => false),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

const libraryScope = vi.hoisted(() => ({ initialized: true, searchableIds: [1] }));
const profileAtoms = vi.hoisted(() => ({
    initialized: Symbol('libraryScopeInitializedAtom'),
    searchableIds: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn((target) => target === profileAtoms.initialized
            ? libraryScope.initialized
            : libraryScope.searchableIds),
    },
}));
vi.mock('../../../react/atoms/profile', () => ({
    libraryScopeInitializedAtom: profileAtoms.initialized,
    searchableLibraryIdsAtom: profileAtoms.searchableIds,
}));

import { OcrExecutor } from '../../../src/services/backgroundQueue/ocrExecutor';
import { ocrApiClient } from '../../../src/services/ocr/ocrApiClient';
import {
    getBytesFromSignedUrl,
    putBytesToSignedUrl,
} from '../../../src/services/ocr/gcsTransfer';
import { extractPdfBytesAndCacheAsOriginalAttachment } from '../../../src/services/documentExtraction/ocrReextract';
import {
    loadAttachmentData,
    resolveAttachmentFileSource,
} from '../../../src/services/documentExtraction/attachmentSource';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_BACKFILL } from '../../../src/services/ocr/constants';
import { ApiError } from '../../../react/types/apiErrors';
import type { JobExecutionContext } from '../../../src/services/backgroundQueue/jobExecutor';

const api = ocrApiClient as unknown as {
    requestOcr: ReturnType<typeof vi.fn>;
    markUploaded: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    reportOutcome: ReturnType<typeof vi.fn>;
};
const mockedReextract = vi.mocked(extractPdfBytesAndCacheAsOriginalAttachment);
const mockedResolveSource = vi.mocked(resolveAttachmentFileSource);
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
    libraryScope.initialized = true;
    libraryScope.searchableIds.splice(0, libraryScope.searchableIds.length, 1);

    fakePoller = { poll: vi.fn() };

    dbStub = {
        isDocumentProcessingPermanentlyFailed: vi.fn(async () => false),
        clearDocumentProcessingFailure: vi.fn(async () => undefined),
        // Used by the slot-free track to wake a parked row for the finish phase.
        releaseBackgroundJob: vi.fn(async () => undefined),
        // Attachment-ledger surface consulted around re-extraction.
        ensureAttachmentProcessingState: vi.fn(async () => ({})),
        ensureAttachmentFileHash: vi.fn(async () => undefined),
        getAttachmentProcessingState: vi.fn(async () => null),
        markAttachmentOcrDone: vi.fn(async () => true),
        markAttachmentOcrFailed: vi.fn(async () => undefined),
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
        documentCache: {
            getMetadata: vi.fn(async () => ({ pageCount: 5 })),
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

    it('exposes the document_ocr job type', () => {
        expect(executor.jobType).toBe('document_ocr');
    });

    it('downloads, re-extracts, and completes on a cache hit (ready)', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(api.requestOcr).toHaveBeenCalledWith('hash123', 5);
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

    it('completes without work when the backend reports disabled', async () => {
        api.requestOcr.mockResolvedValue({ status: 'disabled' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(mockedPut).not.toHaveBeenCalled();
        expect(ctx.runOnMuPDFWorker).not.toHaveBeenCalled();
        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_disabled' });
    });

    it('completes (not terminal) on a page-cap rejection so a cap raise re-enables it', async () => {
        api.requestOcr.mockResolvedValue({ status: 'rejected', reason: 'page_cap', limit: 100, page_count: 250 });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        // Page-cap rejections must not be persisted as terminal failures.
        expect(outcome.kind).toBe('complete');
        expect((outcome as any).reason).toBe('ocr_page_cap');
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

    it('records the OCR_NO_TEXT loop-guard terminal when re-extraction finds no text', async () => {
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        mockedReextract.mockResolvedValue({ kind: 'no_text' } as any);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('failPermanent');
        if (outcome.kind === 'failPermanent') {
            expect(outcome.failure.terminalCode).toBe('ocr_no_text');
            expect(outcome.failure.task).toBe('ocr');
        }
        // Client-detected terminal is reported to the backend for observability.
        expect(api.reportOutcome).toHaveBeenCalledWith({
            file_hash: 'hash123',
            outcome_code: 'ocr_no_text',
            engine_version: OCR_ENGINE_VERSION,
            page_count: 5,
            detail: undefined,
        });
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
        expect(api.reportOutcome).toHaveBeenCalledWith({
            file_hash: 'hash123',
            outcome_code: 'ocr_geometry_mismatch',
            engine_version: OCR_ENGINE_VERSION,
            page_count: 5,
            detail: 'page 0 width',
        });
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
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(api.requestOcr).not.toHaveBeenCalled();
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
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345 }));
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });
        api.markUploaded.mockResolvedValue({ status: 'queued', job_id: 'job-rem' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });

        // First claim: backend dedup uses the synced hash; bytes come from the
        // in-memory download, not the (absent) local file.
        const first = await executor.execute(record, makeCtx());
        expect(first).toEqual({ kind: 'defer', reason: 'ocr_polling' });
        expect(api.requestOcr).toHaveBeenCalledWith('synced999', 5);
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

    it('skips a remote-only scan for a backfill-priority job (no download)', async () => {
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        const backfillRecord = { ...record, priority: OCR_PRIORITY_BACKFILL };

        const outcome = await executor.execute(backfillRecord, makeCtx());

        expect(outcome).toEqual({ kind: 'complete', reason: 'file_not_local_remote' });
        expect(mockedLoad).not.toHaveBeenCalled();
        expect(api.requestOcr).not.toHaveBeenCalled();
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
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345 }));
        mockedLoad.mockResolvedValue({ kind: 'error', code: 'download_failed' } as any);
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-rem', put_url: 'https://gcs/put' });

        const outcome = await executor.execute(record, makeCtx());

        expect(outcome.kind).toBe('retry');
        expect((outcome as any).reason).toBe('ocr_remote_download_failed');
        expect(mockedPut).not.toHaveBeenCalled();
    });

    it('completes file_too_large when the remote download exceeds the cap', async () => {
        mockRemoteItem('synced999');
        mockedResolveSource.mockResolvedValue(REMOTE_SOURCE as any);
        (globalThis as any).Zotero.Beaver.documentCache.getMetadata = vi.fn(async () => ({ pageCount: 5, sourceSizeBytes: 12345 }));
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
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const second = await ex.execute(record, makeCtx());

        expect(api.requestOcr).toHaveBeenCalledTimes(2);
        expect(api.requestOcr).toHaveBeenLastCalledWith('hashCHANGED', 5);
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
});
