import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { DocumentCache } from '../../../src/services/documentCache';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { buildPdfCachedMetadata } from '@beaver/agent-core/extract/document/shared/contentKinds';

const mockIOUtils = (globalThis as any).IOUtils as {
    exists: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    makeDirectory: ReturnType<typeof vi.fn>;
    getChildren: ReturnType<typeof vi.fn>;
};

const CACHE_DIR = '/mock/profile/beaver/document-cache';
const BUDGET_PREF = 'extensions.zotero.beaver.documentCacheMaxBytes';

describe('DocumentCache size budget', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    let cache: DocumentCache;
    let files: Set<string>;
    let prefs: Record<string, unknown>;

    /**
     * Insert one metadata + payload row pair for `key` with an explicit
     * compressed size and access time, and register its file as present.
     */
    async function seedPayload(input: {
        key: string;
        libraryId?: number;
        sizeBytes: number;
        /** SQLite datetime string; null leaves the row never-read. */
        lastAccessedAt?: string | null;
        createdAt?: string;
    }): Promise<string> {
        const libraryId = input.libraryId ?? 1;
        const payloadPath = `${CACHE_DIR}/${libraryId}/${input.key}.structured.sha.json.gz`;
        const { metadata } = await db.upsertDocumentCacheMetadata({
            itemId: 1000 + input.key.charCodeAt(0),
            libraryId,
            zoteroKey: input.key,
            contentKind: 'pdf',
            filePath: `/tmp/${input.key}.pdf`,
            fileSignature: { mtime_ms: 10, size_bytes: 3 },
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            documentMetadata: buildPdfCachedMetadata(1, { 0: '1' }, null),
            errorCode: null,
            extractionSchemaVersion: '4',
            metadataFormatVersion: 1,
        });
        await db.upsertDocumentCachePayload({
            metadataId: metadata.id,
            itemId: metadata.itemId,
            libraryId,
            zoteroKey: input.key,
            payloadKind: 'structured',
            contentKind: 'pdf',
            sourceFilePath: `/tmp/${input.key}.pdf`,
            sourceFileSignature: { mtime_ms: 10, size_bytes: 3 },
            sourceSizeBytes: 3,
            payloadPath,
            payloadSizeBytes: input.sizeBytes,
            payloadSha256: null,
            extractionSchemaVersion: '4',
            cacheFormatVersion: 1,
        });
        await conn.queryAsync(
            `UPDATE document_cache_payloads
             SET last_accessed_at = ?, created_at = ?
             WHERE library_id = ? AND zotero_key = ?`,
            [
                input.lastAccessedAt ?? null,
                input.createdAt ?? '2024-01-01 00:00:00',
                libraryId,
                input.key,
            ],
        );
        files.add(payloadPath);
        return payloadPath;
    }

    /**
     * Bulk-insert `count` metadata + payload row pairs of equal size, oldest
     * first, keyed `K<index>`. Writes rows directly to stay fast enough for
     * the multi-batch cases.
     */
    async function seedManyPayloads(count: number, sizeBytes: number): Promise<string[]> {
        const keys: string[] = [];
        for (let i = 0; i < count; i++) {
            const key = `K${String(i).padStart(6, '0')}`;
            keys.push(key);
            const created = new Date(Date.UTC(2024, 0, 1) + i * 1000)
                .toISOString()
                .replace('T', ' ')
                .slice(0, 19);
            await conn.queryAsync(
                `INSERT INTO document_cache_metadata (
                    item_id, library_id, zotero_key, content_kind, file_path,
                    file_mtime_ms, file_size_bytes, source_size_bytes, content_type,
                    document_metadata_json, error_code, extraction_schema_version,
                    metadata_format_version
                 ) VALUES (?, 1, ?, 'pdf', ?, 10, 3, 3, 'application/pdf', ?, NULL, '4', 1)`,
                [
                    10_000 + i,
                    key,
                    `/tmp/${key}.pdf`,
                    JSON.stringify({ content_kind: 'pdf', pageCount: 1, pageLabels: null, pages: null }),
                ],
            );
            await conn.queryAsync(
                `INSERT INTO document_cache_payloads (
                    metadata_id, item_id, library_id, zotero_key, payload_kind,
                    content_kind, source_file_path, source_file_mtime_ms,
                    source_file_size_bytes, source_size_bytes, payload_path,
                    payload_size_bytes, payload_sha256, extraction_schema_version,
                    cache_format_version, created_at, last_accessed_at
                 ) SELECT id, item_id, 1, ?, 'structured', 'pdf', ?, 10, 3, 3, ?, ?, NULL, '4', 1, ?, NULL
                   FROM document_cache_metadata WHERE library_id = 1 AND zotero_key = ?`,
                [
                    key,
                    `/tmp/${key}.pdf`,
                    `${CACHE_DIR}/1/${key}.structured.sha.json.gz`,
                    sizeBytes,
                    created,
                    key,
                ],
            );
            files.add(`${CACHE_DIR}/1/${key}.structured.sha.json.gz`);
        }
        return keys;
    }

    /**
     * Same shape as `seedManyPayloads` but built from literal multi-row
     * INSERTs, fast enough for the tens-of-thousands-of-rows case.
     */
    async function seedManyPayloadsFast(count: number, sizeBytes: number): Promise<void> {
        const CHUNK = 500;
        for (let start = 0; start < count; start += CHUNK) {
            const end = Math.min(start + CHUNK, count);
            const metadataRows: string[] = [];
            const payloadRows: string[] = [];
            for (let i = start; i < end; i++) {
                const key = `K${String(i).padStart(6, '0')}`;
                const created = new Date(Date.UTC(2024, 0, 1) + i * 1000)
                    .toISOString()
                    .replace('T', ' ')
                    .slice(0, 19);
                const path = `${CACHE_DIR}/1/${key}.structured.sha.json.gz`;
                const id = i + 1;
                metadataRows.push(
                    `(${id}, ${10_000 + i}, 1, '${key}', 'pdf', '/tmp/${key}.pdf', 10, 3, 3,`
                    + ` 'application/pdf', '{"content_kind":"pdf","pageCount":1,`
                    + `"pageLabels":null,"pages":null}', NULL, '4', 1)`,
                );
                payloadRows.push(
                    `(${id}, ${10_000 + i}, 1, '${key}', 'structured', 'pdf',`
                    + ` '/tmp/${key}.pdf', 10, 3, 3, '${path}', ${sizeBytes}, NULL, '4', 1,`
                    + ` '${created}', NULL)`,
                );
                files.add(path);
            }
            await conn.queryAsync(
                `INSERT INTO document_cache_metadata (
                    id, item_id, library_id, zotero_key, content_kind, file_path,
                    file_mtime_ms, file_size_bytes, source_size_bytes, content_type,
                    document_metadata_json, error_code, extraction_schema_version,
                    metadata_format_version
                 ) VALUES ${metadataRows.join(',')}`,
            );
            await conn.queryAsync(
                `INSERT INTO document_cache_payloads (
                    metadata_id, item_id, library_id, zotero_key, payload_kind,
                    content_kind, source_file_path, source_file_mtime_ms,
                    source_file_size_bytes, source_size_bytes, payload_path,
                    payload_size_bytes, payload_sha256, extraction_schema_version,
                    cache_format_version, created_at, last_accessed_at
                 ) VALUES ${payloadRows.join(',')}`,
            );
        }
    }

    /** Insert one background_jobs row for `key`. */
    async function enqueueUpsertJob(
        key: string,
        availableAt = Date.now(),
        jobType = 'fulltext_upsert',
    ): Promise<void> {
        await conn.queryAsync(
            `INSERT INTO background_jobs (
                job_type, library_id, item_id, zotero_key, content_kind,
                payload_kind, dedupe_key, priority, payload_json,
                enqueued_at, available_at
             ) VALUES (?, 1, 1, ?, 'pdf', 'structured', '', 100, NULL, ?, ?)`,
            [jobType, key, Date.now(), availableAt],
        );
    }

    async function remainingKeys(): Promise<string[]> {
        const payloads = await db.getAllDocumentCachePayloads();
        return payloads.map((payload) => payload.zoteroKey).sort();
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        files = new Set<string>();
        prefs = { [BUDGET_PREF]: 1000 };
        mockIOUtils.exists.mockImplementation(async (path: string) => files.has(path));
        mockIOUtils.remove.mockImplementation(async (path: string) => { files.delete(path); });
        mockIOUtils.write.mockResolvedValue(undefined);
        mockIOUtils.makeDirectory.mockResolvedValue(undefined);
        mockIOUtils.getChildren?.mockResolvedValue([]);
        (globalThis as any).Zotero.Prefs.get = vi.fn((key: string) => prefs[key]);
        // `data.env` is read by the logger's development check.
        (globalThis as any).Zotero.Beaver = { data: { env: 'production' } };

        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
        cache = new DocumentCache(db);
        (cache as any).payloadCacheDir = CACHE_DIR;
    });

    afterEach(async () => {
        delete (globalThis as any).Zotero.Beaver;
        await conn.closeDatabase();
    });

    it('evicts payloads until the cache is within 90% of the budget', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:02' });
        await seedPayload({ key: 'CCCC3333', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:03' });

        const result = await cache.enforceSizeBudget();

        // 1200 > 1000, target is 900: evicting one 400-byte payload reaches 800.
        expect(result).toEqual({ evicted: 1, bytesFreed: 400 });
        expect(await db.getDocumentCachePayloadTotalBytes()).toBe(800);
        expect(await db.getDocumentCachePayloadTotalBytes()).toBeLessThanOrEqual(1000);
    });

    it('evicts the oldest COALESCE(last_accessed_at, created_at) first', async () => {
        await seedPayload({
            key: 'NEWREAD1',
            sizeBytes: 400,
            lastAccessedAt: '2024-03-01 00:00:00',
        });
        await seedPayload({
            key: 'OLDREAD1',
            sizeBytes: 400,
            lastAccessedAt: '2024-01-01 00:00:00',
        });
        // Never read, but written most recently: created_at is the sort key.
        await seedPayload({
            key: 'UNREAD01',
            sizeBytes: 400,
            lastAccessedAt: null,
            createdAt: '2024-06-01 00:00:00',
        });

        await cache.enforceSizeBudget();

        expect(await remainingKeys()).toEqual(['NEWREAD1', 'UNREAD01']);
    });

    it('leaves document_cache_metadata rows untouched', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        expect(await db.getDocumentCacheMetadataCount()).toBe(2);

        await cache.enforceSizeBudget();

        expect(await db.getDocumentCachePayloadCount()).toBe(1);
        expect(await db.getDocumentCacheMetadataCount()).toBe(2);
        const kept = await db.getDocumentCacheMetadataByKey(1, 'AAAA1111');
        expect(kept?.documentMetadata).not.toBeNull();
        expect(kept?.pageCount).toBe(1);
    });

    it('removes the payload file of an evicted row', async () => {
        const evictedPath = await seedPayload({
            key: 'AAAA1111',
            sizeBytes: 600,
            lastAccessedAt: '2024-01-01 00:00:01',
        });
        const keptPath = await seedPayload({
            key: 'BBBB2222',
            sizeBytes: 600,
            lastAccessedAt: '2024-01-01 00:00:02',
        });

        await cache.enforceSizeBudget();

        expect(files.has(evictedPath)).toBe(false);
        expect(files.has(keptPath)).toBe(true);
    });

    it('retains a payload a queued fulltext_upsert job is about to read', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        await enqueueUpsertJob('AAAA1111');

        await cache.enforceSizeBudget();

        // The oldest payload owes the index an upload, so the next one goes.
        expect(await remainingKeys()).toEqual(['AAAA1111']);
    });

    it('retains a deferred or in-flight upsert job (available_at in the future)', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        // Claiming a job only pushes available_at forward; the row stays.
        await enqueueUpsertJob('AAAA1111', Date.now() + 600_000);

        await cache.enforceSizeBudget();

        expect(await remainingKeys()).toEqual(['AAAA1111']);
    });

    it('evicts a payload with no queued upsert job', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        // An extract job for the same attachment does not read the payload.
        await enqueueUpsertJob('AAAA1111', undefined, 'document_extract');

        await cache.enforceSizeBudget();

        expect(await remainingKeys()).toEqual(['BBBB2222']);
    });

    it('skips a payload whose attachment holds an extraction lock', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        (cache as any).extractionLocks.set(
            '1/AAAA1111/structured/sig/scope:default',
            { settled: false },
        );

        await cache.enforceSizeBudget();

        expect(await remainingKeys()).toEqual(['AAAA1111']);
    });

    it('skips a payload whose attachment holds a write lock', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        (cache as any).writeLocks.set('1/AAAA1111/structured', Promise.resolve());

        await cache.enforceSizeBudget();

        expect(await remainingKeys()).toEqual(['AAAA1111']);
    });

    it('is a no-op when the budget pref is 0', async () => {
        prefs[BUDGET_PREF] = 0;
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });

        const result = await cache.enforceSizeBudget();

        expect(result).toEqual({ evicted: 0, bytesFreed: 0 });
        expect(await db.getDocumentCachePayloadCount()).toBe(2);
    });

    it('is a no-op when the budget pref is missing', async () => {
        delete prefs[BUDGET_PREF];
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });

        expect(await cache.enforceSizeBudget()).toEqual({ evicted: 0, bytesFreed: 0 });
        expect(await db.getDocumentCachePayloadCount()).toBe(2);
    });

    it('is a no-op when the cache already fits the budget', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:01' });

        const result = await cache.enforceSizeBudget();

        expect(result).toEqual({ evicted: 0, bytesFreed: 0 });
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });

    it('keeps evicting past the first batch until the target is reached', async () => {
        // 1200 x 1000 B = 1,200,000; budget 500,000 -> target 450,000 needs
        // 750 evictions, more than one 500-row batch can supply.
        await seedManyPayloads(1200, 1000);
        prefs[BUDGET_PREF] = 500_000;

        const result = await cache.enforceSizeBudget();

        expect(result.evicted).toBe(750);
        expect(await db.getDocumentCachePayloadTotalBytes()).toBe(450_000);
        expect(await db.getDocumentCachePayloadCount()).toBe(450);
    });

    it('walks past retained rows that span a batch boundary', async () => {
        // The oldest 510 payloads are pinned by queued upsert jobs, so the
        // pass must advance beyond two batch reads to find evictable rows.
        const keys = await seedManyPayloads(700, 1000);
        for (const key of keys.slice(0, 510)) await enqueueUpsertJob(key);
        prefs[BUDGET_PREF] = 600_000;

        const result = await cache.enforceSizeBudget();

        expect(result.evicted).toBe(160);
        expect(await db.getDocumentCachePayloadTotalBytes()).toBe(540_000);
        const remaining = new Set(await remainingKeys());
        for (const key of keys.slice(0, 510)) expect(remaining.has(key)).toBe(true);
    });

    it('keeps walking batches until the target is met, with no row ceiling', async () => {
        // The oldest 2500 payloads are pinned, so reaching the target requires
        // walking six batches. Nothing schedules a continuation pass, so the
        // walk must not give up early.
        const keys = await seedManyPayloads(3000, 1000);
        for (const key of keys.slice(0, 2500)) await enqueueUpsertJob(key);
        prefs[BUDGET_PREF] = 2_800_000;

        const result = await cache.enforceSizeBudget();

        // 3,000,000 -> target 2,520,000 needs 480 evictions from the 500
        // unpinned rows that sit past offset 2500.
        expect(result.evicted).toBe(480);
        expect(await db.getDocumentCachePayloadTotalBytes()).toBe(2_520_000);
        const remaining = new Set(await remainingKeys());
        for (const key of keys.slice(0, 2500)) expect(remaining.has(key)).toBe(true);
    });

    it('drives a cache tens of thousands of payloads over budget down to target', async () => {
        // 21,000 x 1000 B = 21,000,000; budget 500,000 -> target 450,000 needs
        // 20,550 evictions. A pass that gave up after a fixed number of rows
        // would leave the cache far above its budget with nothing to retry it.
        await seedManyPayloadsFast(21_000, 1000);
        prefs[BUDGET_PREF] = 500_000;

        const result = await cache.enforceSizeBudget();

        expect(result.evicted).toBe(20_550);
        expect(await db.getDocumentCachePayloadTotalBytes()).toBe(450_000);
    }, 60_000);

    it('runs a follow-up pass for a payload written while a pass is in flight', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:02' });

        // Hold the first pass open, then simulate a write landing mid-pass.
        // That write is invisible to the running pass, so only a follow-up can
        // bring the cache back within budget.
        let releasePass: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { releasePass = resolve; });
        const totalBytes = vi.spyOn(db, 'getDocumentCachePayloadTotalBytes');
        totalBytes.mockImplementationOnce(async () => {
            await gate;
            return 800;
        });

        const first = cache.enforceSizeBudget();
        await seedPayload({ key: 'CCCC3333', sizeBytes: 900, lastAccessedAt: '2024-01-01 00:00:03' });
        (cache as any).scheduleSizeBudgetPass(900);
        releasePass();
        await first;
        // Drain the follow-up chained behind the first pass.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await (cache as any).budgetPass;

        // 1700 B against a 1000 B budget: the follow-up must evict down to 900.
        expect(await db.getDocumentCachePayloadTotalBytes()).toBeLessThanOrEqual(900);
    });

    it('evicts nothing when the retention lookup fails', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 600, lastAccessedAt: '2024-01-01 00:00:02' });
        vi.spyOn(db, 'getPendingFulltextUpsertKeys')
            .mockRejectedValue(new Error('queue read failed'));

        const result = await cache.enforceSizeBudget();

        expect(result).toEqual({ evicted: 0, bytesFreed: 0 });
        expect(await db.getDocumentCachePayloadCount()).toBe(2);
    });

    it('stops cleanly when every candidate is retained', async () => {
        const keys = await seedManyPayloads(600, 1000);
        for (const key of keys) await enqueueUpsertJob(key);
        prefs[BUDGET_PREF] = 300_000;

        const result = await cache.enforceSizeBudget();

        expect(result).toEqual({ evicted: 0, bytesFreed: 0 });
        expect(await db.getDocumentCachePayloadCount()).toBe(600);
    });

    it('orders the eviction scan from an index instead of sorting the table', async () => {
        // EXPLAIN is not a SELECT, so it cannot go through queryAsync's reader
        // path; reach the better-sqlite3 handle directly for the plan.
        const rows = (conn as any).db
            .prepare(
                `EXPLAIN QUERY PLAN
                 SELECT id FROM document_cache_payloads
                 ORDER BY COALESCE(last_accessed_at, created_at) ASC, id ASC
                 LIMIT 500 OFFSET 1000`,
            )
            .all() as Array<{ detail: string }>;
        const detail = rows.map((row) => row.detail).join('\n');
        expect(detail).toContain('idx_dcp_lru');
        expect(detail).not.toContain('TEMP B-TREE FOR ORDER BY');
    });

    it('reports total and budget bytes in getStats', async () => {
        await seedPayload({ key: 'AAAA1111', sizeBytes: 400, lastAccessedAt: '2024-01-01 00:00:01' });
        await seedPayload({ key: 'BBBB2222', sizeBytes: 250, lastAccessedAt: '2024-01-01 00:00:02' });

        const stats = await cache.getStats();

        expect(stats.payload_total_bytes).toBe(650);
        expect(stats.payload_budget_bytes).toBe(1000);
        expect(stats.payload_count).toBe(2);
    });
});
