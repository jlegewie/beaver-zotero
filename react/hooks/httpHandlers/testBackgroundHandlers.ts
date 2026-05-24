/**
 * Dev-only HTTP handlers for the background extraction queue.
 *
 * Exercises the queue API on `Zotero.Beaver?.db` plus the lifecycle on
 * `Zotero.Beaver?.backgroundExtractor`. All endpoints are wired via the
 * `process.env.NODE_ENV === 'development'` branch in `useHttpEndpoints.ts`.
 */

import type {
    BackgroundJobInput,
    BackgroundJobPayload,
    BackgroundJobType,
    BackgroundJobRecord,
} from '../../../src/services/database';

interface EnqueueRequest {
    library_id?: number;
    zotero_key?: string;
    mode?: 'structured' | 'markdown';
    job_type?: BackgroundJobType;
    priority?: number;
    payload?: BackgroundJobPayload | null;
    item_id?: number | null;
}

export async function handleTestBackgroundEnqueueHttpRequest(
    request: EnqueueRequest = {},
) {
    const db = Zotero.Beaver?.db;
    if (!db) return { ok: false, error: 'db not available' };
    const {
        library_id,
        zotero_key,
        mode,
        job_type,
        priority,
        payload,
        item_id,
    } = request;
    if (library_id == null || !zotero_key || !mode || !job_type) {
        return {
            ok: false,
            error: 'Provide library_id, zotero_key, mode, job_type',
        };
    }
    const input: BackgroundJobInput = {
        jobType: job_type,
        libraryId: library_id,
        itemId: item_id ?? null,
        zoteroKey: zotero_key,
        mode,
        priority,
        payload: payload ?? null,
        now: Date.now(),
    };
    const result = await db.enqueueBackgroundJob(input);
    return { ok: true, enqueued: result.enqueued, id: result.id };
}

export async function handleTestBackgroundStatsHttpRequest(_request: unknown) {
    const db = Zotero.Beaver?.db;
    if (!db) return { ok: false, error: 'db not available' };
    const queue = await db.getBackgroundQueueStats(Date.now());
    const { getExistingMuPDFWorkerClient } = await import(
        '../../../src/beaver-extract/MuPDFWorkerClient'
    );
    const hot = getExistingMuPDFWorkerClient('hot');
    const background = getExistingMuPDFWorkerClient('background');
    return {
        ok: true,
        queue,
        workers: {
            hot: hot?.getStats() ?? null,
            background: background?.getStats() ?? null,
        },
    };
}

export async function handleTestBackgroundPeekHttpRequest(
    request: { limit?: number } = {},
) {
    const db = Zotero.Beaver?.db;
    if (!db) return { ok: false, error: 'db not available' };
    const rows: BackgroundJobRecord[] = await db.peekBackgroundJobs(
        typeof request?.limit === 'number' ? request.limit : undefined,
    );
    return { ok: true, jobs: rows };
}

export async function handleTestBackgroundProcessOnceHttpRequest(
    _request: unknown,
) {
    const processor = Zotero.Beaver?.backgroundExtractor;
    if (!processor) {
        return { ok: false, error: 'backgroundExtractor not available' };
    }
    const result = await processor.processOnce();
    return { ok: true, ...result };
}

/**
 * Dev-only: purge both the live queue and the dead-letter table. Lets
 * live tests start each case from a known-empty state. Direct SQL is used
 * to avoid expanding the production-facing `BeaverDB` surface.
 */
export async function handleTestBackgroundClearHttpRequest(_request: unknown) {
    const db = Zotero.Beaver?.db;
    if (!db) return { ok: false, error: 'db not available' };
    const conn = (db as unknown as { conn: { queryAsync: (sql: string) => Promise<unknown> } }).conn;
    if (!conn?.queryAsync) return { ok: false, error: 'db connection unavailable' };
    await conn.queryAsync(`DELETE FROM background_jobs`);
    await conn.queryAsync(`DELETE FROM background_jobs_dead`);
    return { ok: true };
}
