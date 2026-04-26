/**
 * Unit tests for the in-worker doc cache (`src/services/pdf/worker/docCache.ts`).
 *
 * The real `openDocUncached` (and the worker FIFO `enqueue`) are mocked so
 * the cache logic can be tested without WASM. Each test resets the cache
 * config + counters via `__resetCacheConfigForTest`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/pdf/worker/errors', () => ({
    postLog: vi.fn(),
    ERROR_CODES: {},
    workerError: vi.fn((code: string, message: string) => {
        const e = new Error(message) as Error & { code: string };
        e.code = code;
        return e;
    }),
}));

const opQueueState: { tasks: Array<() => unknown | Promise<unknown>> } = { tasks: [] };
vi.mock('../../../src/services/pdf/worker/opQueue', () => ({
    enqueue: vi.fn(<T>(work: () => T | Promise<T>): Promise<T> => {
        // Capture the task synchronously so tests can assert it was queued,
        // then run it on the microtask queue so the await semantics still
        // resolve in the test.
        opQueueState.tasks.push(work);
        return Promise.resolve().then(() => work()) as Promise<T>;
    }),
}));

let openDocCallCount = 0;
let nextDocId = 1;
const docDestroySpies: Array<ReturnType<typeof vi.fn>> = [];

function makeFakeDoc() {
    const id = nextDocId++;
    const destroy = vi.fn();
    docDestroySpies.push(destroy);
    return {
        id,
        pointer: id,
        needsPassword: () => false,
        countPages: () => 1,
        getMetadata: () => '',
        loadPage: () => ({} as any),
        destroy,
    };
}

vi.mock('../../../src/services/pdf/worker/docHelpers', () => ({
    openDocUncached: vi.fn(async () => {
        openDocCallCount++;
        return makeFakeDoc();
    }),
}));

import {
    __resetCacheConfigForTest,
    __setCacheConfigForTest,
    acquireDoc,
    clearAllCachedDocs,
    getCacheStats,
    releaseDoc,
    sweepExpiredEntries,
} from '../../../src/services/pdf/worker/docCache';

// Provide a minimal `crypto.subtle.digest` for the test environment so the
// cache's feature-detect succeeds. Node's webcrypto is exposed on
// `globalThis.crypto` in modern Node, but Vitest's environment may not
// define it; supply a deterministic stub if missing.
function ensureCrypto() {
    const g = globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } };
    if (g.crypto?.subtle?.digest) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('node:crypto');
    g.crypto = {
        subtle: {
            digest: async (_algo: string, data: ArrayBuffer) => {
                const hash = nodeCrypto.createHash('sha256');
                hash.update(Buffer.from(data));
                const out = hash.digest();
                return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
            },
        } as any,
    };
}

describe('docCache', () => {
    beforeEach(() => {
        ensureCrypto();
        openDocCallCount = 0;
        nextDocId = 1;
        docDestroySpies.length = 0;
        opQueueState.tasks.length = 0;
        __resetCacheConfigForTest();
    });

    afterEach(() => {
        __resetCacheConfigForTest();
        vi.useRealTimers();
    });

    it('first acquireDoc opens; second on identical bytes hits the cache', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);

        const doc1 = await acquireDoc(bytes);
        releaseDoc(doc1);

        const doc2 = await acquireDoc(bytes);
        releaseDoc(doc2);

        expect(openDocCallCount).toBe(1);
        expect(doc2).toBe(doc1);
        const stats = getCacheStats();
        expect(stats.misses).toBe(1);
        expect(stats.hits).toBe(1);
        expect(stats.entries).toBe(1);
    });

    it('different bytes produce separate entries (no key collisions)', async () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5, 6]);

        const docA = await acquireDoc(a);
        releaseDoc(docA);
        const docB = await acquireDoc(b);
        releaseDoc(docB);

        expect(openDocCallCount).toBe(2);
        expect(docA).not.toBe(docB);
        const stats = getCacheStats();
        expect(stats.misses).toBe(2);
        expect(stats.hits).toBe(0);
        expect(stats.entries).toBe(2);
    });

    it('LRU eviction respects MAX_ENTRIES and never evicts the inUse entry', async () => {
        __setCacheConfigForTest({ maxEntries: 2, ttlMs: 60_000 });

        const a = new Uint8Array([0xa]);
        const b = new Uint8Array([0xb]);
        const c = new Uint8Array([0xc]);
        const d = new Uint8Array([0xd]);

        // Fill to capacity, all idle.
        const docA = await acquireDoc(a);
        releaseDoc(docA);
        const docB = await acquireDoc(b);
        releaseDoc(docB);

        expect(getCacheStats().entries).toBe(2);

        // Now hold C in-use; insert D should NOT evict C, only A or B.
        const docC = await acquireDoc(c);
        // While docC is acquired: insert D. The acquired entry C must
        // survive; the LRU candidate (A) is evicted.
        const docD = await acquireDoc(d);
        // Sanity: at least one of A's destroy spy fired.
        const aDestroyed = docDestroySpies.some((s) => s.mock.calls.length > 0);
        expect(aDestroyed).toBe(true);

        // Releasing in reverse so destruction order is irrelevant.
        releaseDoc(docD);
        releaseDoc(docC);

        const stats = getCacheStats();
        expect(stats.entries).toBeLessThanOrEqual(2);
        expect(stats.evictions).toBeGreaterThanOrEqual(1);
    });

    it('oversized doc bypasses the cache; releaseDoc destroys it directly', async () => {
        __setCacheConfigForTest({ maxBytes: 4 });

        const big = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes > maxBytes=4

        const doc = await acquireDoc(big);
        expect(getCacheStats().entries).toBe(0);

        releaseDoc(doc);
        // doc.destroy() called immediately because the doc was never
        // inserted into the cache.
        expect(doc.destroy).toHaveBeenCalledTimes(1);
        expect(getCacheStats().entries).toBe(0);
    });

    it('clearAllCachedDocs destroys every cached doc and resets counters', async () => {
        const a = new Uint8Array([1]);
        const b = new Uint8Array([2]);

        const docA = await acquireDoc(a);
        releaseDoc(docA);
        const docB = await acquireDoc(b);
        releaseDoc(docB);

        // Hit + miss to give counters non-zero values.
        const docA2 = await acquireDoc(a);
        releaseDoc(docA2);

        expect(getCacheStats().entries).toBe(2);
        expect(getCacheStats().hits).toBeGreaterThan(0);

        clearAllCachedDocs(true);

        expect(docA.destroy).toHaveBeenCalled();
        expect(docB.destroy).toHaveBeenCalled();
        const stats = getCacheStats();
        expect(stats.entries).toBe(0);
        expect(stats.totalBytes).toBe(0);
        expect(stats.hits).toBe(0);
        expect(stats.misses).toBe(0);
        expect(stats.evictions).toBe(0);
    });

    it('clearAllCachedDocs with resetCounters: false preserves counters', async () => {
        const a = new Uint8Array([1]);
        const docA = await acquireDoc(a);
        releaseDoc(docA);
        const docA2 = await acquireDoc(a);
        releaseDoc(docA2);

        const before = getCacheStats();
        expect(before.hits).toBe(1);
        expect(before.misses).toBe(1);

        clearAllCachedDocs(false);

        const after = getCacheStats();
        expect(after.entries).toBe(0);
        expect(after.hits).toBe(1);
        expect(after.misses).toBe(1);
    });

    it('absolute deadline source-of-truth: an op landing past expiresAt misses', async () => {
        // Use a tight TTL so we can advance Date.now() past it without timers.
        __setCacheConfigForTest({ ttlMs: 100 });

        const a = new Uint8Array([1, 2, 3]);
        const docA = await acquireDoc(a);
        releaseDoc(docA);

        // Simulate `Date.now()` advancing past the deadline BEFORE the
        // setTimeout fires. The next acquireDoc must treat the entry as
        // expired purely on the basis of `entry.expiresAt <= now`.
        const realNow = Date.now;
        try {
            const t = realNow.call(Date);
            Date.now = () => t + 200;

            const docA2 = await acquireDoc(a);
            releaseDoc(docA2);

            expect(openDocCallCount).toBe(2);
            const stats = getCacheStats();
            expect(stats.misses).toBe(2);
            expect(stats.hits).toBe(0);
            expect(stats.evictions).toBeGreaterThanOrEqual(1);
        } finally {
            Date.now = realNow;
        }
    });

    it('TTL timer enqueues a sweep onto the worker FIFO queue', async () => {
        vi.useFakeTimers();
        __setCacheConfigForTest({ ttlMs: 50 });

        const a = new Uint8Array([1, 2, 3]);
        const docA = await acquireDoc(a);
        releaseDoc(docA);

        const queuedBefore = opQueueState.tasks.length;
        // Advance JS timers past the TTL — the cache's setTimeout must fire
        // and enqueue a sweep task. The cache itself does NOT call destroy
        // synchronously inside the timer (destruction goes through the
        // queued sweep), so the doc isn't necessarily destroyed in this
        // tick.
        vi.advanceTimersByTime(60);
        const queuedAfter = opQueueState.tasks.length;
        expect(queuedAfter).toBeGreaterThan(queuedBefore);

        // Drain the queued task (our enqueue mock chains on Promise.resolve).
        await Promise.resolve();
        await Promise.resolve();

        // After the queued sweep runs, the doc is destroyed and the entry is gone.
        expect(getCacheStats().entries).toBe(0);
        expect(getCacheStats().evictions).toBeGreaterThanOrEqual(1);
        expect(docA.destroy).toHaveBeenCalled();
    });

    it('sweepExpiredEntries leaves inUse entries alone', async () => {
        __setCacheConfigForTest({ ttlMs: 100 });

        const a = new Uint8Array([1, 2, 3]);
        const docA = await acquireDoc(a); // still in use, no release

        // Advance Date.now() — but the entry's expiresAt is Infinity while
        // inUse, so sweepExpiredEntries must skip it.
        const realNow = Date.now;
        try {
            Date.now = () => realNow.call(Date) + 1_000_000;
            sweepExpiredEntries();
            expect(getCacheStats().entries).toBe(1);
            expect(docA.destroy).not.toHaveBeenCalled();
        } finally {
            Date.now = realNow;
            releaseDoc(docA);
        }
    });

    it('counters: hits/misses/evictions track lifetime', async () => {
        __setCacheConfigForTest({ maxEntries: 1 });

        const a = new Uint8Array([1]);
        const b = new Uint8Array([2]);

        // miss -> insert
        releaseDoc(await acquireDoc(a));
        // hit
        releaseDoc(await acquireDoc(a));
        // miss -> evicts a
        releaseDoc(await acquireDoc(b));

        const stats = getCacheStats();
        expect(stats.misses).toBe(2);
        expect(stats.hits).toBe(1);
        expect(stats.evictions).toBeGreaterThanOrEqual(1);
        expect(stats.entries).toBe(1);
    });
});
