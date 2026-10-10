import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    OBSERVER_GRACE_MS,
    runCommittedTransaction,
    runInterceptedTransaction,
} from '../../../src/services/committedTransaction';
import { TimingAccumulator } from '../../../src/utils/timing';

const Z = Zotero as any;

type Observers = number | 'never';

/**
 * Zotero's executeTransaction shape: run the work, commit, run the temporary
 * `onCommit` callback, then deliver Notifier events before resolving.
 */
function fakeExecuteTransaction(observers: Observers, { failAfterCommit = false } = {}) {
    return vi.fn(async (func: () => Promise<unknown>, options?: { onCommit?: (id: string) => unknown }) => {
        const result = await func();
        await options?.onCommit?.('tx');
        if (observers === 'never') await new Promise(() => {});
        else await new Promise((resolve) => setTimeout(resolve, observers));
        if (failAfterCommit) throw Object.assign(new Error('post-commit failure'), { committed: true });
        return result;
    });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('runCommittedTransaction', () => {
    it('returns as soon as fast observers finish', async () => {
        Z.DB = { executeTransaction: fakeExecuteTransaction(10) };
        const timing = new TimingAccumulator();
        const pending = runCommittedTransaction(async () => 'saved', { timing });
        await vi.advanceTimersByTimeAsync(10);
        await expect(pending).resolves.toBe('saved');
        expect(timing.get('observers_deferred')).toBe(0);
        expect(timing.get('post_commit_ms')).toBe(10);
    });

    it('returns after the grace period while slow observers keep running', async () => {
        Z.DB = { executeTransaction: fakeExecuteTransaction(21_000) };
        const timing = new TimingAccumulator();
        let returned = false;
        const pending = runCommittedTransaction(async () => 'saved', { timing }).then((value) => {
            returned = true;
            return value;
        });
        await vi.advanceTimersByTimeAsync(OBSERVER_GRACE_MS - 1);
        expect(returned).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBe('saved');
        expect(timing.get('observers_deferred')).toBe(1);
        expect(timing.get('post_commit_ms')).toBe(OBSERVER_GRACE_MS);
    });

    it('returns even when an observer never settles', async () => {
        Z.DB = { executeTransaction: fakeExecuteTransaction('never') };
        const pending = runCommittedTransaction(async () => 'saved', { graceMs: 50 });
        await vi.advanceTimersByTimeAsync(50);
        await expect(pending).resolves.toBe('saved');
    });

    it('propagates a failure that rolled the transaction back', async () => {
        Z.DB = { executeTransaction: fakeExecuteTransaction(0) };
        await expect(runCommittedTransaction(async () => { throw new Error('constraint failed'); }))
            .rejects.toThrow('constraint failed');
    });

    it('returns the committed value when Zotero fails after the commit', async () => {
        Z.DB = { executeTransaction: fakeExecuteTransaction(10, { failAfterCommit: true }) };
        const pending = runCommittedTransaction(async () => 'saved');
        await vi.advanceTimersByTimeAsync(10);
        await expect(pending).resolves.toBe('saved');
    });
});

describe('runInterceptedTransaction', () => {
    /** A saver that opens its transaction synchronously, then does post-transaction work. */
    function saverThatOpensTransaction(observers: Observers) {
        const execute = fakeExecuteTransaction(observers);
        Z.DB = { executeTransaction: execute };
        const work = vi.fn(async () => 'inner');
        const start = vi.fn(async () => {
            await Z.DB.executeTransaction(work);
            return ['post-transaction value'];
        });
        return { execute, work, start };
    }

    it('returns the value read inside the transaction after the grace period', async () => {
        const { execute, work, start } = saverThatOpensTransaction(30_000);
        const timing = new TimingAccumulator();
        const pending = runInterceptedTransaction(start, async (inner) => {
            const result = await inner();
            return `created after ${result}`;
        }, { timing });
        await vi.advanceTimersByTimeAsync(OBSERVER_GRACE_MS);
        await expect(pending).resolves.toEqual({ intercepted: true, value: 'created after inner' });
        expect(work).toHaveBeenCalledTimes(1);
        expect(timing.get('observers_deferred')).toBe(1);
        // The intercept is one-shot: later transactions use Zotero's own function.
        expect(Z.DB.executeTransaction).toBe(execute);
    });

    it('keeps the transaction work\'s own return value for the saver', async () => {
        const execute = fakeExecuteTransaction(0);
        Z.DB = { executeTransaction: execute };
        let seenByCaller: unknown;
        const start = async () => {
            seenByCaller = await Z.DB.executeTransaction(async () => 'inner result');
            return [];
        };
        const pending = runInterceptedTransaction(start, async (inner) => { await inner(); return 'outer'; });
        await vi.advanceTimersByTimeAsync(0);
        await pending;
        expect(seenByCaller).toBe('inner result');
    });

    it('chains an onCommit callback the caller passed to Zotero', async () => {
        const execute = fakeExecuteTransaction(0);
        Z.DB = { executeTransaction: execute };
        const onCommit = vi.fn();
        const start = async () => {
            await Z.DB.executeTransaction(async () => {}, { onCommit });
            return [];
        };
        const pending = runInterceptedTransaction(start, async (inner) => inner());
        await vi.advanceTimersByTimeAsync(0);
        await pending;
        expect(onCommit).toHaveBeenCalledWith('tx');
    });

    it('falls back to awaiting start in full when no transaction opens synchronously', async () => {
        const execute = fakeExecuteTransaction(0);
        Z.DB = { executeTransaction: execute };
        const inside = vi.fn();
        const start = async () => {
            await Promise.resolve();
            await Z.DB.executeTransaction(async () => {});
            return ['items'];
        };
        const pending = runInterceptedTransaction(start, inside);
        await vi.advanceTimersByTimeAsync(0);
        await expect(pending).resolves.toEqual({ intercepted: false, startValue: ['items'] });
        expect(inside).not.toHaveBeenCalled();
        expect(Z.DB.executeTransaction).toBe(execute);
    });

    it('leaves Zotero\'s prototype method in place, without an own property, after intercepting', async () => {
        const execute = fakeExecuteTransaction(0);
        class FakeDB {}
        (FakeDB.prototype as any).executeTransaction = execute;
        Z.DB = new FakeDB();
        const start = async () => { await Z.DB.executeTransaction(async () => {}); return []; };
        const pending = runInterceptedTransaction(start, async (inner) => inner());
        await vi.advanceTimersByTimeAsync(0);
        await pending;
        expect(Object.prototype.hasOwnProperty.call(Z.DB, 'executeTransaction')).toBe(false);
        expect(Z.DB.executeTransaction).toBe(execute);

        const fallback = runInterceptedTransaction(async () => [], async () => null);
        await vi.advanceTimersByTimeAsync(0);
        await fallback;
        expect(Object.prototype.hasOwnProperty.call(Z.DB, 'executeTransaction')).toBe(false);
    });

    it('restores Zotero\'s function when start throws synchronously', async () => {
        const execute = fakeExecuteTransaction(0);
        Z.DB = { executeTransaction: execute };
        const start = () => { throw new TypeError('saveItems is not a function'); };
        await expect(runInterceptedTransaction(start as any, async () => null)).rejects.toThrow(TypeError);
        expect(Z.DB.executeTransaction).toBe(execute);
    });

    it('propagates a rolled-back transaction', async () => {
        const execute = fakeExecuteTransaction(0);
        Z.DB = { executeTransaction: execute };
        const start = async () => Z.DB.executeTransaction(async () => { throw new Error('database locked'); });
        await expect(runInterceptedTransaction(start, async (inner) => inner())).rejects.toThrow('database locked');
    });
});

describe('waitForDeferredCommits', () => {
    // Deferred writes are module state; load a fresh copy per test.
    async function freshModule() {
        vi.resetModules();
        return import('../../../src/services/committedTransaction');
    }

    it('resolves at once when no write was deferred', async () => {
        const { waitForDeferredCommits } = await freshModule();
        await expect(waitForDeferredCommits(1000)).resolves.toBe(true);
    });

    it('waits until a deferred write has finished its commit callbacks', async () => {
        const { runCommittedTransaction, waitForDeferredCommits } = await freshModule();
        Z.DB = { executeTransaction: fakeExecuteTransaction(10_000) };
        const write = runCommittedTransaction(async () => 'saved', { graceMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        await write;
        let waited: boolean | undefined;
        const pending = waitForDeferredCommits(30_000).then((value) => { waited = value; });
        await vi.advanceTimersByTimeAsync(9_000);
        expect(waited).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1_000);
        await pending;
        expect(waited).toBe(true);
        // Settled writes are no longer tracked.
        await expect(waitForDeferredCommits(1)).resolves.toBe(true);
    });

    it('gives up after the timeout when a deferred write never settles', async () => {
        const { runCommittedTransaction, waitForDeferredCommits } = await freshModule();
        Z.DB = { executeTransaction: fakeExecuteTransaction('never') };
        const write = runCommittedTransaction(async () => 'saved', { graceMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        await write;
        const pending = waitForDeferredCommits(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(pending).resolves.toBe(false);
        // A write that outlasted a full wait is treated as hung: later callers don't wait for it.
        await expect(waitForDeferredCommits(5_000)).resolves.toBe(true);
    });

    it('tracks deferred writes in the plugin instance, so other bundles see them', async () => {
        const { DeferredCommits, runCommittedTransaction } = await freshModule();
        const shared = new DeferredCommits();
        const previousBeaver = Z.Beaver;
        Z.Beaver = { ...(previousBeaver ?? {}), deferredCommits: shared };
        try {
            Z.DB = { executeTransaction: fakeExecuteTransaction(10_000) };
            const write = runCommittedTransaction(async () => 'saved', { graceMs: 100 });
            await vi.advanceTimersByTimeAsync(100);
            await write;
            // Another bundle's copy of the module reaches the same instance.
            const { waitForDeferredCommits } = await freshModule();
            const pending = waitForDeferredCommits(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(pending).resolves.toBe(false);
        } finally {
            Z.Beaver = previousBeaver;
        }
    });
});
