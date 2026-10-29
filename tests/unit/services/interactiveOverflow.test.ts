import { beforeEach, describe, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => ({
    hot: { inFlight: 0, queued: 0 },
    background: null as null | {
        inFlight: number;
        queued: number;
        warm: boolean;
        isWarm: () => boolean;
        prewarm: ReturnType<typeof vi.fn>;
    },
}));

vi.mock('../../../src/beaver-extract', () => ({
    WorkerAbortError: class MockWorkerAbortError extends Error {
        constructor() {
            super('worker operation aborted by caller');
            this.name = 'WorkerAbortError';
        }
    },
    getExistingMuPDFWorkerClient: vi.fn((name: string) => (name === 'background' ? workers.background : workers.hot)),
    getMuPDFWorkerClient: vi.fn((name: string) => {
        if (name !== 'background') return workers.hot;
        workers.background ??= backgroundClient(false);
        return workers.background;
    }),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { InteractiveOverflow } from '../../../src/services/backgroundQueue/interactiveOverflow';
import { MuPDFSerialLane } from '../../../src/services/backgroundQueue/muPDFSerialLane';
import { PdfRequestWorker } from '../../../src/services/documentExtraction/pdfRequestWorker';

function backgroundClient(warm: boolean) {
    const client = {
        inFlight: 0,
        queued: 0,
        warm,
        isWarm: () => client.warm,
        prewarm: vi.fn(() => Promise.resolve()),
    };
    return client;
}

function setOverflowPref(value: boolean | undefined) {
    (globalThis as any).Zotero.Prefs.get = vi.fn((pref: string) =>
        pref === 'extensions.zotero.beaver.pdf.backgroundOverflow' ? value : undefined);
}

/** Whether `promise` has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
}

describe('InteractiveOverflow routing', () => {
    let lane: MuPDFSerialLane;
    let jobInFlight: boolean;
    let available: boolean;
    let onDrained: ReturnType<typeof vi.fn>;
    let overflow: InteractiveOverflow;

    beforeEach(() => {
        vi.clearAllMocks();
        workers.hot = { inFlight: 0, queued: 0 };
        workers.background = backgroundClient(true);
        setOverflowPref(undefined);
        lane = new MuPDFSerialLane();
        jobInFlight = false;
        available = true;
        onDrained = vi.fn();
        overflow = new InteractiveOverflow({
            lane,
            isAvailable: () => available,
            hasWorkerJobInFlight: () => jobInFlight,
            onDrained,
        });
    });

    it('uses hot while the hot worker is idle', async () => {
        const route = await overflow.acquire();

        expect(route).toEqual({ slot: 'hot', release: expect.any(Function) });
        expect(lane.isFree).toBe(true);
        expect(overflow.getStats().decisions.hot_idle).toBe(1);
    });

    it('uses a warm background worker when hot is busy and the lane is free', async () => {
        const first = await overflow.acquire();

        const route = await overflow.acquire();

        expect(route.slot).toBe('background');
        expect(lane.isFree).toBe(false);
        expect(overflow.blocksBackgroundJobs()).toBe(true);
        route.release();
        first.release();
        expect(lane.isFree).toBe(true);
    });

    it('treats queued hot work by other features as busy', async () => {
        workers.hot.queued = 1;

        expect((await overflow.acquire()).slot).toBe('background');
    });

    it('waits while both workers are busy and takes whichever frees first', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        expect([a.slot, b.slot]).toEqual(['hot', 'background']);

        const c = overflow.acquire();
        const d = overflow.acquire();
        expect(await settled(c)).toBe(false);
        expect(overflow.getStats()).toMatchObject({ waiting: 2 });
        expect(overflow.blocksBackgroundJobs()).toBe(true);

        // The background request finishes first: the oldest waiter takes it.
        b.release();
        const cRoute = await c;
        expect(cRoute).toEqual({ slot: 'background', release: expect.any(Function) });
        expect(await settled(d)).toBe(false);

        a.release();
        const dRoute = await d;
        // Waited for hot while the background worker was busy.
        expect(dRoute).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
        expect(overflow.getStats().decisions).toMatchObject({ queued: 2, claimed_background: 1, claimed_hot: 1 });
        cRoute.release();
        dRoute.release();
        expect(onDrained).toHaveBeenCalled();
    });

    it('keeps a request waiting when the warm-up fails and hands it the worker once it is ready', async () => {
        workers.background = null;
        const hot = await overflow.acquire();

        const waiting = overflow.acquire();
        expect(workers.background!.prewarm).toHaveBeenCalledTimes(1);
        expect(lane.isFree).toBe(true);
        // The warm-up settles but leaves the worker cold.
        await vi.waitFor(() => expect(overflow.getStats().prewarming).toBe(false));
        expect(await settled(waiting)).toBe(false);

        workers.background!.warm = true;
        overflow.onJobSettled();
        const route = await waiting;
        expect(route.slot).toBe('background');
        route.release();
        hot.release();
    });

    it('claims the background worker when the warm-up it started finishes', async () => {
        let finishWarmup!: () => void;
        workers.background = backgroundClient(false);
        workers.background.prewarm.mockImplementation(() => new Promise<void>((resolve) => {
            finishWarmup = resolve;
        }));
        const hot = await overflow.acquire();

        const waiting = overflow.acquire();
        expect(overflow.getStats()).toMatchObject({ prewarming: true, waiting: 1 });
        expect(await settled(waiting)).toBe(false);

        workers.background.warm = true;
        finishWarmup();
        const route = await waiting;
        expect(route.slot).toBe('background');
        expect(overflow.getStats().decisions).toMatchObject({ bg_not_warm: 1, claimed_background: 1 });
        route.release();
        hot.release();
    });

    it('warms the background worker again for waiting requests when it went cold', async () => {
        const hot = await overflow.acquire();
        const background = await overflow.acquire();
        const waiting = overflow.acquire();
        expect(await settled(waiting)).toBe(false);

        // The background request ends with its worker terminated (abort or recycle).
        workers.background!.warm = false;
        background.release();
        expect(workers.background!.prewarm).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(overflow.getStats().prewarming).toBe(false));
        // That warm-up left it cold: no retry loop, the request keeps waiting.
        expect(workers.background!.prewarm).toHaveBeenCalledTimes(1);
        expect(await settled(waiting)).toBe(false);

        workers.background!.warm = true;
        workers.background!.prewarm.mockClear();
        hot.release();
        expect((await waiting).slot).toBe('hot');
    });

    it('waits for the running background job to settle rather than interrupting it', async () => {
        const hot = await overflow.acquire();
        jobInFlight = true;

        const waiting = overflow.acquire();
        expect(await settled(waiting)).toBe(false);
        expect(workers.background!.prewarm).not.toHaveBeenCalled();

        jobInFlight = false;
        overflow.onJobSettled();
        expect((await waiting).slot).toBe('background');
        hot.release();
    });

    it('goes to hot at once when hot is busy only with work outside the router', async () => {
        workers.hot.inFlight = 1;
        jobInFlight = true;

        // No routed request would wake a waiter, so it queues on the hot worker as before.
        expect(await overflow.acquire()).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
        expect(overflow.getStats().waiting).toBe(0);
    });

    it('queues on hot when the background worker has its own work', async () => {
        workers.hot.inFlight = 1;
        workers.background!.inFlight = 1;

        expect(await overflow.acquire()).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
    });

    it('keeps everything on hot, without waiting, when the kill switch is off', async () => {
        setOverflowPref(false);
        const first = await overflow.acquire();

        const second = overflow.acquire();
        expect(await settled(second)).toBe(true);
        expect(await second).toMatchObject({ slot: 'hot', overflowSkip: 'disabled' });
        expect(workers.background!.prewarm).not.toHaveBeenCalled();
        expect(lane.isFree).toBe(true);
        first.release();
    });

    it('does not use the background worker while the background extractor is unavailable', async () => {
        available = false;
        workers.hot.inFlight = 1;

        expect(await overflow.acquire()).toMatchObject({ slot: 'hot', overflowSkip: 'disabled' });
    });

    it('rejects a waiting request whose deadline passes and removes it from the queue', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        const controller = new AbortController();

        const waiting = overflow.acquire({ signal: controller.signal });
        controller.abort();

        await expect(waiting).rejects.toMatchObject({ name: 'WorkerAbortError' });
        expect(overflow.getStats()).toMatchObject({ waiting: 0, decisions: { aborted: 1 } });
        a.release();
        b.release();
        expect(overflow.blocksBackgroundJobs()).toBe(false);
    });

    it('sends requests beyond the waiting limit to hot, whose op queue applies its own limit', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        const waiting = Array.from({ length: 32 }, () => overflow.acquire());
        expect(overflow.getStats().waiting).toBe(32);

        const extra = await overflow.acquire();
        expect(extra).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
        expect(overflow.getStats().waiting).toBe(32);

        extra.release();
        a.release();
        b.release();
        for (const pending of waiting) (await pending).release();
        expect(overflow.getStats()).toMatchObject({ waiting: 0, hotRoutes: 0, overflowRoutes: 0 });
    });

    it('keeps arrival order: a new request waits behind earlier ones', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        const order: string[] = [];
        const c = overflow.acquire().then((r) => { order.push('c'); return r; });
        const d = overflow.acquire().then((r) => { order.push('d'); return r; });

        a.release();
        await c;
        b.release();
        await d;
        expect(order).toEqual(['c', 'd']);
    });

    it('prefers the worker that last handled the same file when both are free', async () => {
        const hot = await overflow.acquire({ affinityKey: '1/AAAA' });
        const background = await overflow.acquire({ affinityKey: '1/BBBB' });
        background.release();
        hot.release();

        expect((await overflow.acquire({ affinityKey: '1/BBBB' })).slot).toBe('background');
        expect(overflow.getStats().decisions.affinity).toBe(1);
    });

    it('wakes the dispatcher only when no interactive work is left', async () => {
        const hot = await overflow.acquire();
        const background = await overflow.acquire();

        background.release();
        expect(onDrained).not.toHaveBeenCalled();
        hot.release();
        hot.release();
        expect(onDrained).toHaveBeenCalledTimes(1);
        expect(overflow.blocksBackgroundJobs()).toBe(false);
    });
});

describe('MuPDFSerialLane.tryAcquire', () => {
    it('takes a free lane and makes queued jobs wait for its release', async () => {
        const lane = new MuPDFSerialLane();
        const release = lane.tryAcquire()!;
        expect(release).toBeTypeOf('function');
        expect(lane.tryAcquire()).toBeNull();

        let ran = false;
        const job = lane.run(async () => {
            ran = true;
        });
        await Promise.resolve();
        expect(ran).toBe(false);

        release();
        release();
        await job;
        expect(ran).toBe(true);
        expect(lane.isFree).toBe(true);
    });

    it('refuses while a job holds or waits for the lane', async () => {
        const lane = new MuPDFSerialLane();
        let finish!: () => void;
        const job = lane.run(() => new Promise<void>((resolve) => {
            finish = resolve;
        }));
        expect(lane.tryAcquire()).toBeNull();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(lane.tryAcquire()).toBeNull();
        finish();
        await job;
        expect(lane.tryAcquire()).not.toBeNull();
    });
});

describe('PdfRequestWorker', () => {
    let lane: MuPDFSerialLane;
    let overflow: InteractiveOverflow;

    beforeEach(() => {
        vi.clearAllMocks();
        workers.hot = { inFlight: 0, queued: 0 };
        workers.background = backgroundClient(true);
        setOverflowPref(undefined);
        lane = new MuPDFSerialLane();
        overflow = new InteractiveOverflow({
            lane,
            isAvailable: () => true,
            hasWorkerJobInFlight: () => false,
            onDrained: vi.fn(),
        });
        (globalThis as any).Zotero.Beaver = { backgroundExtractor: { interactiveOverflow: overflow } };
    });

    it('routes an op that starts after the request finished on a fresh route', async () => {
        workers.hot.inFlight = 1;
        const worker = new PdfRequestWorker({ interactive: true, workerName: 'hot' });

        await worker.run(async (client) => {
            expect(client).toBe(workers.background);
            expect(lane.isFree).toBe(false);
        });
        worker.close();
        expect(lane.isFree).toBe(true);

        // A shared extraction the request led starts late; it must own the
        // background worker again rather than run on it unguarded.
        const late = vi.fn(async () => {
            expect(lane.isFree).toBe(false);
        });
        await worker.run(late);
        expect(late).toHaveBeenCalledWith(workers.background);
        expect(lane.isFree).toBe(true);
        expect(overflow.getStats()).toMatchObject({ overflowRoutes: 0, decisions: { overflow: 2 } });
    });

    it('waits for a worker, keeps it for every op, and reports the wait', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        const worker = new PdfRequestWorker({ interactive: true, workerName: 'hot' });

        const first = worker.run(async (client) => client);
        expect(await settled(first)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        b.release();
        expect(await first).toBe(workers.background);
        // Hot frees up meanwhile; the request's next op stays on background.
        a.release();
        expect(await worker.run(async (client) => client)).toBe(workers.background);
        expect(worker.slot).toBe('background');
        expect(worker.routeWaitMs).toBeGreaterThanOrEqual(15);
        worker.close();
        expect(lane.isFree).toBe(true);
    });

    it('shares one pending wait between concurrent ops of the same request', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        const worker = new PdfRequestWorker({ interactive: true, workerName: 'hot' });

        const one = worker.run(async (client) => client);
        const two = worker.run(async (client) => client);
        a.release();
        expect(await one).toBe(workers.hot);
        expect(await two).toBe(workers.hot);
        expect(overflow.getStats().decisions.queued).toBe(1);
        worker.close();
        b.release();
    });

    it('waits for a worker on the signal an op passes, not the request deadline', async () => {
        const a = await overflow.acquire();
        const b = await overflow.acquire();
        const request = new AbortController();
        const shared = new AbortController();
        const worker = new PdfRequestWorker({ interactive: true, workerName: 'hot', signal: request.signal });

        const op = worker.run(async (client) => client, { signal: shared.signal });
        // The request that started the shared work times out; the work keeps waiting.
        request.abort();
        expect(await settled(op)).toBe(false);
        a.release();
        expect(await op).toBe(workers.hot);

        // Aborting the op's own signal does end its wait.
        const late = new PdfRequestWorker({ interactive: true, workerName: 'hot' });
        const lateShared = new AbortController();
        const waiting = late.run(async (client) => client, { signal: lateShared.signal });
        lateShared.abort();
        await expect(waiting).rejects.toMatchObject({ name: 'WorkerAbortError' });
        worker.close();
        b.release();
    });

    it('never routes non-interactive requests', async () => {
        workers.hot.inFlight = 1;
        const worker = new PdfRequestWorker({ interactive: false, workerName: 'background' });

        expect(await worker.run(async (client) => client)).toBe(workers.background);
        expect(lane.isFree).toBe(true);
        expect(overflow.getStats().decisions).toMatchObject({ hot_idle: 0, overflow: 0 });
        worker.close();
    });
});
