import { describe, expect, it, vi } from 'vitest';
import { DocumentCache } from '../../../src/services/documentCache';
import type { BeaverDB } from '../../../src/services/database';

type Result = { schemaVersion: string; label: string };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

/** The uncached path never touches the database; any access fails the test. */
function cacheWithoutDatabase(): DocumentCache {
    const db = new Proxy({}, {
        get: (_target, prop) => {
            throw new Error(`unexpected database access: ${String(prop)}`);
        },
    }) as BeaverDB;
    return new DocumentCache(db);
}

describe('DocumentCache.getOrCreateUncachedResult', () => {
    it('runs one extraction for concurrent callers with the same key', async () => {
        const cache = cacheWithoutDatabase();
        const pending = deferred<Result>();
        const create = vi.fn(() => pending.promise);

        const first = cache.getOrCreateUncachedResult({ key: 'a/4', create });
        const second = cache.getOrCreateUncachedResult({ key: 'a/4', create });
        pending.resolve({ schemaVersion: '4', label: 'shared' });

        await expect(first).resolves.toEqual({ schemaVersion: '4', label: 'shared' });
        await expect(second).resolves.toEqual({ schemaVersion: '4', label: 'shared' });
        expect(create).toHaveBeenCalledOnce();
    });

    it('runs separate extractions for different keys and again after settling', async () => {
        const cache = cacheWithoutDatabase();
        const create = vi.fn(async () => ({ schemaVersion: '4', label: 'x' }));

        await Promise.all([
            cache.getOrCreateUncachedResult({ key: 'a/4', create }),
            cache.getOrCreateUncachedResult({ key: 'b/4', create }),
        ]);
        await cache.getOrCreateUncachedResult({ key: 'a/4', create });

        expect(create).toHaveBeenCalledTimes(3);
    });

    it('aborts the shared extraction once its last waiter detaches', async () => {
        const cache = cacheWithoutDatabase();
        let extractSignal: AbortSignal | undefined;
        const create = vi.fn((signal: AbortSignal) => {
            extractSignal = signal;
            return new Promise<Result>(() => {});
        });
        const firstCaller = new AbortController();
        const secondCaller = new AbortController();

        const first = cache.getOrCreateUncachedResult({ key: 'a/4', create, abortSignal: firstCaller.signal });
        const second = cache.getOrCreateUncachedResult({ key: 'a/4', create, abortSignal: secondCaller.signal });

        firstCaller.abort();
        await expect(first).rejects.toThrow('Operation aborted');
        expect(extractSignal?.aborted).toBe(false);

        secondCaller.abort();
        await expect(second).rejects.toThrow('Operation aborted');
        expect(extractSignal?.aborted).toBe(true);
    });
});
