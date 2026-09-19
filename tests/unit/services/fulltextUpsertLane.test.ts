import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('../../../src/services/backgroundProcessing/remoteRefsReconcile', () => ({ reconcileRemoteRefs: mocks.reconcile }));
vi.mock('../../../src/services/backgroundQueue/fulltextUpsertExecutor', () => ({
    FulltextUpsertExecutor: class { constructor(_api?: unknown, public jobType = 'fulltext_upsert') {} },
}));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: {} }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { startFulltextUpsertLane } from '../../../src/services/backgroundProcessing/fulltextUpsertLane';
let changed: () => void;
let cleanup: (() => Promise<void>) | undefined;
let selections: number[];
let epoch: string;
let count: number;
const unsubscribe = vi.fn();
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks();
    selections = []; epoch = 'initial'; count = 0;
    mocks.reconcile.mockImplementation(async (_ids, _cancelled, select) => {
        if (!select({ index_validity: 'current', index_incarnation: epoch })) return 0;
        selections.push(Date.now()); return count;
    });
    (Zotero as any).Beaver = {
        db: { subscribeReadinessChanges: vi.fn(fn => { changed = fn; return unsubscribe; }), restoreIndexCleanup: vi.fn(async () => 0) },
        account: { getSnapshot: () => ({ session: { user: { id: 'account' } } }) },
        backgroundExtractor: { registerExecutor: vi.fn(), unregisterExecutor: vi.fn(), notify: vi.fn() },
    };
});
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers(); });
it('does no minute sweeps, probes validity, and selects idle recovery only hourly', async () => {
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(selections).toEqual([2000]);
    expect(mocks.reconcile).toHaveBeenCalledTimes(13);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(selections).toEqual([2000, 3_900_001]);
});
it('coalesces ledger changes and caps recovery at fifty jobs per minute', async () => {
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(2000);
    count = 50;
    for (let i = 0; i < 1000; i++) changed();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(selections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(selections).toEqual([2000, 62000]);
    count = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(selections).toEqual([2000, 62000, 122000]);
});
it('selects recovery when a validity probe detects a reset', async () => {
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(2000);
    epoch = 'reset';
    await vi.advanceTimersByTimeAsync(298_001);
    expect(selections).toEqual([2000, 300001]);
});
it('does not create recovery work without access and unsubscribes on stop', async () => {
    cleanup = startFulltextUpsertLane([1], false);
    changed();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    await cleanup(); cleanup = undefined;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it('stops all recovery timers and ignores later notifications', async () => {
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(2000);
    changed();
    await cleanup(); cleanup = undefined;
    changed();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
});

it('keeps pending intent without minute retries when validity is unavailable', async () => {
    const available = mocks.reconcile.getMockImplementation()!;
    mocks.reconcile.mockResolvedValue(0);
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(298001);
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(selections).toEqual([]);
    mocks.reconcile.mockImplementation(available);
    await vi.advanceTimersByTimeAsync(300000);
    expect(selections).toEqual([600001]);
});
it('does not lose a ledger event arriving while a selected sweep is finishing', async () => {
    let release!: (count: number) => void;
    mocks.reconcile.mockImplementationOnce(async (_ids, _cancelled, select) => {
        expect(select({ index_validity: 'current', index_incarnation: epoch })).toBe(true);
        return new Promise<number>(resolve => { release = resolve; });
    });
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(2000);
    changed();
    release(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(selections).toEqual([62000]);
});
it('retains pending intent across transport failure without a minute retry loop', async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error('offline'));
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(62000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(238001);
    expect(selections).toEqual([300001]);
});

it('defers a change received during a failed selected sweep to the next validity probe', async () => {
    let reject!: (error: Error) => void;
    mocks.reconcile.mockImplementationOnce(async (_ids, _cancelled, select) => {
        expect(select({ index_validity: 'current', index_incarnation: epoch })).toBe(true);
        return new Promise<number>((_resolve, fail) => { reject = fail; });
    });
    cleanup = startFulltextUpsertLane([1], true);
    await vi.advanceTimersByTimeAsync(2000);
    changed();
    reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(238001);
    expect(selections).toEqual([300001]);
});
