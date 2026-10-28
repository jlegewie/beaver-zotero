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

describe('InteractiveOverflow routing', () => {
    let lane: MuPDFSerialLane;
    let jobInFlight: boolean;
    let onDrained: ReturnType<typeof vi.fn>;
    let overflow: InteractiveOverflow;

    beforeEach(() => {
        vi.clearAllMocks();
        workers.hot = { inFlight: 0, queued: 0 };
        workers.background = backgroundClient(true);
        setOverflowPref(undefined);
        lane = new MuPDFSerialLane();
        jobInFlight = false;
        onDrained = vi.fn();
        overflow = new InteractiveOverflow({
            lane,
            isAvailable: () => true,
            hasWorkerJobInFlight: () => jobInFlight,
            onDrained,
        });
    });

    it('uses hot while the hot worker is idle', () => {
        const route = overflow.route();

        expect(route).toEqual({ slot: 'hot', release: expect.any(Function) });
        expect(lane.isFree).toBe(true);
        expect(overflow.getStats().decisions.hot_idle).toBe(1);
    });

    it('overflows to a warm background worker when hot is busy and the lane is free', () => {
        workers.hot.inFlight = 1;

        const route = overflow.route();

        expect(route.slot).toBe('background');
        expect(lane.isFree).toBe(false);
        expect(overflow.blocksBackgroundJobs()).toBe(true);
        route.release();
        expect(lane.isFree).toBe(true);
    });

    it('treats queued hot work as busy', () => {
        workers.hot.queued = 1;

        expect(overflow.route().slot).toBe('background');
    });

    it('treats an open hot request as busy even between its worker ops', () => {
        const first = overflow.route();
        expect(first.slot).toBe('hot');

        expect(overflow.route().slot).toBe('background');
        first.release();
    });

    it('queues on hot when the lane is held, without starting a warm-up', () => {
        workers.hot.inFlight = 1;
        const releaseJob = lane.tryAcquire()!;

        const route = overflow.route();

        expect(route).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
        expect(workers.background!.prewarm).not.toHaveBeenCalled();
        releaseJob();
    });

    it('queues on hot while a background job is in flight outside the lane', () => {
        workers.hot.inFlight = 1;
        jobInFlight = true;

        expect(overflow.route()).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
        expect(lane.isFree).toBe(true);
    });

    it('queues on hot when the background worker has its own work', () => {
        workers.hot.inFlight = 1;
        workers.background!.inFlight = 1;

        expect(overflow.route()).toMatchObject({ slot: 'hot', overflowSkip: 'lane_busy' });
    });

    it('never sends a request to a cold background worker; it warms it for the next request', async () => {
        workers.hot.inFlight = 1;
        workers.background = null;

        const first = overflow.route();

        expect(first).toMatchObject({ slot: 'hot', overflowSkip: 'bg_not_warm' });
        expect(workers.background!.prewarm).toHaveBeenCalledTimes(1);
        expect(lane.isFree).toBe(true);
        expect(overflow.getStats().prewarming).toBe(true);

        // Still warming: a second request also stays on hot, with no second warm-up.
        expect(overflow.route()).toMatchObject({ slot: 'hot', overflowSkip: 'bg_not_warm' });
        expect(workers.background!.prewarm).toHaveBeenCalledTimes(1);

        workers.background!.warm = true;
        await vi.waitFor(() => expect(overflow.getStats().prewarming).toBe(false));
        expect(overflow.route().slot).toBe('background');
        expect(overflow.getStats().decisions).toMatchObject({ bg_not_warm: 2, overflow: 1 });
    });

    it('keeps everything on hot when the kill switch is off', () => {
        setOverflowPref(false);
        workers.hot.inFlight = 1;

        expect(overflow.route()).toMatchObject({ slot: 'hot', overflowSkip: 'disabled' });
        expect(workers.background!.prewarm).not.toHaveBeenCalled();
        expect(lane.isFree).toBe(true);
    });

    it('does not overflow while the background extractor is unavailable', () => {
        overflow = new InteractiveOverflow({
            lane,
            isAvailable: () => false,
            hasWorkerJobInFlight: () => false,
            onDrained,
        });
        workers.hot.inFlight = 1;

        expect(overflow.route()).toMatchObject({ slot: 'hot', overflowSkip: 'disabled' });
    });

    it('wakes the dispatcher when the last interactive route is released', () => {
        workers.hot.inFlight = 1;
        const overflowRoute = overflow.route();
        workers.hot.inFlight = 0;
        const hotRoute = overflow.route();
        expect(hotRoute.slot).toBe('hot');

        overflowRoute.release();
        expect(onDrained).not.toHaveBeenCalled();
        hotRoute.release();
        hotRoute.release();
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
    beforeEach(() => {
        vi.clearAllMocks();
        workers.hot = { inFlight: 0, queued: 0 };
        workers.background = backgroundClient(true);
        setOverflowPref(undefined);
    });

    it('routes an op that starts after the request finished on a fresh route', async () => {
        const lane = new MuPDFSerialLane();
        const overflow = new InteractiveOverflow({
            lane,
            isAvailable: () => true,
            hasWorkerJobInFlight: () => false,
            onDrained: vi.fn(),
        });
        (globalThis as any).Zotero.Beaver = { backgroundExtractor: { interactiveOverflow: overflow } };
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
});
