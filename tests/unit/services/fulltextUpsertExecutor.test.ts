import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB, type BackgroundJobRecord } from '../../../src/services/database';
import { FulltextUpsertExecutor } from '../../../src/services/backgroundQueue/fulltextUpsertExecutor';
import type { JobExecutionContext } from '../../../src/services/backgroundQueue/jobExecutor';
import { ApiError } from '@beaver/agent-core/types/apiErrors';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { BACKGROUND_EXTRACT_PRIORITY, BACKGROUND_UPSERT_PRIORITY } from '../../../src/services/backgroundProcessing/constants';
import { OCR_PRIORITY_ON_DEMAND } from '../../../src/services/ocr/constants';

async function countCleanupIntents(connection: MockDBConnection, accountId: string): Promise<number> {
    const rows = await connection.queryAsync('SELECT COUNT(*) AS n FROM index_cleanup_outbox WHERE account_id = ?', [accountId]);
    return rows[0].n;
}

vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({
    searchIndexApiClient: {},
}));

vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: vi.fn(async () => ({
        kind: 'ok',
        source: { kind: 'local', filePath: '/tmp/file.pdf', isRemoteOnly: false },
    })),
}));

vi.mock('../../../src/services/documentExtraction/structuredDocumentHash', () => ({
    computeStructuredDocumentHash: vi.fn(async () => 'a'.repeat(64)),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn(() => 'lLOCAL123'),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));

vi.mock('../../../src/services/backgroundProcessing/utils', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        isBackgroundProcessingLibraryEnabled: vi.fn(() => true),
    };
});

function response(status: 'completed' | 'tagged' = 'tagged', indexVersion = 3) {
    return {
        status,
        namespace_ready: true,
        chunks_total: 2,
        chunks_upserted: status === 'completed' ? 2 : 0,
        chunks_patched: 0,
        chunks_skipped: 0,
        chunks_deleted: 0,
        index_version: indexVersion,
        extract_schema_version: '4',
        embed_tokens: status === 'completed' ? 10 : 0,
    };
}

describe('FulltextUpsertExecutor', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    let api: {
        requirements: ReturnType<typeof vi.fn>;
        upsertHash: ReturnType<typeof vi.fn>;
        upsertPayload: ReturnType<typeof vi.fn>;
        untag: ReturnType<typeof vi.fn>;
    };
    let enqueue: ReturnType<typeof vi.fn>;
    let ctx: JobExecutionContext;
    let record: BackgroundJobRecord;

    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: 10,
            contentKind: 'pdf',
        });
        await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null,
            expectedFileSizeBytes: null,
            previousDocumentHash: null,
            expectedExtractStatus: null,
            fileMtimeMs: 1,
            fileSizeBytes: 2,
            fileHash: 'file-md5',
            structuredDocumentHash: 'a'.repeat(64),
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        });
        api = {
            requirements: vi.fn().mockResolvedValue({ index_version: 3, extract_schema_versions: { pdf: ['4'], epub: ['2'], snapshot: ['1'] } }),
            upsertHash: vi.fn().mockResolvedValue(response('tagged')),
            upsertPayload: vi.fn().mockResolvedValue(response('completed')),
            untag: vi.fn().mockResolvedValue({ results: [] }),
        };
        enqueue = vi.fn(async () => undefined);
        ctx = {
            db: db as any,
            runOnMuPDFWorker: vi.fn(async (fn) => fn()),
            externalAbortSignal: new AbortController().signal,
            shouldSkipDbWrites: () => false,
            enqueue,
        };
        record = {
            id: 1,
            jobType: 'fulltext_upsert',
            libraryId: 1,
            itemId: 10,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf',
            payloadKind: 'structured',
            priority: 115,
            payload: {
                content_kind: 'pdf',
                maxPages: null,
                timeoutSeconds: 120,
                index_action: 'upsert',
            },
            enqueuedAt: 0,
            availableAt: 0,
            attemptCount: 0,
            lastError: null,
        };
        const payload = {
            schemaVersion: '4',
            mode: 'structured',
            document: { pageCount: 0, bboxOrigin: 'top-left', bboxPrecision: 1, pages: [], citationIndex: {} },
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            data: { env: 'production' },
            hasSearchIndexAccess: true,
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            documentCache: { getResult: vi.fn(async () => payload) },
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(async () => ({
                libraryID: 1,
                key: 'ABCDEFGH',
                isAttachment: () => true,
                isInTrash: () => false,
            })),
        };
    });

    afterEach(async () => {
        await connection.closeDatabase();
    });

    it('persists the server namespace generation with a successful acknowledgement', async () => {
        Zotero.Beaver.account = { getGeneration: () => 1,
            getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        api.upsertHash.mockResolvedValue({ ...response('tagged'), namespace_generation: 2 });
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toMatchObject({ kind: 'complete' });
        expect((await db.getAttachmentProcessingState(1, record.zoteroKey))?.upsertRemoteIdentity)
            .toMatchObject({ index_account_id: 'owner', namespace_generation: 2 });
    });

    it.each([
        [0, 2, 'missing', 2, 'missing'],
        [0, 2, 'current', 2, 'current'],
        [0, 1, 'current', 2, 'unknown'],
        [2, 1, 'current', 2, 'current'],
        [2, 2, 'current', undefined, 'unknown'],
    ])('uses acknowledged generation and preserves honest namespace validity (%s chunks, %s → %s)', async (
        chunks, previousGeneration, previousValidity, acknowledgedGeneration, expectedValidity,
    ) => {
        const requirements = { index_version: 3, extract_schema_versions: { pdf: ['4'], epub: ['2'], snapshot: ['1'] },
            namespace_generation: previousGeneration, index_validity: previousValidity };
        api.requirements.mockResolvedValue(requirements);
        api.upsertHash.mockResolvedValue({ ...response(), chunks_total: chunks, namespace_generation: acknowledgedGeneration });
        const recordRequirements = vi.fn();
        (api as any).recordRequirements = recordRequirements;
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toMatchObject({ kind: 'complete' });
        expect(recordRequirements).toHaveBeenCalledWith(expect.objectContaining({
            namespace_generation: acknowledgedGeneration ?? null, index_validity: expectedValidity,
        }));
    });

    it.each([2, 3])('does not let a late acknowledgement regress cached validity or generation %s', async currentGeneration => {
        const initialRequirements = { index_version: 3, extract_schema_versions: { pdf: ['4'], epub: ['2'], snapshot: ['1'] },
            namespace_generation: 2, index_validity: 'missing' };
        let cached = initialRequirements;
        api.requirements.mockResolvedValue(initialRequirements);
        (api as any).getCachedRequirements = () => cached;
        const recordRequirements = vi.fn(value => { cached = value; });
        (api as any).recordRequirements = recordRequirements;
        // Another completion or requirements read wins while this upload is in flight.
        api.upsertHash.mockImplementation(async () => {
            cached = { ...initialRequirements, namespace_generation: currentGeneration, index_validity: 'current' };
            return { ...response(), chunks_total: 0, namespace_generation: 2 };
        });
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toMatchObject({ kind: 'complete' });
        expect(recordRequirements).toHaveBeenCalledWith(expect.objectContaining({
            namespace_generation: currentGeneration, index_validity: 'current',
        }));
    });

    it('cleans up without paid access using the frozen remote identity', async () => {
        (Zotero.Beaver as any).hasSearchIndexAccess = false;
        Zotero.Beaver.libraryScopeInitialized = true;
        (Zotero.Beaver as any).account = { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account-a' } } }) };
        record.jobType = 'fulltext_untag';
        record.payload = { ...record.payload!, doc_hash: 'a'.repeat(64), index_account_id: 'account-a', index_scope_ref: 'g123', index_local_id: 'OLDDEVICE' };
        api.untag.mockResolvedValue({ results: [{ outcome: 'untagged' }] });
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toEqual({ kind: 'complete', reason: 'index_untagged' });
        expect(api.untag).toHaveBeenCalledWith('OLDDEVICE', [{ scope_ref: 'g123', zotero_key: record.zoteroKey, doc_hash: 'a'.repeat(64) }]);
    });

    it.each([false, true])('transfers unchanged content to another account after an ambiguous upload: %s', async (ambiguous) => {
        let accountId = 'account-a';
        Zotero.Beaver.account = { getGeneration: () => 1,
            getSnapshot: () => ({ session: { user: { id: accountId } } }) } as any;
        if (ambiguous) api.upsertHash.mockRejectedValueOnce(new Error('response lost after commit'));
        const executor = new FulltextUpsertExecutor(api as any);
        expect(await executor.execute(record, ctx)).toMatchObject({ kind: ambiguous ? 'retry' : 'complete' });
        const originalIdentity = (await db.getAttachmentProcessingState(1, record.zoteroKey))!.upsertRemoteIdentity;

        accountId = 'account-b';
        expect(await executor.execute(record, ctx)).toMatchObject({ kind: 'complete', reason: 'index_tagged' });
        expect(api.upsertHash).toHaveBeenCalledTimes(2);
        expect(await db.getAttachmentProcessingState(1, record.zoteroKey)).toMatchObject({
            upsertStatus: 'done', upsertRemoteIdentity: { index_account_id: 'account-b' },
        });
        expect(await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: record.zoteroKey,
            structuredDocumentHash: 'a'.repeat(64), upsertIndexVersion: '3', remoteIdentity: originalIdentity })).toBe(false);
        expect(await countCleanupIntents(connection, 'account-a')).toBe(1);
        const cleanup = (await db.peekBackgroundJobs()).find((job) => job.jobType === 'fulltext_untag')!;
        expect(cleanup.payload).toMatchObject({ ...originalIdentity, doc_hash: 'a'.repeat(64) });
        expect(await executor.execute(cleanup, ctx)).toMatchObject({ kind: 'complete', reason: 'cleanup_account_unavailable' });
        expect(api.untag).not.toHaveBeenCalled();
        accountId = 'account-a';
        api.untag.mockResolvedValue({ results: [{ outcome: 'untagged' }] });
        expect(await executor.execute(cleanup, ctx)).toMatchObject({ kind: 'complete' });
        expect(api.untag).toHaveBeenCalledTimes(1);
        expect(await countCleanupIntents(connection, 'account-a')).toBe(0);
    });

    it.each([undefined, 'exclusion', 'replacement', 'stale_completion'] as const)('defers %s cleanup while A reacquires ownership after A → B → A', async (reason) => {
        let accountId = 'account-a';
        Zotero.Beaver.account = { getGeneration: () => 1,
            getSnapshot: () => ({ session: { user: { id: accountId } } }) } as any;
        const executor = new FulltextUpsertExecutor(api as any);
        await executor.execute(record, ctx);
        accountId = 'account-b';
        await executor.execute(record, ctx);
        const cleanup = (await db.peekBackgroundJobs()).find((job) => job.payload?.index_account_id === 'account-a')!;
        cleanup.payload = { ...cleanup.payload!, index_cleanup_reason: reason };
        accountId = 'account-a';
        let remoteMembership = false;
        let committed!: () => void;
        const commit = new Promise<void>((resolve) => { committed = resolve; });
        let respond!: () => void;
        const responseGate = new Promise<void>((resolve) => { respond = resolve; });
        api.upsertHash.mockImplementationOnce(async () => {
            remoteMembership = true;
            committed();
            await responseGate;
            return response('tagged');
        });
        api.untag.mockImplementation(async () => {
            remoteMembership = false;
            return { results: [{ outcome: 'untagged' }] };
        });
        const upload = executor.execute(record, ctx);
        await commit;
        try {
            expect(await db.getAttachmentProcessingState(1, record.zoteroKey)).toMatchObject({
                upsertStatus: null, upsertRemoteIdentity: { index_account_id: 'account-a' },
            });
            expect(await executor.execute(cleanup, ctx)).toEqual({ kind: 'defer', reason: 'index_acquisition_pending' });
            expect(api.untag).not.toHaveBeenCalled();
            expect(await countCleanupIntents(connection, 'account-a')).toBe(1);
        } finally {
            respond();
            await upload;
        }
        expect(await db.getAttachmentProcessingState(1, record.zoteroKey)).toMatchObject({ upsertStatus: 'done' });
        expect(await executor.execute(cleanup, ctx)).toEqual({ kind: 'complete', reason: 'cleanup_superseded' });
        expect(api.untag).not.toHaveBeenCalled();
        expect(remoteMembership).toBe(true);
        expect(await countCleanupIntents(connection, 'account-a')).toBe(0);
    });

    it('does not dispatch with a different account after awaiting ownership transfer', async () => {
        let accountId = 'account-a';
        Zotero.Beaver.account = { getGeneration: () => 1,
            getSnapshot: () => ({ session: { user: { id: accountId } } }) } as any;
        const acquire = db.recordAttachmentIndexIdentity.bind(db);
        vi.spyOn(db, 'recordAttachmentIndexIdentity').mockImplementation(async (...args) => {
            const result = await acquire(...args);
            accountId = 'account-b';
            return result;
        });
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toEqual({ kind: 'release', reason: 'access_changed' });
        expect(api.upsertHash).not.toHaveBeenCalled();
        expect(api.upsertPayload).not.toHaveBeenCalled();
    });

    it.each([
        [400, 'bad_request', true], [413, 'http_413', true],
        [422, 'invalid_payload', true], [403, 'not_entitled', true],
        [401, 'unauthorized', false], [429, 'rate_limited', false], [503, 'unavailable', false],
    ] as const)('retires only terminal untag failures: %s %s', async (status, code, terminal) => {
        Zotero.Beaver.account = { getGeneration: () => 1, revokeSearchIndexAccess: vi.fn(),
            getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        const queued = await db.enqueueBackgroundJob({ ...record, jobType: 'fulltext_untag', now: Date.now(),
            payload: { ...record.payload!, doc_hash: 'b'.repeat(64), index_account_id: 'owner',
                index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' } });
        const job = (await db.peekBackgroundJobs()).find((entry) => entry.id === queued.id)!;
        api.untag.mockRejectedValue(new ApiError(status, 'request failed', 'request failed', code));
        const outcome = await new FulltextUpsertExecutor(api as any).execute(job, ctx);
        expect(outcome).toMatchObject(terminal ? { kind: 'complete', reason: `terminal:${code}` } : { kind: 'retry' });
        expect(await countCleanupIntents(connection, 'owner')).toBe(terminal ? 0 : 1);
        await db.completeBackgroundJob(job.id);
        expect(await db.restoreIndexCleanup('owner')).toBe(terminal ? 0 : 1);
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        expect(await countCleanupIntents(connection, 'owner')).toBe(terminal ? 0 : 1);
    });

    it('retains cleanup if a terminal response arrives after account revocation', async () => {
        let generation = 1;
        Zotero.Beaver.account = { getGeneration: () => generation,
            getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        const queued = await db.enqueueBackgroundJob({ ...record, jobType: 'fulltext_untag', now: Date.now(),
            payload: { ...record.payload!, doc_hash: 'b'.repeat(64), index_account_id: 'owner',
                index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' } });
        const job = (await db.peekBackgroundJobs()).find((entry) => entry.id === queued.id)!;
        api.untag.mockImplementation(async () => {
            generation++;
            throw new ApiError(400, 'bad request', 'bad request', 'invalid_payload');
        });
        expect(await new FulltextUpsertExecutor(api as any).execute(job, ctx)).toEqual({ kind: 'release', reason: 'access_changed' });
        expect(await countCleanupIntents(connection, 'owner')).toBe(1);
    });

    it('retires a v0.25 unowned cleanup without guessing an account', async () => {
        Zotero.Beaver.account = { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: record.zoteroKey,
            structuredDocumentHash: 'a'.repeat(64), upsertIndexVersion: '2' });
        const queued = await db.enqueueBackgroundJob({ ...record, jobType: 'fulltext_untag', now: Date.now(),
            payload: { ...record.payload!, doc_hash: 'a'.repeat(64) } });
        const legacy = (await db.peekBackgroundJobs()).find((job) => job.id === queued.id)!;
        expect(await new FulltextUpsertExecutor(api as any).execute(legacy, ctx)).toEqual({ kind: 'complete', reason: 'legacy_unowned' });
        await db.completeBackgroundJob(legacy.id);
        expect(api.untag).not.toHaveBeenCalled();
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(await db.restoreIndexCleanup('owner')).toBe(0);
    });

    it('restores another account’s completed queue ticket only when its owner returns', async () => {
        let accountId = 'account-b';
        Zotero.Beaver.account = { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: accountId } } }) } as any;
        const queued = await db.enqueueBackgroundJob({ ...record, jobType: 'fulltext_untag', now: Date.now(),
            payload: { ...record.payload!, doc_hash: 'a'.repeat(64), index_account_id: 'account-a',
                index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' } });
        const job = (await db.peekBackgroundJobs()).find((entry) => entry.id === queued.id)!;
        const executor = new FulltextUpsertExecutor(api as any);
        expect(await executor.execute(job, ctx)).toEqual({ kind: 'complete', reason: 'cleanup_account_unavailable' });
        await db.completeBackgroundJob(job.id);
        expect(await db.restoreIndexCleanup('account-b')).toBe(0);
        expect(await countCleanupIntents(connection, 'account-a')).toBe(1);
        accountId = 'account-a';
        expect(await db.restoreIndexCleanup('account-a')).toBe(1);
        api.untag.mockResolvedValue({ results: [{ outcome: 'untagged' }] });
        expect(await executor.execute((await db.peekBackgroundJobs())[0], ctx)).toEqual({ kind: 'complete', reason: 'index_untagged' });
        expect(await countCleanupIntents(connection, 'account-a')).toBe(0);
    });

    it('retains cleanup for an account that is not signed in', async () => {
        record.jobType = 'fulltext_untag';
        record.payload = { ...record.payload!, doc_hash: 'a'.repeat(64), index_account_id: 'another-account' };
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toEqual({ kind: 'complete', reason: 'cleanup_account_unavailable' });
        expect(api.untag).not.toHaveBeenCalled();
    });

    it.each(['exclusion', 'replacement', 'stale_completion'] as const)('defers %s cleanup until scope resolves, then cancels superseded work', async (reason) => {
        const identity = { index_account_id: 'owner', index_scope_ref: 'g123', index_local_id: 'DEVICE' };
        Zotero.Beaver.account = { getGeneration: () => 1,
            getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        record.jobType = 'fulltext_untag';
        record.payload = { ...record.payload!, ...identity, doc_hash: 'a'.repeat(64),
            index_action: 'untag', index_cleanup_reason: reason };
        await db.enqueueBackgroundJob({ ...record, now: Date.now() });
        await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: record.zoteroKey,
            structuredDocumentHash: 'a'.repeat(64), upsertIndexVersion: '3', remoteIdentity: identity });
        const acknowledge = vi.spyOn(db, 'acknowledgeIndexCleanup');
        Zotero.Beaver.libraryScopeInitialized = false;
        const executor = new FulltextUpsertExecutor(api as any);
        expect(await executor.execute(record, ctx)).toEqual({ kind: 'release', reason: 'access_changed' });
        expect(api.untag).not.toHaveBeenCalled();
        expect(acknowledge).not.toHaveBeenCalled();
        expect(await countCleanupIntents(connection, 'owner')).toBe(1);

        Zotero.Beaver.libraryScopeInitialized = true;
        expect(await executor.execute(record, ctx)).toEqual({ kind: 'complete', reason: 'cleanup_superseded' });
        expect(api.untag).not.toHaveBeenCalled();
        expect(await countCleanupIntents(connection, 'owner')).toBe(0);
    });

    it.each(['replacement', 'stale_completion'] as const)('defers %s cleanup if scope becomes unknown during the ledger read', async (reason) => {
        Zotero.Beaver.account = { getGeneration: () => 1,
            getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        record.jobType = 'fulltext_untag';
        record.payload = { ...record.payload!, index_account_id: 'owner', index_scope_ref: 'g123',
            index_local_id: 'DEVICE', doc_hash: 'a'.repeat(64), index_cleanup_reason: reason };
        await db.enqueueBackgroundJob({ ...record, now: Date.now() });
        vi.spyOn(db, 'getAttachmentProcessingState').mockImplementationOnce(async () => {
            Zotero.Beaver.libraryScopeInitialized = false;
            return null;
        });
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx))
            .toEqual({ kind: 'release', reason: 'access_changed' });
        expect(api.untag).not.toHaveBeenCalled();
        expect(await countCleanupIntents(connection, 'owner')).toBe(1);
    });

    describe.each(['replacement', 'stale_completion'] as const)('%s cleanup fencing', (reason) => {
        it.each(['account', 'generation', 'abort'] as const)('retains cleanup when %s changes during the ledger read', async (change) => {
            let userId = 'account-a';
            let generation = 1;
            const abort = new AbortController();
            ctx.externalAbortSignal = abort.signal;
            Zotero.Beaver.account = {
                getGeneration: () => generation,
                getSnapshot: () => ({ session: { user: { id: userId } } }),
            } as any;
            record.jobType = 'fulltext_untag';
            record.payload = { ...record.payload!, index_action: 'untag',
                index_cleanup_reason: reason, doc_hash: 'a'.repeat(64),
                index_account_id: userId, index_scope_ref: 'g123', index_local_id: 'OLDDEVICE' };
            await db.enqueueBackgroundJob({ ...record, now: Date.now() });
            const acknowledge = vi.spyOn(db, 'acknowledgeIndexCleanup');
            let resolveRead!: (value: null) => void;
            vi.spyOn(db, 'getAttachmentProcessingState').mockImplementationOnce(() =>
                new Promise((resolve) => { resolveRead = resolve; }));
            const executing = new FulltextUpsertExecutor(api as any).execute(record, ctx);

            if (change === 'account') userId = 'account-b';
            if (change === 'generation') generation++;
            if (change === 'abort') abort.abort();
            resolveRead(null);

            expect(await executing).toEqual({ kind: 'release', reason: 'access_changed' });
            expect(api.untag).not.toHaveBeenCalled();
            expect(acknowledge).not.toHaveBeenCalled();
            expect(await countCleanupIntents(connection, 'account-a')).toBe(1);
        });
    });

    describe.each([undefined, 'exclusion', 'replacement', 'stale_completion'] as const)('%s remote identity', (reason) => {
        it.each(['same', 'scope', 'device'] as const)('only cancels cleanup for the same complete identity: %s', async (difference) => {
            const identity = { index_account_id: 'owner', index_scope_ref: 'g123', index_local_id: 'OLDDEVICE' };
            Zotero.Beaver.account = { getGeneration: () => 1,
                getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
            await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: record.zoteroKey,
                structuredDocumentHash: 'a'.repeat(64), upsertIndexVersion: '3',
                remoteIdentity: { ...identity,
                    index_scope_ref: difference === 'scope' ? 'g456' : identity.index_scope_ref,
                    index_local_id: difference === 'device' ? 'NEWDEVICE' : identity.index_local_id },
            });
            record.jobType = 'fulltext_untag';
            record.payload = { ...record.payload!, ...identity, doc_hash: 'a'.repeat(64),
                index_action: 'untag', index_cleanup_reason: reason };
            await db.enqueueBackgroundJob({ ...record, now: Date.now() });
            api.untag.mockResolvedValue({ results: [{ outcome: 'busy' }] });

            const result = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
            if (difference === 'same') {
                expect(result).toEqual({ kind: 'complete', reason: 'cleanup_superseded' });
                expect(api.untag).not.toHaveBeenCalled();
                expect(await countCleanupIntents(connection, 'owner')).toBe(0);
            } else {
                expect(result).toMatchObject({ kind: 'retry', error: 'index_untag_busy' });
                expect(api.untag).toHaveBeenCalledWith('OLDDEVICE', [{ scope_ref: 'g123',
                    zotero_key: record.zoteroKey, doc_hash: 'a'.repeat(64) }]);
                expect(await countCleanupIntents(connection, 'owner')).toBe(1);
            }
        });
    });

    it('does not acknowledge superseded cleanup after the account changes during its ledger read', async () => {
        let generation = 1;
        Zotero.Beaver.account = {
            getGeneration: () => generation,
            getSnapshot: () => ({ session: { user: { id: 'account-a' } } }),
        } as any;
        record.jobType = 'fulltext_untag';
        record.payload = { ...record.payload!, index_cleanup_reason: 'replacement',
            doc_hash: 'a'.repeat(64), index_account_id: 'account-a' };
        const acknowledge = vi.spyOn(db, 'acknowledgeIndexCleanup');
        const current = (await db.getAttachmentProcessingState(1, 'ABCDEFGH'))!;
        vi.spyOn(db, 'getAttachmentProcessingState').mockImplementationOnce(async () => {
            generation++;
            return { ...current, upsertStatus: 'done', upsertRemoteIdentity: {
                index_account_id: 'account-a', index_scope_ref: 'g123', index_local_id: 'OLDDEVICE',
            } };
        });
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx))
            .toEqual({ kind: 'release', reason: 'access_changed' });
        expect(api.untag).not.toHaveBeenCalled();
        expect(acknowledge).not.toHaveBeenCalled();
    });

    it('uses backend requirements when a later index generation is accepted', async () => {
        api.requirements.mockResolvedValue({ index_version: 4, extract_schema_versions: { pdf: ['4'] } });
        api.upsertHash.mockResolvedValue(response('tagged', 4));
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx)).toMatchObject({ reason: 'index_tagged' });
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({ upsertIndexVersion: '4' });
    });

    it('uses the hash-only tagged path and stamps stored versions', async () => {
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_tagged' });
        expect(api.upsertPayload).not.toHaveBeenCalled();
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({
            upsertStatus: 'done',
            upsertIndexVersion: '3',
        });
    });

    it('sends the payload when hash-only tagging finds an older index generation', async () => {
        api.upsertHash.mockResolvedValueOnce(response('tagged', 1));
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_completed' });
        expect(api.upsertPayload).toHaveBeenCalledTimes(1);
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({
            upsertStatus: 'done',
            upsertIndexVersion: '3',
        });
    });

    it('retries payload_required with the cached structured document', async () => {
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(409, 'Conflict', 'payload needed', 'payload_required'),
        );
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_completed' });
        expect(api.upsertPayload).toHaveBeenCalledWith(expect.objectContaining({
            doc_hash: 'a'.repeat(64),
            payload: expect.objectContaining({ schemaVersion: '4' }),
        }));
    });

    it.each([
        { priority: BACKGROUND_UPSERT_PRIORITY, extractionPriority: BACKGROUND_EXTRACT_PRIORITY },
        { priority: OCR_PRIORITY_ON_DEMAND, extractionPriority: OCR_PRIORITY_ON_DEMAND },
    ])('recovers a missing payload at priority $extractionPriority for an upsert at priority $priority', async ({ priority, extractionPriority }) => {
        record.priority = priority;
        enqueue.mockImplementation((job) => db.enqueueBackgroundJob(job));
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(409, 'Conflict', 'payload needed', 'payload_required'),
        );
        (Zotero.Beaver.documentCache!.getResult as any).mockResolvedValueOnce(null);
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'defer', reason: 'payload_cache_miss' });
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
            jobType: 'document_extract',
            zoteroKey: 'ABCDEFGH',
            priority: extractionPriority,
        }));
        // Paused processing only claims jobs below the background priority ceiling.
        const recovery = await db.claimNextBackgroundJob(Date.now(), 60_000, 100, ['document_extract']);
        if (priority === OCR_PRIORITY_ON_DEMAND) {
            expect(recovery).toMatchObject({ jobType: 'document_extract', priority });
        } else {
            expect(recovery).toBeNull();
        }
    });

    it('keeps a paused index retry queued through OCR cache recovery and indexes after OCR completes', async () => {
        enqueue.mockImplementation((job) => db.enqueueBackgroundJob(job));
        const executor = new FulltextUpsertExecutor(api as any);
        const now = Date.now();
        await db.enqueueBackgroundJob({ ...record, priority: OCR_PRIORITY_ON_DEMAND, now });
        const claim = (time: number) => db.claimNextBackgroundJob(time, 60_000, 100, ['fulltext_upsert']);
        const first = (await claim(now))!;
        expect(first).toMatchObject({ priority: OCR_PRIORITY_ON_DEMAND });
        api.upsertHash.mockRejectedValueOnce(new ApiError(409, 'Conflict', 'payload needed', 'payload_required'));
        (Zotero.Beaver.documentCache!.getResult as any).mockResolvedValueOnce(null);
        expect(await executor.execute(first, ctx)).toEqual({ kind: 'defer', reason: 'payload_cache_miss' });

        // Extraction of the original scan needs OCR before it has an indexable hash.
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET structured_document_hash = NULL, ocr_status = 'needed'`);
        const waiting = (await claim(now + 60_001))!;
        expect(await executor.execute(waiting, ctx)).toEqual({ kind: 'defer', reason: 'waiting_for_ocr' });
        expect(api.upsertHash).toHaveBeenCalledTimes(1);

        expect(await db.markAttachmentOcrDone({
            libraryId: 1, zoteroKey: 'ABCDEFGH', fileHash: 'file-md5',
            ocrEngineVersion: '1', structuredDocumentHash: 'a'.repeat(64),
            expectedOcrStatus: 'needed', expectedOcrEngineVersion: null, expectedExtractStatus: 'done',
        })).toBe(true);
        // No replacement upsert is produced: the original request survives at its priority.
        const ready = (await claim(now + 120_002))!;
        expect(ready).toMatchObject({ id: first.id, priority: OCR_PRIORITY_ON_DEMAND });
        expect(await executor.execute(ready, ctx)).toEqual({ kind: 'complete', reason: 'index_tagged' });
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({ upsertStatus: 'done' });
    });

    it.each(['failed', 'na'])('does not wait for OCR when its status is %s and no document hash exists', async (ocrStatus) => {
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET structured_document_hash = NULL, ocr_status = ?`, [ocrStatus]);
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx))
            .toEqual({ kind: 'complete', reason: 'ledger_not_ready' });
    });

    it('executes a dedicated untag job without requiring an accessible local library', async () => {
        Zotero.Beaver.account = { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        record.payload = { ...record.payload!, index_account_id: 'owner', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' };
        record.jobType = 'fulltext_untag';
        record.payload = {
            ...record.payload!,
            index_action: 'untag',
            doc_hash: 'b'.repeat(64),
        } as any;
        api.untag.mockResolvedValueOnce({
            results: [{
                scope_ref: 'lLOCAL123',
                zotero_key: 'ABCDEFGH',
                doc_hash: 'b'.repeat(64),
                outcome: 'untagged',
            }],
        });

        const outcome = await new FulltextUpsertExecutor(
            api as any,
            'fulltext_untag',
        ).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_untagged' });
        expect(api.untag).toHaveBeenCalledWith('LOCAL123', [{
            scope_ref: 'lLOCAL123',
            zotero_key: 'ABCDEFGH',
            doc_hash: 'b'.repeat(64),
        }]);
    });

    it.each(['deleted', 'replaced', 'restored', 'acquiring'] as const)('re-inclusion checks the exact exclusion reference: %s', async (state) => {
        const identity = { index_account_id: 'owner', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' };
        Zotero.Beaver.account = { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'owner' } } }) } as any;
        record.jobType = 'fulltext_untag';
        record.payload = { ...record.payload!, ...identity, index_action: 'untag',
            index_cleanup_reason: 'exclusion', doc_hash: 'a'.repeat(64) };
        await db.enqueueBackgroundJob({ ...record, now: Date.now() });
        // Exclusion purges the ledger; re-inclusion may discover nothing, a
        // replacement, or the exact content whose removal was queued.
        await db.deleteAttachmentProcessingStatesByLibrary(1);
        if (state !== 'deleted') {
            const hash = (state === 'replaced' ? 'b' : 'a').repeat(64);
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: record.zoteroKey, contentKind: 'pdf' });
            await db.markAttachmentExtracted({ libraryId: 1, zoteroKey: record.zoteroKey,
                expectedFileMtimeMs: null, expectedFileSizeBytes: null, previousDocumentHash: null,
                expectedExtractStatus: null, fileMtimeMs: 1, fileSizeBytes: 2,
                fileHash: 'file-md5', structuredDocumentHash: hash, extractSchemaVersion: '4', ocrStatus: 'na' });
            await db.recordAttachmentIndexIdentity(1, record.zoteroKey, hash, identity);
            if (state !== 'acquiring') await db.markAttachmentUpsertDone({
                libraryId: 1, zoteroKey: record.zoteroKey, structuredDocumentHash: hash,
                upsertIndexVersion: '3', remoteIdentity: identity,
            });
        }
        api.untag.mockResolvedValue({ results: [{ outcome: 'untagged' }] });
        const outcome = await new FulltextUpsertExecutor(api as any, 'fulltext_untag').execute(record, ctx);
        if (state === 'deleted' || state === 'replaced') {
            expect(outcome).toEqual({ kind: 'complete', reason: 'index_untagged' });
            expect(api.untag).toHaveBeenCalledWith(identity.index_local_id, [{
                scope_ref: identity.index_scope_ref, zotero_key: record.zoteroKey, doc_hash: 'a'.repeat(64),
            }]);
        } else {
            expect(outcome).toEqual(state === 'restored'
                ? { kind: 'complete', reason: 'cleanup_superseded' }
                : { kind: 'defer', reason: 'index_acquisition_pending' });
            expect(api.untag).not.toHaveBeenCalled();
        }
        expect(await countCleanupIntents(connection, 'owner')).toBe(state === 'acquiring' ? 1 : 0);
    });

    it('marks payload_too_large terminal and never retries it', async () => {
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(413, 'Payload Too Large', 'too large', 'payload_too_large'),
        );
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome.kind).toBe('failPermanent');
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertStatus)
            .toBe('failed');
    });

    it('honors a zero-second backend retry hint', async () => {
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(429, 'Rate Limited', 'retry', 'claim_busy', {
                retry_after_seconds: 0,
            }),
        );
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toMatchObject({
            kind: 'retry',
            retryAfterMs: 1_000,
        });
    });
});
