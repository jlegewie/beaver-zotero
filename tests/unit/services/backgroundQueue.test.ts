import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BeaverDB,
    BackgroundJobInput,
    BackgroundJobPayload,
} from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

function makeInput(overrides: Partial<BackgroundJobInput> = {}): BackgroundJobInput {
    const base: BackgroundJobInput = {
        jobType: 'hot_timeout_retry',
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        mode: 'structured',
        priority: 100,
        payload: makePayload(),
        now: 1_000_000,
    };
    return { ...base, ...overrides };
}

function makePayload(overrides: Partial<BackgroundJobPayload> = {}): BackgroundJobPayload {
    return {
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

    it('dedupes a second enqueue for the same (library, key, mode) and lowers priority/availability', async () => {
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

    it('keeps separate rows for different modes on the same attachment', async () => {
        await db.enqueueBackgroundJob(
            makeInput({ mode: 'structured', priority: 100 }),
        );
        await db.enqueueBackgroundJob(
            makeInput({ mode: 'markdown', priority: 100 }),
        );

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(2);
        const modes = rows.map((r) => r.mode).sort();
        expect(modes).toEqual(['markdown', 'structured']);
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
        expect(stats.byJobType['hot_timeout_retry']).toBe(2);
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
});
