import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Speed up polling so queued/pending cases don't actually sleep.
vi.mock('../../../src/services/ocr/constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/services/ocr/constants')>();
    return {
        ...actual,
        OCR_POLL_INITIAL_MS: 1,
        OCR_POLL_MAX_MS: 1,
        OCR_POLL_BUDGET_MS: 50,
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
}));

vi.mock('../../../src/utils/zoteroItemUtils', () => ({
    safeIsInTrash: vi.fn(() => false),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { OcrExecutor } from '../../../src/services/backgroundQueue/ocrExecutor';
import { ocrApiClient } from '../../../src/services/ocr/ocrApiClient';
import {
    getBytesFromSignedUrl,
    putBytesToSignedUrl,
} from '../../../src/services/ocr/gcsTransfer';
import { extractPdfBytesAndCacheAsOriginalAttachment } from '../../../src/services/documentExtraction/ocrReextract';
import { resolveAttachmentFileSource } from '../../../src/services/documentExtraction/attachmentSource';
import { OCR_ENGINE_VERSION } from '../../../src/services/ocr/constants';
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
const mockedPut = vi.mocked(putBytesToSignedUrl);
const mockedGet = vi.mocked(getBytesFromSignedUrl);

const record = { libraryId: 1, zoteroKey: 'AAAAAAAA' } as any;

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

    fakePoller = { poll: vi.fn() };

    dbStub = {
        isDocumentProcessingPermanentlyFailed: vi.fn(async () => false),
        clearDocumentProcessingFailure: vi.fn(async () => undefined),
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

    (globalThis as any).Zotero.Beaver = {
        documentCache: {
            getMetadata: vi.fn(async () => ({ pageCount: 5 })),
        },
    };

    (globalThis as any).IOUtils.read = vi.fn(async () => new Uint8Array([9, 9, 9]));

    mockedResolveSource.mockResolvedValue({
        kind: 'ok',
        source: { kind: 'local', filePath: '/scan.pdf', isRemoteOnly: false },
    } as any);
    mockedReextract.mockResolvedValue({ kind: 'ok', pageCount: 5 } as any);
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

    it('uploads, confirms, polls, then completes (pending)', async () => {
        api.requestOcr.mockResolvedValue({ status: 'pending', job_id: 'job-1', put_url: 'https://gcs/put' });
        api.markUploaded.mockResolvedValue({ status: 'queued', job_id: 'job-1' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(mockedPut).toHaveBeenCalledWith('https://gcs/put', expect.any(Uint8Array), expect.anything());
        expect(api.markUploaded).toHaveBeenCalledWith('job-1');
        expect(fakePoller.poll).toHaveBeenCalledWith('job-1', expect.objectContaining({ deadline: expect.any(Number) }));
        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('polls an already-queued job to completion', async () => {
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-2' });
        fakePoller.poll.mockResolvedValue({ kind: 'completed', getUrl: 'https://gcs/get' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(mockedPut).not.toHaveBeenCalled();
        expect(fakePoller.poll).toHaveBeenCalledTimes(1);
        expect(fakePoller.poll).toHaveBeenCalledWith('job-2', expect.objectContaining({ deadline: expect.any(Number) }));
        expect(outcome).toEqual({ kind: 'complete', reason: 'ocr_ok' });
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

    it('completes when the scan is not available locally', async () => {
        mockedResolveSource.mockResolvedValue({ kind: 'error', code: 'file_missing' } as any);
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome).toEqual({ kind: 'complete', reason: 'file_unavailable' });
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

    it('releases when the poll budget is exhausted', async () => {
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-4' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        const ctx = makeCtx();

        const outcome = await executor.execute(record, ctx);

        expect(outcome.kind).toBe('release');
        expect((outcome as any).reason).toBe('ocr_poll_timeout');
    });

    it('resumes by job_id after a release and avoids another OCR request', async () => {
        const ex = new OcrExecutor(fakePoller as any);

        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-r' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        const first = await ex.execute(record, makeCtx());
        expect(first.kind).toBe('release');
        expect(api.requestOcr).toHaveBeenCalledTimes(1);

        // Resume: the job is now complete. resumeByJobId probes single /ocr/status
        // with the known job_id and must NOT call /ocr/request again.
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

        api.status.mockResolvedValue({ status: 'pending' });
        api.requestOcr.mockResolvedValue({ status: 'ready', get_url: 'https://gcs/get' });
        const second = await ex.execute(record, makeCtx());

        expect(api.requestOcr).toHaveBeenCalledTimes(2);
        expect(second).toEqual({ kind: 'complete', reason: 'ocr_ok' });
    });

    it('ignores a stale hint when the file hash changed between release and resume', async () => {
        const ex = new OcrExecutor(fakePoller as any);
        api.requestOcr.mockResolvedValue({ status: 'queued', job_id: 'job-h' });
        fakePoller.poll.mockResolvedValue({ kind: 'timeout' });
        await ex.execute(record, makeCtx());
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
});
