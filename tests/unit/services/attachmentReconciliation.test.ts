import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const mocks = vi.hoisted(() => ({
    resolve: vi.fn(), stat: vi.fn(), invalidate: vi.fn(), extract: vi.fn(),
    kind: 'snapshot', backgroundEnabled: true,
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: (key: string) => key === 'backgroundProcessingEnabled' && mocks.backgroundEnabled }));
vi.mock('../../../src/utils/idleService', () => ({ getSystemIdleTimeMs: () => 60_000 }));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: (item: any) => item.deleted === true }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: () => mocks.kind, liveAttachmentContentKind: () => mocks.kind,
}));
vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: mocks.resolve, loadAttachmentData: vi.fn(),
}));
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheDocument: mocks.extract, extractAndCacheEpubDocument: mocks.extract,
    extractAndCacheSnapshotDocument: mocks.extract,
}));
vi.mock('../../../src/services/ocr/enqueueOcr', () => ({ maybeEnqueueOcrJob: vi.fn(), enqueueOcrJob: vi.fn() }));

import { ReconcilerService } from '../../../src/services/backgroundProcessing/reconciler';
import { NewItemWatcher } from '../../../src/services/backgroundProcessing/newItemWatcher';
import { observeAttachmentSource } from '../../../src/services/documentExtraction/sourceObservation';
import { DocumentExtractExecutor } from '../../../src/services/backgroundQueue/documentExtractExecutor';
import { expectedExtractionSchemaVersion } from '../../../src/services/documentExtraction/shared/extractionSchemaVersions';

const entitlements = { hasOcrAccess: true, hasSearchIndexAccess: true };

describe('attachment change reconciliation', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    let reconciler: ReconcilerService;
    let watcher: NewItemWatcher;
    let observer: any;
    let item: any;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.kind = 'snapshot';
        mocks.backgroundEnabled = true;
        mocks.stat.mockResolvedValue({ lastModified: 10, size: 20 });
        mocks.resolve.mockResolvedValue({ kind: 'ok', source: { kind: 'local', filePath: '/a.html', isRemoteOnly: false } });
        mocks.extract.mockResolvedValue({ kind: 'response_error', code: 'no_text_layer', message: 'No text' });
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        await connection.queryAsync('CREATE TABLE items (itemID INTEGER, libraryID INTEGER, key TEXT)');
        await connection.queryAsync("INSERT INTO items VALUES (7, 1, 'SNAPSHOT')");
        item = { id: 7, libraryID: 1, key: 'SNAPSHOT', getFilePathAsync: async () => '/a.html',
            loadAllData: async () => {}, isRegularItem: () => false, attachmentContentType: 'text/html' };
        reconciler = new ReconcilerService();
        watcher = new NewItemWatcher();
        vi.stubGlobal('IOUtils', { stat: mocks.stat });
        vi.stubGlobal('Zotero', { ...Zotero,
            __beaverShuttingDown: false,
            DB: { queryAsync: connection.queryAsync.bind(connection) },
            Items: { getAsync: vi.fn(async () => item), getByLibraryAndKeyAsync: vi.fn(async () => item) },
            Libraries: { getAll: () => [] },
            Notifier: { registerObserver: vi.fn((value) => { observer = value; return 'watch'; }), unregisterObserver: vi.fn() },
            Beaver: { db, processingReconciler: reconciler, libraryScopeInitialized: true,
                searchableLibraryIds: [1], ...entitlements, documentCache: { invalidate: mocks.invalidate, getStats: vi.fn(async () => undefined) },
                backgroundExtractor: { notify: vi.fn() } },
        });
        reconciler.start();
        watcher.start();
    });

    afterEach(async () => {
        watcher.stop();
        reconciler.stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await connection.closeDatabase();
    });

    async function seed(failed = true, observed = true) {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, itemId: 7, contentKind: mocks.kind as any });
        const extractionSource = observed ? (await observeAttachmentSource(item, mocks.kind as any))!.identity : null;
        if (failed) {
            await db.markAttachmentExtractFailure({ libraryId: 1, zoteroKey: item.key, status: 'failed', error: 'no_text_layer', attemptedAt: 100, extractionSource });
        } else {
            await connection.queryAsync(`UPDATE attachment_processing_state SET extract_status='done',
                extract_schema_version=?, ocr_status='na', upsert_status='done', upsert_index_version='2',
                structured_document_hash='indexed', file_mtime_ms=10, file_size_bytes=20, extraction_source=?`,
                [expectedExtractionSchemaVersion(mocks.kind as any), extractionSource]);
        }
    }

    async function notify(event = 'modify') {
        observer.notify(event, 'item', [7], { 7: { libraryID: 1, key: item.key } });
        await (watcher as any).flush();
        await (reconciler as any).run(false);
    }

    async function deepCheck() {
        const jobs: any[] = [];
        await (reconciler as any).reconcileAttachment(db, item, mocks.kind, true, jobs,
            await db.getAttachmentProcessingState(1, item.key));
        await db.enqueueBackgroundJobs(jobs);
    }

    it('keeps an empty snapshot listed and does no extraction work on open, page change, or close', async () => {
        await seed();
        const before = await db.getAttachmentProcessingState(1, item.key);
        for (const readTime of [100, 400, 800]) {
            item.attachmentLastRead = readTime;
            await notify();
        }
        expect(await db.getAttachmentProcessingState(1, item.key)).toEqual(before);
        expect(await db.getProcessingIssueCounts(entitlements)).toEqual([{ reason: 'no_text', count: 1 }]);
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });

    it('keeps an indexed PDF and its cache intact after metadata and reading updates', async () => {
        mocks.kind = 'pdf';
        await seed(false);
        const before = await db.getAttachmentProcessingState(1, item.key);
        item.attachmentLastRead = 200;
        item.title = 'New title';
        await notify();
        expect(await db.getAttachmentProcessingState(1, item.key)).toEqual(before);
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });

    it.each(['mtime', 'size', 'path', 'kind'])('rechecks changed %s while preserving the last failure until a new read', async (change) => {
        await seed();
        if (change === 'mtime') mocks.stat.mockResolvedValue({ lastModified: 11, size: 20 });
        if (change === 'size') mocks.stat.mockResolvedValue({ lastModified: 10, size: 21 });
        if (change === 'path') mocks.resolve.mockResolvedValue({ kind: 'ok', source: { filePath: '/replacement.html', isRemoteOnly: false } });
        if (change === 'kind') mocks.kind = 'epub';
        await notify();
        expect((await db.getAttachmentProcessingState(1, item.key))?.extractStatus).toBeNull();
        expect(await db.peekBackgroundJobs()).toEqual([expect.objectContaining({ jobType: 'document_extract' })]);
        expect(mocks.invalidate).toHaveBeenCalledWith(1, item.key);
        expect(await db.getProcessingIssueCounts(entitlements)).toEqual([{ reason: 'no_text', count: 1 }]);
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: item.key, contentKind: mocks.kind, errorCode: null, attemptedAt: 200 });
        expect(await db.getProcessingIssueCounts(entitlements)).toEqual([]);
    });

    it('records the attempted source even when extraction finds no text', async () => {
        await notify('add');
        const job = await db.claimNextBackgroundJob(Date.now(), 60_000);
        const outcome = await new DocumentExtractExecutor().execute(job!, {
            db: db as any, runOnMuPDFWorker: async (fn) => fn(), externalAbortSignal: new AbortController().signal,
            shouldSkipDbWrites: () => false, enqueue: async () => {},
        });
        expect(outcome.kind).toBe('complete');
        expect(await db.getAttachmentProcessingState(1, item.key)).toMatchObject({ extractStatus: 'failed',
            extractionSource: (await observeAttachmentSource(item, 'snapshot'))!.identity });
        // Retire the job as the dispatcher would, then deliver another read notification.
        await connection.queryAsync('DELETE FROM background_jobs');
        await notify();
        expect(await db.peekBackgroundJobs()).toEqual([]);
    });

    it.each([
        ['missing', 'notification'], ['invalid', 'notification'],
        ['missing', 'deep'], ['invalid', 'deep'],
        ['retry', 'notification'], ['abort', 'notification'], ['cached_pdf', 'notification'],
    ])('keeps a %s replacement discoverable after cache preparation (%s reconciliation)', async (failure, check) => {
        if (failure === 'cached_pdf') {
            mocks.kind = 'pdf';
            item.attachmentContentType = 'application/pdf';
        }
        await seed(false);
        const before = await db.getAttachmentProcessingState(1, item.key);
        if (failure === 'missing') {
            mocks.resolve.mockResolvedValue({ kind: 'error', code: 'file_missing' });
        } else {
            mocks.stat.mockResolvedValue({ lastModified: 11, size: 20 });
            mocks.extract.mockResolvedValue({ kind: failure === 'cached_pdf' ? 'cached_error' : 'response_error',
                code: failure === 'retry' ? 'extraction_failed' : failure === 'abort' ? 'timeout' : 'invalid_pdf',
                message: 'Replacement could not be read' });
        }
        await db.enqueueBackgroundJob({ jobType: 'document_extract', libraryId: 1, zoteroKey: item.key,
            itemId: item.id, contentKind: mocks.kind as 'snapshot' | 'pdf', payloadKind: 'structured', priority: 110,
            payload: { content_kind: mocks.kind as 'snapshot' | 'pdf', prepare_cache: true }, now: Date.now() });
        const job = await db.claimNextBackgroundJob(Date.now(), 60_000);
        const outcome = await new DocumentExtractExecutor().execute(job!, {
            db: db as any, runOnMuPDFWorker: async (fn) => fn(), externalAbortSignal: new AbortController().signal,
            shouldSkipDbWrites: () => false, enqueue: async () => {},
        });
        expect(outcome.kind).toBe(failure === 'retry' ? 'retry' : failure === 'abort' ? 'release' : 'complete');
        // A rejected verdict or unfinished attempt cannot relabel the existing successful result.
        expect(await db.getAttachmentProcessingState(1, item.key)).toEqual(before);
        await connection.queryAsync('DELETE FROM background_jobs');
        if (check === 'deep') await deepCheck();
        else await notify();
        const row = await db.getAttachmentProcessingState(1, item.key);
        expect(mocks.invalidate).toHaveBeenCalledWith(1, item.key);
        if (failure === 'missing') {
            expect(row).toMatchObject({ extractStatus: 'skipped', lastError: 'file_missing',
                extractionSource: (await observeAttachmentSource(item, 'snapshot'))!.identity });
        } else {
            expect(row?.extractStatus).toBeNull();
            expect(await db.peekBackgroundJobs()).toEqual([expect.objectContaining({ jobType: 'document_extract' })]);
        }
    });

    it('leaves legacy failures alone on reading activity, then performs a bounded deep recheck', async () => {
        await seed(true, false);
        await notify();
        expect(await db.peekBackgroundJobs()).toEqual([]);
        await deepCheck();
        expect(await db.peekBackgroundJobs()).toHaveLength(1);
        expect(await db.getProcessingIssueCounts(entitlements)).toEqual([{ reason: 'no_text', count: 1 }]);
    });

    it('adopts a matching legacy successful signature without extracting again', async () => {
        await seed(false, false);
        await deepCheck();
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect((await db.getAttachmentProcessingState(1, item.key))?.extractionSource).not.toBeNull();
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });

    it('retries a missing file when it becomes available, but not on repeated reads while missing', async () => {
        mocks.resolve.mockResolvedValue({ kind: 'error', code: 'file_missing' });
        await notify('add');
        const before = await db.getAttachmentProcessingState(1, item.key);
        await notify();
        expect(await db.getAttachmentProcessingState(1, item.key)).toEqual(before);
        expect(await db.peekBackgroundJobs()).toEqual([]);
        mocks.resolve.mockResolvedValue({ kind: 'ok', source: { filePath: '/a.html', isRemoteOnly: false } });
        await notify();
        expect(await db.peekBackgroundJobs()).toHaveLength(1);
        expect(await db.getProcessingIssueCounts(entitlements)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
    });

    it('uses remote file identity instead of metadata sync versions', async () => {
        mocks.resolve.mockResolvedValue({ kind: 'ok', source: { filePath: 'remote:k:1-SNAPSHOT-v1', isRemoteOnly: true } });
        item.attachmentSyncedHash = 'hash1';
        await seed(false);
        mocks.resolve.mockResolvedValue({ kind: 'ok', source: { filePath: 'remote:k:1-SNAPSHOT-v2', isRemoteOnly: true } });
        await notify();
        expect(await db.peekBackgroundJobs()).toEqual([]);
        item.attachmentSyncedHash = 'hash2';
        await notify();
        expect(await db.peekBackgroundJobs()).toHaveLength(1);
    });

    it('does not interpret a failed stat as changed content', async () => {
        await seed();
        mocks.stat.mockRejectedValue(new Error('temporarily inaccessible'));
        await notify();
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });

    it('durably schedules index cleanup before removing deleted attachments', async () => {
        await seed(false);
        await notify('delete');
        expect(await db.getAttachmentProcessingState(1, item.key)).toBeNull();
        expect(await db.peekBackgroundJobs()).toEqual([expect.objectContaining({ jobType: 'fulltext_untag' })]);
    });

    it('coalesces notifications arriving during an attachment check without overlapping producers', async () => {
        await seed();
        let release!: () => void;
        let entered!: () => void;
        const startedStat = new Promise<void>((resolve) => { entered = resolve; });
        const pendingStat = new Promise<void>((resolve) => { release = resolve; });
        mocks.stat.mockImplementationOnce(async () => { entered(); await pendingStat; return { lastModified: 10, size: 20 }; });
        reconciler.notifyAttachments([{ event: 'modify', id: 7 }]);
        const active = (reconciler as any).run(false);
        await startedStat;
        const statCalls = mocks.stat.mock.calls.length;
        reconciler.notifyAttachments([{ event: 'modify', id: 7 }, { event: 'modify', id: 7 }]);
        await (reconciler as any).run(false);
        expect(mocks.stat).toHaveBeenCalledTimes(statCalls);
        release();
        await active;
        await (reconciler as any).run(false);
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(mocks.invalidate).not.toHaveBeenCalled();
        expect((reconciler as any).pendingAttachments.size).toBe(0);
    });

    it('does not rescan the library or postpone the periodic deadline on repeated reads', async () => {
        await seed();
        const enumerate = vi.spyOn(Zotero.Libraries, 'getAll');
        await notify();
        const deadline = (reconciler as any).nextScanAt;
        expect(enumerate).toHaveBeenCalledTimes(1);
        await notify();
        await notify();
        expect(enumerate).toHaveBeenCalledTimes(1);
        expect((reconciler as any).nextScanAt).toBe(deadline);
        vi.setSystemTime(deadline);
        await notify();
        expect(enumerate).toHaveBeenCalledTimes(2);
    });

    it.each([true, false])('upgrades the source identity column without losing processing history (failed=%s)', async (failed) => {
        await seed(failed);
        const before = await db.getAttachmentProcessingState(1, item.key);
        await connection.queryAsync('ALTER TABLE attachment_processing_state DROP COLUMN extraction_source');
        await db.initDatabase('0.99.0');
        expect(await db.getAttachmentProcessingState(1, item.key)).toEqual({ ...before, extractionSource: null });
        await db.initDatabase('0.99.0');
        expect(await db.getAttachmentProcessingState(1, item.key)).toEqual({ ...before, extractionSource: null });
    });

    it('does not inspect files from excluded libraries', async () => {
        await seed();
        (Zotero.Beaver as any).searchableLibraryIds = [];
        mocks.resolve.mockClear();
        await notify();
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(await db.peekBackgroundJobs()).toEqual([]);
    });
});
