import { describe, expect, it, vi } from 'vitest';
import { LibraryMutations } from '../../../src/services/libraryMutations';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

describe('instance library mutations', () => {
    it('holds an executing write through window closure and cancels its queued work', async () => {
        const gate = deferred();
        const queue = new LibraryMutations();
        const order: string[] = [];
        const first = queue.run(async () => { order.push('start'); await gate.promise; order.push('commit'); }, { owner: 'A' });
        await Promise.resolve();
        const cancelled = queue.run(async () => { order.push('cancelled'); }, { owner: 'A' });
        const rejected = expect(cancelled).rejects.toMatchObject({ code: 'operation_cancelled' });
        const second = queue.run(async () => { order.push('B'); }, { owner: 'B' });
        queue.cancelOwner('A');
        await Promise.resolve();
        expect(order).toEqual(['start']);
        gate.resolve();
        await Promise.all([first, rejected, second]);
        expect(order).toEqual(['start', 'commit', 'B']);
    });

    it('rechecks request identity after queueing and recovers from rejection', async () => {
        const queue = new LibraryMutations();
        const gate = deferred();
        const first = queue.run(() => gate.promise);
        let current = true;
        const work = vi.fn(async () => {});
        const second = queue.run(work, { assertCurrent: () => { if (!current) throw new Error('revoked'); } });
        const rejected = expect(second).rejects.toThrow('revoked');
        current = false;
        gate.resolve();
        await Promise.all([first, rejected]);
        await queue.run(work);
        expect(work).toHaveBeenCalledTimes(1);
    });

    it('disposal waits for active saves and refuses queued and new work', async () => {
        const gate = deferred();
        const release = vi.fn();
        const queue = new LibraryMutations(vi.fn(), release);
        const first = queue.run(() => gate.promise);
        await Promise.resolve();
        const queued = queue.run(async () => {});
        const rejected = expect(queued).rejects.toMatchObject({ code: 'operation_cancelled' });
        const disposal = queue.dispose();
        expect(release).not.toHaveBeenCalled();
        gate.resolve();
        await Promise.all([first, rejected, disposal]);
        expect(release).toHaveBeenCalledTimes(1);
        await expect(queue.run(async () => {})).rejects.toMatchObject({ code: 'operation_cancelled' });
    });
});
