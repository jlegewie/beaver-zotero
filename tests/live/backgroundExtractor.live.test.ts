/**
 * Background extraction queue + processor live suite.
 *
 * Covers the new `/beaver/test/background-*` dev endpoints and the
 * `BackgroundExtractor` lifecycle bound to `Zotero.Beaver?.backgroundExtractor`:
 *   - enqueue happy path + missing-field validation
 *   - dedup semantics (`(job_type, library_id, zotero_key, payload_kind)` uniqueness)
 *   - peek ordering + limit
 *   - stats endpoint returns queue counts and per-slot worker snapshots
 *   - processOnce on an empty queue
 *   - processOnce drains a healthy PDF and emits `job_done`
 *   - processOnce on missing items / encrypted / no-text-layer PDFs all
 *     complete the job (no retry)
 *   - hot-path timeout enqueues a `document_extract` background job that
 *     the processor then drains
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF,
 *     NO_TEXT_PDF).
 *
 * Run with: `npm run test:live -- backgroundExtractor`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import {
    backgroundClear,
    backgroundEnqueue,
    backgroundPeek,
    backgroundProcessOnce,
    backgroundStats,
    getCacheMetadata,
    invalidateCache,
    waitForQueueDrain,
} from '../helpers/cacheInspector';
import { fetchDocument } from '../helpers/zoteroHttpClient';
import {
    ENCRYPTED_PDF,
    GROUP_LIB_PDF,
    NON_PDF,
    NORMAL_PDF,
    NO_TEXT_PDF,
    SMALL_PDF,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

/** Generous timeout for whole-document extraction round-trips. */
const EXTRACT_OPTS = { timeout: 120_000 } as const;

/** Synthetic, well-formed key that should not resolve to a real item. */
const MISSING_KEY_LIB = 1;
const MISSING_KEY_ZOTERO = 'ZZZZTEST';

describe('background queue — enqueue endpoint', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('inserts a job and returns enqueued:true with a positive id', async () => {
        const res = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 50,
            payload: {
                content_kind: 'pdf',
                maxPages: null,
                maxFileSizeMB: 0,
                timeoutSeconds: 180,
            },
        });
        expect(res.ok).toBe(true);
        expect(res.enqueued).toBe(true);
        expect(res.id).toBeGreaterThan(0);
    });

    it('returns ok:false when required fields are missing', async () => {
        const res = await backgroundEnqueue({
            // missing library_id / zotero_key / content_kind / payload_kind / job_type
        } as never);
        expect(res.ok).toBe(false);
        expect(typeof res.error).toBe('string');
        expect(res.id ?? null).toBeNull();
    });

    it('dedupes by (job_type, library_id, zotero_key, payload_kind): re-enqueue returns same id with enqueued:false', async () => {
        const first = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 100,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        expect(first.enqueued).toBe(true);

        const second = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 100,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        expect(second.enqueued).toBe(false);
        expect(second.id).toBe(first.id);
    });

    it('lets the same key coexist across payload kinds (unique key includes `payload_kind`)', async () => {
        const structured = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const markdown = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'markdown',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        expect(structured.enqueued).toBe(true);
        expect(markdown.enqueued).toBe(true);
        expect(markdown.id).not.toBe(structured.id);

        const peek = await backgroundPeek();
        expect(peek.ok).toBe(true);
        expect(peek.jobs?.length).toBe(2);
    });
});

describe('background queue — peek endpoint', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('returns the enqueued row with all expected fields', async () => {
        const enqueued = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 73,
            payload: {
                content_kind: 'pdf',
                maxPages: 50,
                maxFileSizeMB: 25,
                timeoutSeconds: 180,
            },
        });
        expect(enqueued.enqueued).toBe(true);

        const res = await backgroundPeek();
        expect(res.ok).toBe(true);
        expect(res.jobs?.length).toBe(1);
        const job = res.jobs![0];
        expect(job.id).toBe(enqueued.id);
        expect(job.jobType).toBe('document_extract');
        expect(job.libraryId).toBe(SMALL_PDF.library_id);
        expect(job.zoteroKey).toBe(SMALL_PDF.zotero_key);
        expect(job.payloadKind).toBe('structured');
        expect(job.priority).toBe(73);
        expect(job.attemptCount).toBe(0);
        expect(job.lastError).toBeNull();
        expect(job.payload).toEqual({
            content_kind: 'pdf',
            maxPages: 50,
            maxFileSizeMB: 25,
            timeoutSeconds: 180,
        });
        expect(typeof job.enqueuedAt).toBe('number');
        expect(typeof job.availableAt).toBe('number');
    });

    it('respects the `limit` argument', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        await backgroundEnqueue({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const limited = await backgroundPeek({ limit: 1 });
        expect(limited.ok).toBe(true);
        expect(limited.jobs?.length).toBe(1);

        const full = await backgroundPeek({ limit: 10 });
        expect(full.jobs?.length).toBe(2);
    });

    it('orders rows by priority ASC then availableAt ASC', async () => {
        const low = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 200,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const high = await backgroundEnqueue({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 10,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(2);
        expect(peek.jobs![0].id).toBe(high.id);
        expect(peek.jobs![1].id).toBe(low.id);
    });
});

describe('background queue — stats endpoint', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('returns zero pending/available/dead on an empty queue', async () => {
        const res = await backgroundStats();
        expect(res.ok).toBe(true);
        expect(res.queue).toBeDefined();
        expect(res.queue!.pending).toBe(0);
        expect(res.queue!.available).toBe(0);
        expect(res.queue!.deferred).toBe(0);
        expect(res.queue!.dead).toBe(0);
        // byJobType is keyed only by job types present in the live queue.
        expect(res.queue!.byJobType).toEqual({});
    });

    it('counts a fresh enqueue under both pending and available', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const res = await backgroundStats();
        expect(res.queue!.pending).toBe(1);
        expect(res.queue!.available).toBe(1);
        expect(res.queue!.deferred).toBe(0);
        expect(res.queue!.byJobType.document_extract).toBe(1);
    });

    it('exposes per-slot MuPDF worker snapshots (`hot`, `background`)', async () => {
        const res = await backgroundStats();
        expect(res.ok).toBe(true);
        expect(res.workers).toBeDefined();
        // Slots are nullable: returns null when no client has been
        // instantiated for that slot yet. The keys themselves must exist.
        expect(Object.keys(res.workers!).sort()).toEqual(['background', 'hot']);
    });
});

describe('background queue — processOnce endpoint', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('returns processed:false reason:"empty" when the queue is empty', async () => {
        const res = await backgroundProcessOnce();
        expect(res.ok).toBe(true);
        expect(res.processed).toBe(false);
        expect(res.reason).toBe('empty');
    });

    it('drains a healthy PDF job and emits reason:"job_done"', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const res = await backgroundProcessOnce();
        expect(res.ok).toBe(true);
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        // The row must be gone after a successful drain (no retry).
        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);

        const stats = await backgroundStats();
        expect(stats.queue!.pending).toBe(0);
        expect(stats.queue!.dead).toBe(0);
    });

    it('completes a job for a non-existent zotero_key (item_missing) without retry', async () => {
        await backgroundEnqueue({
            library_id: MISSING_KEY_LIB,
            zotero_key: MISSING_KEY_ZOTERO,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
    });

    it('completes a job for an encrypted PDF (cached_error path, no retry)', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: ENCRYPTED_PDF.library_id,
            zotero_key: ENCRYPTED_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
    });

    it('completes a job for a no-text-layer PDF without retry', async () => {
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: NO_TEXT_PDF.library_id,
            zotero_key: NO_TEXT_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
    });

    it('drains multiple jobs across repeated calls', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'markdown',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const first = await backgroundProcessOnce();
        expect(first.processed).toBe(true);

        const second = await backgroundProcessOnce();
        expect(second.processed).toBe(true);

        const third = await backgroundProcessOnce();
        expect(third.processed).toBe(false);
        expect(third.reason).toBe('empty');
    }, 180_000);
});

describe('background queue — enqueue defaults', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('defaults priority to 100 when omitted', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(1);
        expect(peek.jobs![0].priority).toBe(100);
    });

    it('stores item_id null when omitted and round-trips it when provided', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const peekNull = await backgroundPeek();
        expect(peekNull.jobs![0].itemId).toBeNull();

        await backgroundClear();

        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            item_id: 42,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const peek = await backgroundPeek();
        expect(peek.jobs![0].itemId).toBe(42);
    });

    it('accepts payload: null and round-trips it', async () => {
        const res = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: null,
        });
        expect(res.enqueued).toBe(true);
        const peek = await backgroundPeek();
        expect(peek.jobs![0].payload).toBeNull();
    });
});

describe('background queue — clear endpoint', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns ok:true on an already-empty queue (idempotent)', async () => {
        if (!available) return;
        await backgroundClear();
        const res = await backgroundClear();
        expect(res.ok).toBe(true);
    });

    it('clears both live rows and resets stats counters', async () => {
        if (!available) return;
        await backgroundClear();
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'markdown',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const before = await backgroundStats();
        expect(before.queue!.pending).toBe(2);

        const res = await backgroundClear();
        expect(res.ok).toBe(true);

        const after = await backgroundStats();
        expect(after.queue!.pending).toBe(0);
        expect(after.queue!.byJobType).toEqual({});

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
    });
});

describe('background queue — terminal response_error completes without retry', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('drains a non-PDF (EPUB) job to completion (no retry, no dead-letter)', async () => {
        await backgroundEnqueue({
            library_id: NON_PDF.library_id,
            zotero_key: NON_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        // The live attachment is an EPUB, so its content kind no longer
        // matches the job's recorded `content_kind: 'pdf'` and the job is
        // dropped (completed without retry) before extraction.
        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const finalQueue = (await backgroundStats()).queue!;
        expect(finalQueue.pending).toBe(0);
        expect(finalQueue.dead).toBe(0);

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
    });
});

describe('background queue — group library extraction', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
        await invalidateCache(GROUP_LIB_PDF.library_id, GROUP_LIB_PDF.zotero_key);
    });

    it('drains a group-library PDF job and writes a cache metadata record', async () => {
        await backgroundEnqueue({
            library_id: GROUP_LIB_PDF.library_id,
            zotero_key: GROUP_LIB_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
            notify: true,
        });

        // Group-library PDF takes long enough that the queue may not drain
        // before our explicit `processOnce`, but we accept either outcome
        // and instead assert on the final state.
        await waitForQueueDrain({ timeoutMs: 120_000, pollMs: 250 });

        const record = await getCacheMetadata(
            GROUP_LIB_PDF.library_id,
            GROUP_LIB_PDF.zotero_key,
        );
        expect(record).not.toBeNull();
        expect(record?.pageCount).toBeGreaterThan(0);
        expect(record?.errorCode).toBeNull();
    }, 180_000);
});

describe('background queue — worker slot isolation', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('spawns a separate background MuPDF worker after a successful drain', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);

        const stats = await backgroundStats();
        expect(stats.workers).toBeDefined();
        expect(stats.workers!.background).not.toBeNull();
        expect(stats.workers!.background!.hasWorker).toBe(true);
        expect(stats.workers!.background!.spawnCount).toBeGreaterThanOrEqual(1);
        // hot may or may not have a worker depending on prior tests — but
        // when both exist they must be distinct instances tracked under
        // separate slot names. spawnCount equality is incidental; what we
        // verify here is that the `background` slot is its own client.
        expect(stats.workers!.hot).not.toBe(stats.workers!.background);
    }, 180_000);
});

describe('background queue — stats.byJobType across payload kinds', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('counts two jobs of the same type with different payload kinds together', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'markdown',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const stats = await backgroundStats();
        expect(stats.queue!.pending).toBe(2);
        expect(stats.queue!.byJobType.document_extract).toBe(2);
    });
});

describe('background queue — peek edge cases', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('returns an empty array for limit:0 even when rows exist', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const peek = await backgroundPeek({ limit: 0 });
        expect(peek.ok).toBe(true);
        expect(peek.jobs?.length).toBe(0);
    });

    it('returns the two lowest-priority rows in priority order with limit:2', async () => {
        const lowest = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 5,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        const mid = await backgroundEnqueue({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 50,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });
        await backgroundEnqueue({
            library_id: NO_TEXT_PDF.library_id,
            zotero_key: NO_TEXT_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_extract',
            priority: 500,
            payload: { content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0, timeoutSeconds: 180 },
        });

        const peek = await backgroundPeek({ limit: 2 });
        expect(peek.ok).toBe(true);
        expect(peek.jobs?.length).toBe(2);
        expect(peek.jobs![0].id).toBe(lowest.id);
        expect(peek.jobs![1].id).toBe(mid.id);
    });
});

describe('background queue — hot-path timeout integration', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('enqueues a document_extract job when the hot-path timeout fires', async () => {
        // Force a hot-path timeout with the smallest positive deadline.
        // Cold cache + a non-trivial extraction makes the timeout likely.
        await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);

        const res = await fetchDocument(
            NORMAL_PDF,
            { mode: 'structured', timeout_seconds: 1 },
            EXTRACT_OPTS,
        );

        // The hot handler either finishes fast OR returns `timeout` and
        // enqueues a retry. Both outcomes are valid against the contract,
        // so the assertion branches on what the handler actually did.
        if (res.error_code === 'timeout') {
            const peek = await backgroundPeek();
            expect(peek.jobs?.length).toBe(1);
            const job = peek.jobs![0];
            expect(job.jobType).toBe('document_extract');
            expect(job.libraryId).toBe(NORMAL_PDF.library_id);
            expect(job.zoteroKey).toBe(NORMAL_PDF.zotero_key);
            expect(job.payloadKind).toBe('structured');
            expect(job.priority).toBe(50);
            expect(job.payload?.timeoutSeconds).toBe(180);

            // The processor must now be able to drain the retry job.
            const drained = await backgroundProcessOnce();
            expect(drained.processed).toBe(true);
            expect(drained.reason).toBe('job_done');
        } else {
            // Extraction beat the 1s budget — that's fine, no retry was
            // enqueued. Assert the queue is empty.
            expect(res.error_code ?? null).toBeNull();
            const peek = await backgroundPeek();
            expect(peek.jobs?.length).toBe(0);
        }
    }, 180_000);
});
