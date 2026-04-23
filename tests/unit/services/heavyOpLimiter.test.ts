/**
 * Tests for the shared heavy-op concurrency limiter.
 *
 * The limiter has no Zotero dependencies — pure async/promise logic.
 * Verify: concurrency cap, FIFO ordering, slot release on both resolve and reject.
 */

import { describe, it, expect } from 'vitest';
import { runHeavyPdfOp } from '../../../src/services/pdf/heavyOpLimiter';

/**
 * Build a deferred-promise helper so tests can resolve tasks on demand and
 * observe concurrency without timing flakiness.
 */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('runHeavyPdfOp', () => {
    it('caps concurrency at 2', async () => {
        let active = 0;
        let peak = 0;

        const gates = [deferred(), deferred(), deferred(), deferred()];
        const tasks = gates.map((g) =>
            runHeavyPdfOp(async () => {
                active++;
                if (active > peak) peak = active;
                await g.promise;
                active--;
            }),
        );

        // Yield so the limiter can start the first wave.
        await Promise.resolve();
        await Promise.resolve();
        expect(active).toBe(2);

        // Release them one by one — peak must never exceed 2.
        gates[0].resolve();
        await tasks[0];
        gates[1].resolve();
        await tasks[1];
        gates[2].resolve();
        await tasks[2];
        gates[3].resolve();
        await tasks[3];

        expect(peak).toBe(2);
    });

    it('runs queued tasks in FIFO order', async () => {
        const order: number[] = [];
        const gates = [deferred(), deferred(), deferred(), deferred()];

        const tasks = gates.map((g, i) =>
            runHeavyPdfOp(async () => {
                order.push(i);
                await g.promise;
            }),
        );

        // Wait for first wave to enter.
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual([0, 1]);

        // Releasing slot 0 should let task 2 start next, not task 3.
        gates[0].resolve();
        await tasks[0];
        await Promise.resolve();
        expect(order).toEqual([0, 1, 2]);

        gates[1].resolve();
        await tasks[1];
        await Promise.resolve();
        expect(order).toEqual([0, 1, 2, 3]);

        gates[2].resolve();
        gates[3].resolve();
        await Promise.all(tasks);
    });

    it('releases the slot when a task rejects', async () => {
        const blocker = deferred();
        const failing = runHeavyPdfOp(async () => {
            await blocker.promise;
            throw new Error('boom');
        });
        const filler = runHeavyPdfOp(async () => {
            // Trivial task: also occupies a slot.
            await Promise.resolve();
        });

        let queuedRan = false;
        const queued = runHeavyPdfOp(async () => {
            queuedRan = true;
        });

        // First two slots full; third is queued.
        await Promise.resolve();
        await filler;
        // Filler released its slot, but the failing task still holds the other.
        // The queued task should now be running.
        await Promise.resolve();
        await Promise.resolve();
        expect(queuedRan).toBe(true);
        await queued;

        // Now release the failing task — its rejection must not leak the slot.
        blocker.resolve();
        await expect(failing).rejects.toThrow('boom');

        // After rejection, the limiter must accept new work immediately.
        let after = false;
        await runHeavyPdfOp(async () => {
            after = true;
        });
        expect(after).toBe(true);
    });

    it('returns the task result', async () => {
        const result = await runHeavyPdfOp(async () => 42);
        expect(result).toBe(42);
    });
});
