import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    OBSERVER_GRACE_MS,
    runCommittedTransaction,
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
