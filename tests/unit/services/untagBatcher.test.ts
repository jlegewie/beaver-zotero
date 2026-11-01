import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNTAG_BATCH_MAX_REFS, UntagBatcher } from '../../../src/services/backgroundQueue/untagBatcher';
import type { IndexDocumentRef } from '../../../src/services/searchIndex/searchIndexApiClient';

const ref = (index: number): IndexDocumentRef => ({
    scope_ref: 'g1',
    zotero_key: `KEY${String(index).padStart(5, '0')}`,
    doc_hash: index.toString(16).padStart(64, '0'),
});

/** Answers each ref with `outcome(ref)`, in request order. */
function fakeApi(outcome: (ref: IndexDocumentRef) => string = () => 'untagged') {
    return {
        untag: vi.fn(async (_localId: string, refs: IndexDocumentRef[]) => ({
            results: refs.map((entry) => ({ ...entry, outcome: outcome(entry) })),
        })),
    };
}

describe('UntagBatcher', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        (globalThis as any).Zotero.Beaver = {
            account: { getSnapshot: () => ({ session: { user: { id: 'account-a' } } }) },
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('merges concurrent refs into one request and maps results by position', async () => {
        const api = fakeApi((entry) => (entry.zotero_key === ref(1).zotero_key ? 'busy' : 'untagged'));
        const batcher = new UntagBatcher(api as any);

        const results = Promise.all([0, 1, 2].map((index) => batcher.untag('account-a', 'LOCAL123', ref(index))));
        await vi.advanceTimersByTimeAsync(100);

        expect(api.untag).toHaveBeenCalledTimes(1);
        expect(api.untag).toHaveBeenCalledWith('LOCAL123', [ref(0), ref(1), ref(2)]);
        expect((await results).map(({ result }) => result?.outcome)).toEqual(['untagged', 'busy', 'untagged']);
    });

    it('sends a full batch right away and splits the rest', async () => {
        const api = fakeApi();
        const batcher = new UntagBatcher(api as any);

        const results = Promise.all(
            Array.from({ length: UNTAG_BATCH_MAX_REFS + 5 }, (_, index) => batcher.untag('account-a', 'LOCAL123', ref(index))),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(api.untag).toHaveBeenCalledTimes(1);
        expect(api.untag.mock.calls[0][1]).toHaveLength(UNTAG_BATCH_MAX_REFS);

        await vi.advanceTimersByTimeAsync(100);
        expect(api.untag).toHaveBeenCalledTimes(2);
        expect(api.untag.mock.calls[1][1]).toHaveLength(5);
        expect(await results).toHaveLength(UNTAG_BATCH_MAX_REFS + 5);
    });

    it('waits for refs to settle but never longer than the batch deadline', async () => {
        const api = fakeApi();
        const batcher = new UntagBatcher(api as any);

        const results: Promise<unknown>[] = [];
        for (let index = 0; index < 20; index += 1) {
            results.push(batcher.untag('account-a', 'LOCAL123', ref(index)));
            await vi.advanceTimersByTimeAsync(30);
            if (api.untag.mock.calls.length > 0) break;
        }

        expect(api.untag).toHaveBeenCalledTimes(1);
        // Refs kept arriving every 30 ms, so only the 500 ms deadline sent the batch.
        expect(api.untag.mock.calls[0][1].length).toBeGreaterThan(10);
        expect(api.untag.mock.calls[0][1].length).toBeLessThanOrEqual(18);
        await Promise.all(results);
    });

    it('keeps refs of different devices in separate requests', async () => {
        const api = fakeApi();
        const batcher = new UntagBatcher(api as any);

        const results = Promise.all([
            batcher.untag('account-a', 'LOCAL123', ref(0)),
            batcher.untag('account-a', 'OTHER456', ref(1)),
        ]);
        await vi.advanceTimersByTimeAsync(100);

        expect(api.untag.mock.calls.map(([localId, refs]) => [localId, refs.length])).toEqual([
            ['LOCAL123', 1], ['OTHER456', 1],
        ]);
        await results;
    });

    it('runs at most two requests at a time', async () => {
        const releases: Array<() => void> = [];
        const api = {
            untag: vi.fn((_localId: string, refs: IndexDocumentRef[]) => new Promise((resolve) => {
                releases.push(() => resolve({ results: refs.map((entry) => ({ ...entry, outcome: 'untagged' })) }));
            })),
        };
        const batcher = new UntagBatcher(api as any);

        const results = Promise.all(['L1', 'L2', 'L3'].map((localId, index) =>
            batcher.untag('account-a', `${localId}AAAAAA`, ref(index))));
        await vi.advanceTimersByTimeAsync(100);
        expect(api.untag).toHaveBeenCalledTimes(2);

        releases.shift()!();
        await vi.advanceTimersByTimeAsync(0);
        expect(api.untag).toHaveBeenCalledTimes(3);
        releases.splice(0).forEach((release) => release());
        await results;
    });

    it('reports a batch as failed only when no ref in it succeeded', async () => {
        const batcher = new UntagBatcher(fakeApi((entry) => (entry === ref(0) ? 'failed' : 'failed')) as any);
        const allFailed = Promise.all([0, 1].map((index) => batcher.untag('account-a', 'LOCAL123', ref(index))));
        await vi.advanceTimersByTimeAsync(100);
        expect((await allFailed).map(({ batchFailed }) => batchFailed)).toEqual([true, true]);

        const mixed = new UntagBatcher(fakeApi((entry) => (entry.zotero_key === ref(0).zotero_key ? 'failed' : 'busy')) as any);
        const someBusy = Promise.all([0, 1].map((index) => mixed.untag('account-a', 'LOCAL123', ref(index))));
        await vi.advanceTimersByTimeAsync(100);
        expect((await someBusy).map(({ batchFailed }) => batchFailed)).toEqual([false, false]);
    });

    it('rejects every ref of a batch whose request failed', async () => {
        const error = new Error('network down');
        const batcher = new UntagBatcher({ untag: vi.fn().mockRejectedValue(error) } as any);

        const results = [0, 1].map((index) => batcher.untag('account-a', 'LOCAL123', ref(index)));
        const settled = Promise.allSettled(results);
        await vi.advanceTimersByTimeAsync(100);

        expect((await settled).map((result) => result.status === 'rejected' && result.reason)).toEqual([error, error]);
    });

    it('never sends one account\'s refs under another signed-in account', async () => {
        const api = fakeApi();
        const batcher = new UntagBatcher(api as any);

        const result = batcher.untag('account-a', 'LOCAL123', ref(0));
        const settled = result.catch((error) => error);
        (globalThis as any).Zotero.Beaver.account = { getSnapshot: () => ({ session: { user: { id: 'account-b' } } }) };
        await vi.advanceTimersByTimeAsync(100);

        expect(await settled).toMatchObject({ code: 'ACCOUNT_CHANGED' });
        expect(api.untag).not.toHaveBeenCalled();
    });

    it('retries a rejected request one ref at a time so only the bad ref fails', async () => {
        const rejection = Object.assign(new Error('invalid ref'), { status: 400 });
        const api = {
            untag: vi.fn(async (_localId: string, refs: IndexDocumentRef[]) => {
                if (refs.some((entry) => entry.zotero_key === ref(1).zotero_key)) throw rejection;
                return { results: refs.map((entry) => ({ ...entry, outcome: 'untagged' })) };
            }),
        };
        const batcher = new UntagBatcher(api as any, (error) => error === rejection);

        const settled = Promise.allSettled([0, 1, 2].map((index) => batcher.untag('account-a', 'LOCAL123', ref(index))));
        await vi.advanceTimersByTimeAsync(100);

        expect((await settled).map((result) => result.status === 'fulfilled' ? result.value.result?.outcome : result.reason))
            .toEqual(['untagged', rejection, 'untagged']);
        expect(api.untag.mock.calls.map(([, refs]) => refs.length)).toEqual([3, 1, 1, 1]);
    });

    it('does not split a batch on errors that are not request rejections', async () => {
        const error = new Error('server unavailable');
        const api = { untag: vi.fn().mockRejectedValue(error) };
        const batcher = new UntagBatcher(api as any, () => false);

        const settled = Promise.allSettled([0, 1].map((index) => batcher.untag('account-a', 'LOCAL123', ref(index))));
        await vi.advanceTimersByTimeAsync(100);

        expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
        expect(api.untag).toHaveBeenCalledTimes(1);
    });

    it('never sends a ref whose job was cancelled while it waited', async () => {
        const api = fakeApi();
        const batcher = new UntagBatcher(api as any);
        let cancelled = false;

        const kept = batcher.untag('account-a', 'LOCAL123', ref(0));
        const dropped = batcher.untag('account-a', 'LOCAL123', ref(1), () => cancelled).catch((error) => error);
        cancelled = true;
        await vi.advanceTimersByTimeAsync(100);

        expect(await dropped).toMatchObject({ name: 'AbortError' });
        expect((await kept).result?.outcome).toBe('untagged');
        expect(api.untag).toHaveBeenCalledWith('LOCAL123', [ref(0)]);

        const alone = batcher.untag('account-a', 'LOCAL123', ref(2), () => true).catch((error) => error);
        await vi.advanceTimersByTimeAsync(100);
        expect(await alone).toMatchObject({ name: 'AbortError' });
        expect(api.untag).toHaveBeenCalledTimes(1);
    });

    it('rejects refs that were not sent yet when closed', async () => {
        const api = fakeApi();
        const batcher = new UntagBatcher(api as any);

        const settled = batcher.untag('account-a', 'LOCAL123', ref(0)).catch((error) => error);
        batcher.close();
        await vi.advanceTimersByTimeAsync(100);

        expect(await settled).toMatchObject({ name: 'AbortError' });
        await expect(batcher.untag('account-a', 'LOCAL123', ref(1))).rejects.toMatchObject({ name: 'AbortError' });
        expect(api.untag).not.toHaveBeenCalled();
    });
});
