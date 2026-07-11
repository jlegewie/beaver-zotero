import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BeaverDB,
    BackgroundJobInput,
    BackgroundJobPayload,
} from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

function makeInput(overrides: Partial<BackgroundJobInput> = {}): BackgroundJobInput {
    const base: BackgroundJobInput = {
        jobType: 'document_extract',
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        contentKind: 'pdf',
        payloadKind: 'structured',
        priority: 100,
        payload: makePayload(),
        now: 1_000_000,
    };
    return { ...base, ...overrides };
}

function makePayload(overrides: Partial<BackgroundJobPayload> = {}): BackgroundJobPayload {
    return {
        content_kind: 'pdf',
        maxPages: 200,
        maxFileSizeMB: 50,
        timeoutSeconds: 120,
        ...overrides,
    };
}

describe('BeaverDB background queue', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('dedupes a second enqueue for the same job identity and lowers priority/availability', async () => {
        const first = await db.enqueueBackgroundJob(
            makeInput({ priority: 200, now: 5_000 }),
        );
        expect(first.enqueued).toBe(true);
        const id = first.id;
        expect(id).toBeGreaterThan(0);

        const second = await db.enqueueBackgroundJob(
            makeInput({ priority: 50, now: 3_000 }),
        );
        expect(second.enqueued).toBe(false);
        expect(second.id).toBe(id);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].priority).toBe(50);
        expect(rows[0].availableAt).toBe(3_000);
    });

    it('keeps separate rows for different payload kinds on the same attachment', async () => {
        await db.enqueueBackgroundJob(
            makeInput({ payloadKind: 'structured', priority: 100 }),
        );
        await db.enqueueBackgroundJob(
            makeInput({ payloadKind: 'markdown', priority: 100 }),
        );

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(2);
        const payloadKinds = rows.map((r) => r.payloadKind).sort();
        expect(payloadKinds).toEqual(['markdown', 'structured']);
    });

    it('keeps separate rows for different payload kinds and merges the same identity', async () => {
        await db.enqueueBackgroundJob(makeInput({ payloadKind: 'structured' }));
        await db.enqueueBackgroundJob(makeInput({ payloadKind: 'markdown' }));

        const sameIdentity = await db.enqueueBackgroundJob(
            makeInput({ payloadKind: 'structured', priority: 10, now: 500 }),
        );

        expect(sameIdentity.enqueued).toBe(false);
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.payloadKind === 'structured')?.priority).toBe(10);
    });

    it('updates content kind and payload together when a merged row changes kind', async () => {
        const first = await db.enqueueBackgroundJob(
            makeInput({
                contentKind: 'epub',
                payloadKind: 'structured',
                payload: null,
                priority: 50,
                now: 1_000,
            }),
        );
        await db.failBackgroundJob(first.id, 'old failure', {
            maxAttempts: 5,
            backoffMs: () => 60_000,
            now: 2_000,
        });

        const second = await db.enqueueBackgroundJob(
            makeInput({
                contentKind: 'pdf',
                payloadKind: 'structured',
                payload: makePayload({ timeoutSeconds: 999 }),
                priority: 50,
                now: 3_000,
            }),
        );

        expect(second.enqueued).toBe(false);
        expect(second.id).toBe(first.id);
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].contentKind).toBe('pdf');
        expect(rows[0].payload).toMatchObject({
            content_kind: 'pdf',
            timeoutSeconds: 999,
        });
        expect(rows[0].attemptCount).toBe(0);
        expect(rows[0].lastError).toBeNull();
    });

    it('preserves current background queue tables on upgrade from an unversioned install', async () => {
        const first = await db.enqueueBackgroundJob(makeInput({ now: 10_000 }));
        const raw = conn.getRawDB();
        raw.exec(`DELETE FROM schema_versions WHERE component = 'background_jobs'`);

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        const rows = await rebuilt.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(first.id);
        expect(rows[0].zoteroKey).toBe('ABCD1234');
        const version = raw
            .prepare(`SELECT version FROM schema_versions WHERE component = 'background_jobs'`)
            .get() as { version: number };
        expect(version.version).toBe(2);
    });

    it('rebuilds the background queue with the current unique key on upgrade from an unversioned install', async () => {
        await conn.closeDatabase();
        conn = new MockDBConnection();
        const raw = conn.getRawDB();
        raw.exec(`
            CREATE TABLE background_jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type        TEXT NOT NULL,
                library_id      INTEGER NOT NULL,
                item_id         INTEGER,
                zotero_key      TEXT NOT NULL,
                content_kind    TEXT NOT NULL,
                payload_kind    TEXT NOT NULL,
                priority        INTEGER NOT NULL DEFAULT 100,
                payload_json    TEXT,
                enqueued_at     INTEGER NOT NULL,
                available_at    INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL DEFAULT 0,
                last_error      TEXT,
                UNIQUE(library_id, zotero_key, payload_kind)
            );
            CREATE TABLE background_jobs_dead (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type        TEXT NOT NULL,
                library_id      INTEGER NOT NULL,
                zotero_key      TEXT NOT NULL,
                content_kind    TEXT NOT NULL,
                payload_kind    TEXT NOT NULL,
                payload_json    TEXT,
                enqueued_at     INTEGER NOT NULL,
                died_at         INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL,
                last_error      TEXT
            );
        `);
        db = new BeaverDB(conn);

        await db.initDatabase('0.99.0');

        const uniqueIndexes = raw
            .prepare(`SELECT name FROM pragma_index_list('background_jobs') WHERE [unique] = 1`)
            .all() as Array<{ name: string }>;
        const keys = uniqueIndexes.map((index) =>
            (raw
                .prepare(`SELECT name FROM pragma_index_info('${index.name.replace(/'/g, "''")}') ORDER BY seqno`)
                .all() as Array<{ name: string }>)
                .map((column) => column.name),
        );
        expect(keys).toContainEqual([
            'job_type',
            'library_id',
            'zotero_key',
            'payload_kind',
            'dedupe_key',
        ]);
    });

    it('enqueueBackgroundJobs enqueues a batch in one call and returns results in input order', async () => {
        const results = await db.enqueueBackgroundJobs([
            makeInput({ zoteroKey: 'AAAAAAAA', priority: 100, now: 1_000 }),
            makeInput({ zoteroKey: 'BBBBBBBB', priority: 50, now: 2_000 }),
            makeInput({ zoteroKey: 'CCCCCCCC', priority: 75, now: 3_000 }),
        ]);

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.enqueued)).toEqual([true, true, true]);
        expect(results.every((r) => r.id > 0)).toBe(true);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.zoteroKey).sort()).toEqual([
            'AAAAAAAA',
            'BBBBBBBB',
            'CCCCCCCC',
        ]);
    });

    it('enqueueBackgroundJobs dedupes repeated jobs with the single-job merge semantics', async () => {
        const results = await db.enqueueBackgroundJobs([
            makeInput({ zoteroKey: 'AAAAAAAA', priority: 200, now: 5_000 }),
            makeInput({ zoteroKey: 'AAAAAAAA', priority: 50, now: 3_000 }),
            makeInput({ zoteroKey: 'AAAAAAAA', priority: 75, now: 4_000 }),
        ]);

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.enqueued)).toEqual([true, false, false]);
        expect(results[1].id).toBe(results[0].id);
        expect(results[2].id).toBe(results[0].id);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].priority).toBe(50);
        expect(rows[0].availableAt).toBe(3_000);
    });

    it('enqueueBackgroundJobs returns an empty result for an empty batch', async () => {
        await expect(db.enqueueBackgroundJobs([])).resolves.toEqual([]);
        await expect(db.peekBackgroundJobs()).resolves.toHaveLength(0);
    });

    it('claims jobs in (priority asc, available_at asc) order and bumps availability', async () => {
        await db.enqueueBackgroundJob(
            makeInput({ zoteroKey: 'AAAAAAAA', priority: 100, now: 10_000 }),
        );
        await db.enqueueBackgroundJob(
            makeInput({ zoteroKey: 'BBBBBBBB', priority: 50, now: 20_000 }),
        );
        await db.enqueueBackgroundJob(
            makeInput({ zoteroKey: 'CCCCCCCC', priority: 50, now: 15_000 }),
        );

        const now = 30_000;
        const visibility = 60_000;
        const claimed1 = await db.claimNextBackgroundJob(now, visibility);
        expect(claimed1?.zoteroKey).toBe('CCCCCCCC');
        expect(claimed1?.availableAt).toBe(now + visibility);

        const claimed2 = await db.claimNextBackgroundJob(now, visibility);
        expect(claimed2?.zoteroKey).toBe('BBBBBBBB');

        const claimed3 = await db.claimNextBackgroundJob(now, visibility);
        expect(claimed3?.zoteroKey).toBe('AAAAAAAA');

        // No remaining visible jobs (all bumped to now + visibility).
        const claimed4 = await db.claimNextBackgroundJob(now, visibility);
        expect(claimed4).toBeNull();
    });

    it('claimNextBackgroundJob can filter by job type without starving other lanes', async () => {
        await db.enqueueBackgroundJob(
            makeInput({ jobType: 'document_extract', zoteroKey: 'AAAAAAAA', priority: 100 }),
        );
        await db.enqueueBackgroundJob(
            makeInput({ jobType: 'document_ocr', zoteroKey: 'BBBBBBBB', priority: 10 }),
        );

        const now = 1_000_000;
        const visibility = 60_000;
        const extract = await db.claimNextBackgroundJob(
            now,
            visibility,
            undefined,
            ['document_extract'],
        );
        expect(extract?.jobType).toBe('document_extract');
        expect(extract?.zoteroKey).toBe('AAAAAAAA');

        const noExtract = await db.claimNextBackgroundJob(
            now,
            visibility,
            undefined,
            ['document_extract'],
        );
        expect(noExtract).toBeNull();

        const ocr = await db.claimNextBackgroundJob(
            now,
            visibility,
            undefined,
            ['document_ocr'],
        );
        expect(ocr?.jobType).toBe('document_ocr');
        expect(ocr?.zoteroKey).toBe('BBBBBBBB');
    });

    describe('maxPriority gate', () => {
        it('with maxPriority=100, skips priority-100 jobs and claims only lower-priority ones', async () => {
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'AAAAAAAA', priority: 100, now: 10_000 }),
            );
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'BBBBBBBB', priority: 50, now: 20_000 }),
            );

            const now = 30_000;
            const visibility = 60_000;
            const claim = await db.claimNextBackgroundJob(now, visibility, 100);
            expect(claim?.zoteroKey).toBe('BBBBBBBB');

            // The priority-100 row is left untouched.
            const next = await db.claimNextBackgroundJob(now, visibility, 100);
            expect(next).toBeNull();
            const rows = await db.peekBackgroundJobs();
            const remaining = rows.find((r) => r.zoteroKey === 'AAAAAAAA');
            expect(remaining).toBeTruthy();
            expect(remaining!.availableAt).toBe(10_000);
        });

        it('with maxPriority=undefined, any priority is claimed (preserves existing behavior)', async () => {
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'AAAAAAAA', priority: 100, now: 10_000 }),
            );

            const claim = await db.claimNextBackgroundJob(30_000, 60_000);
            expect(claim?.zoteroKey).toBe('AAAAAAAA');
        });

        it('within the eligible set, ordering is still (priority ASC, available_at ASC)', async () => {
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'AAAAAAAA', priority: 99, now: 10_000 }),
            );
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'BBBBBBBB', priority: 50, now: 20_000 }),
            );
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'CCCCCCCC', priority: 50, now: 15_000 }),
            );
            // Out-of-gate row that must be ignored.
            await db.enqueueBackgroundJob(
                makeInput({ zoteroKey: 'DDDDDDDD', priority: 100, now: 5_000 }),
            );

            const now = 30_000;
            const visibility = 60_000;
            const c1 = await db.claimNextBackgroundJob(now, visibility, 100);
            expect(c1?.zoteroKey).toBe('CCCCCCCC');
            const c2 = await db.claimNextBackgroundJob(now, visibility, 100);
            expect(c2?.zoteroKey).toBe('BBBBBBBB');
            const c3 = await db.claimNextBackgroundJob(now, visibility, 100);
            expect(c3?.zoteroKey).toBe('AAAAAAAA');
            const c4 = await db.claimNextBackgroundJob(now, visibility, 100);
            expect(c4).toBeNull();
        });
    });

    it('hides claimed jobs until the visibility timeout expires', async () => {
        await db.enqueueBackgroundJob(makeInput({ now: 1_000 }));

        const claim = await db.claimNextBackgroundJob(2_000, 5_000);
        expect(claim).not.toBeNull();

        const tooEarly = await db.claimNextBackgroundJob(3_000, 5_000);
        expect(tooEarly).toBeNull();

        const onTime = await db.claimNextBackgroundJob(8_000, 5_000);
        expect(onTime?.id).toBe(claim?.id);
    });

    it('completeBackgroundJob removes the row', async () => {
        await db.enqueueBackgroundJob(makeInput({ now: 0 }));
        const claim = await db.claimNextBackgroundJob(2_000, 5_000);
        expect(claim).not.toBeNull();
        await db.completeBackgroundJob(claim!.id);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(0);
    });

    it('failBackgroundJob bumps attempt_count and slides available_at out', async () => {
        await db.enqueueBackgroundJob(makeInput({ now: 0 }));
        const claim = await db.claimNextBackgroundJob(100, 1_000);
        expect(claim).not.toBeNull();

        const fail = await db.failBackgroundJob(claim!.id, 'boom', {
            maxAttempts: 5,
            backoffMs: (a) => a * 10_000,
            now: 10_000,
        });
        expect(fail.dead).toBe(false);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(1);
        expect(rows[0].lastError).toBe('boom');
        expect(rows[0].availableAt).toBe(10_000 + 10_000);
    });

    it('releaseBackgroundJob resets availability without bumping attempt_count', async () => {
        await db.enqueueBackgroundJob(makeInput({ now: 0 }));
        const claim = await db.claimNextBackgroundJob(100, 5_000);
        expect(claim).not.toBeNull();
        expect(claim!.attemptCount).toBe(0);
        expect(claim!.availableAt).toBe(100 + 5_000);

        await db.releaseBackgroundJob(claim!.id, 50);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(0);
        expect(rows[0].lastError).toBeNull();
        expect(rows[0].availableAt).toBe(50);
    });

    it('dead-letters the job once attempt_count + 1 >= maxAttempts', async () => {
        await db.enqueueBackgroundJob(makeInput({ now: 0 }));
        const claim = await db.claimNextBackgroundJob(100, 1_000);
        expect(claim).not.toBeNull();

        // First failure (attempt 1)
        let fail = await db.failBackgroundJob(claim!.id, 'first', {
            maxAttempts: 2,
            backoffMs: () => 0,
            now: 200,
        });
        expect(fail.dead).toBe(false);

        // Second failure (attempt 2) — exceeds maxAttempts of 2.
        fail = await db.failBackgroundJob(claim!.id, 'second', {
            maxAttempts: 2,
            backoffMs: () => 0,
            now: 300,
        });
        expect(fail.dead).toBe(true);

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(0);

        const deadRows: any[] = [];
        await (conn as any).queryAsync(
            'SELECT job_type, zotero_key, attempt_count, last_error, died_at FROM background_jobs_dead',
            [],
            {
                onRow: (row: any) => {
                    deadRows.push({
                        jobType: row.getResultByIndex(0),
                        zoteroKey: row.getResultByIndex(1),
                        attemptCount: row.getResultByIndex(2),
                        lastError: row.getResultByIndex(3),
                        diedAt: row.getResultByIndex(4),
                    });
                },
            },
        );
        expect(deadRows).toHaveLength(1);
        expect(deadRows[0].attemptCount).toBe(2);
        expect(deadRows[0].lastError).toBe('second');
        expect(deadRows[0].diedAt).toBe(300);
    });

    it('getBackgroundQueueStats reports pending / available / deferred / dead and byJobType', async () => {
        await db.enqueueBackgroundJob(
            makeInput({ zoteroKey: 'A0000000', now: 0 }),
        );
        await db.enqueueBackgroundJob(
            makeInput({ zoteroKey: 'B0000000', now: 100 }),
        );
        // Force one job into deferred-future via a fail.
        const claim = await db.claimNextBackgroundJob(50, 1_000);
        await db.failBackgroundJob(claim!.id, 'oops', {
            maxAttempts: 5,
            backoffMs: () => 1_000_000,
            now: 1_000,
        });

        const stats = await db.getBackgroundQueueStats(500);
        expect(stats.pending).toBe(2);
        expect(stats.available + stats.deferred).toBe(stats.pending);
        expect(stats.byJobType['document_extract']).toBe(2);
        expect(stats.dead).toBe(0);
    });

    it('stores epoch-ms timestamps as integers (not strings)', async () => {
        await db.enqueueBackgroundJob(makeInput({ now: 12345 }));
        const rows: any[] = [];
        await (conn as any).queryAsync(
            'SELECT enqueued_at, available_at FROM background_jobs',
            [],
            {
                onRow: (row: any) => {
                    rows.push({
                        enqueuedAt: row.getResultByIndex(0),
                        availableAt: row.getResultByIndex(1),
                    });
                },
            },
        );
        expect(rows).toHaveLength(1);
        expect(typeof rows[0].enqueuedAt).toBe('number');
        expect(typeof rows[0].availableAt).toBe('number');
        expect(rows[0].enqueuedAt).toBe(12345);
        expect(rows[0].availableAt).toBe(12345);
    });

    it('records, increments, gates, and clears document processing failures by content hash', async () => {
        await db.recordDocumentProcessingFailure({
            fileHash: 'hash-a',
            task: 'ocr',
            engineVersion: 'engine-1',
            sourceType: 'zotero',
            sourceKey: '1-AAAAAAAA',
            error: 'first',
        });

        let record = await db.getDocumentProcessingFailure('hash-a', 'ocr', 'engine-1');
        expect(record).toMatchObject({
            fileHash: 'hash-a',
            task: 'ocr',
            engineVersion: 'engine-1',
            sourceType: 'zotero',
            sourceKey: '1-AAAAAAAA',
            failureCount: 1,
            terminalCode: null,
            lastError: 'first',
        });
        expect(
            await db.isDocumentProcessingReadyForRetry(
                'hash-a',
                'ocr',
                'engine-1',
                '0000-01-01 00:00:00',
            ),
        ).toBe(false);
        expect(
            await db.isDocumentProcessingReadyForRetry(
                'hash-a',
                'ocr',
                'engine-1',
                '9999-01-01 00:00:00',
            ),
        ).toBe(true);

        await db.recordDocumentProcessingFailure({
            fileHash: 'hash-a',
            task: 'ocr',
            engineVersion: 'engine-1',
            sourceType: 'zotero',
            sourceKey: '1-BBBBBBBB',
            error: 'second',
        });

        record = await db.getDocumentProcessingFailure('hash-a', 'ocr', 'engine-1');
        expect(record?.failureCount).toBe(2);
        expect(record?.lastError).toBe('second');
        expect(record?.sourceKey).toBe('1-BBBBBBBB');
        expect(await db.isDocumentProcessingPermanentlyFailed('hash-a', 'ocr', 'engine-1')).toBe(false);

        await db.recordDocumentProcessingFailure({
            fileHash: 'hash-a',
            task: 'ocr',
            engineVersion: 'engine-1',
            error: 'terminal',
            terminalCode: 'OCR_NO_TEXT',
        });

        record = await db.getDocumentProcessingFailure('hash-a', 'ocr', 'engine-1');
        expect(record?.terminalCode).toBe('OCR_NO_TEXT');
        expect(await db.isDocumentProcessingPermanentlyFailed('hash-a', 'ocr', 'engine-1')).toBe(true);
        expect(
            await db.isDocumentProcessingReadyForRetry(
                'hash-a',
                'ocr',
                'engine-1',
                '9999-01-01 00:00:00',
            ),
        ).toBe(false);

        await expect(
            db.getDocumentProcessingFailure('hash-a', 'ocr', 'engine-2'),
        ).resolves.toBeNull();

        await db.clearDocumentProcessingFailure('hash-a', 'ocr', 'engine-1');
        await expect(
            db.getDocumentProcessingFailure('hash-a', 'ocr', 'engine-1'),
        ).resolves.toBeNull();
    });

    it('atomically upserts concurrent document processing failures for the same content hash', async () => {
        await Promise.all([
            db.recordDocumentProcessingFailure({
                fileHash: 'hash-concurrent',
                task: 'ocr',
                engineVersion: 'engine-1',
                error: 'first',
            }),
            db.recordDocumentProcessingFailure({
                fileHash: 'hash-concurrent',
                task: 'ocr',
                engineVersion: 'engine-1',
                error: 'second',
            }),
        ]);

        const record = await db.getDocumentProcessingFailure(
            'hash-concurrent',
            'ocr',
            'engine-1',
        );
        expect(record?.failureCount).toBe(2);
        expect(record?.lastError).toBe('second');
    });

    it('does not create the unused document processing retry index', async () => {
        const indexes = conn
            .getRawDB()
            .prepare(`SELECT name FROM pragma_index_list('document_processing_failures')`)
            .all() as Array<{ name: string }>;

        expect(indexes.map((index) => index.name)).not.toContain(
            'idx_doc_proc_failures_retry',
        );
    });
});
