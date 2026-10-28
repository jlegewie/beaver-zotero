/**
 * MuPDFWorkerClient warm-up (`prewarm` / `__warmup`): one warm-up per fresh
 * worker, calls that arrive meanwhile wait for it, it never counts as a data
 * operation or an extraction, and the first real extraction reports
 * `workerState: 'warmed'`. Also the hot slot's idle timeout, per-call heap
 * timings and the queued-call count. Uses the in-process MockWorker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MockWorker,
    setupZoteroMainWindowWithMockWorker,
} from '../../helpers/mockWorker';
import {
    MuPDFWorkerClient,
    WorkerAbortError,
    disposeMuPDFWorker,
    getMuPDFWorkerClient,
    type WorkerCallTiming,
} from '../../../src/beaver-extract/MuPDFWorkerClient';
import { configurePDF, getConfig } from '../../../src/beaver-extract/config';
import { prewarmMuPDFWorker } from '../../../src/beaver-extract/prewarm';

const WARMUP_RESULT = { mupdfMs: 5, sentencexMs: 10, extractMs: 300 };
const extractArgs = { mode: 'structured' as const, settings: { checkTextLayer: true } };
const serialized = {
    mode: 'structured',
    schemaVersion: '5',
    pageCount: 1,
    byteLength: 2,
    jsonBytes: new Uint8Array([123, 125]),
    cacheMetadata: { pageCount: 1, pageLabels: {}, pages: [] },
};

function currentWorker(): MockWorker {
    return MockWorker.instances[MockWorker.instances.length - 1];
}

function opsPosted(worker: MockWorker): string[] {
    return worker.posted.map((entry) => entry.message.op);
}

/** Reply to the posted op named `op` (the most recent one with that name). */
function replyTo(worker: MockWorker, op: string, reply: Record<string, unknown>): void {
    const entry = [...worker.posted].reverse().find((e) => e.message.op === op);
    worker.onmessage?.({ data: { id: entry?.message.id, ...reply } });
}

describe('MuPDFWorkerClient warm-up', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        MockWorker.dropNextConfigureAck = false;
        setupZoteroMainWindowWithMockWorker();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await disposeMuPDFWorker();
    });

    it('starts a worker and warms it up once; later prewarms send nothing', async () => {
        const client = new MuPDFWorkerClient();
        try {
            const first = client.prewarm();
            const second = client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            expect(MockWorker.instances).toHaveLength(1);
            expect(opsPosted(worker)).toEqual(['__warmup']);
            expect(client.getStats()).toMatchObject({ warmupCount: 1, warmupInFlight: true, warmedUp: false });

            replyTo(worker, '__warmup', { ok: true, result: WARMUP_RESULT, heapBytes: 64 });
            await expect(first).resolves.toBeUndefined();
            await expect(second).resolves.toBeUndefined();
            await client.prewarm();
            expect(opsPosted(worker)).toEqual(['__warmup']);
            expect(client.getStats()).toMatchObject({
                warmupCount: 1,
                warmupInFlight: false,
                warmedUp: true,
                dispatchCounts: {},
                completedDataOperationsSinceSpawn: 0,
            });
        } finally {
            client.dispose();
        }
    });

    it('reports warm only once a started worker finished its warm-up or an extraction', async () => {
        const client = new MuPDFWorkerClient({ slotName: 'background' });
        try {
            expect(client.isWarm()).toBe(false);
            const warmup = client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            expect(client.isWarm()).toBe(false);
            const worker = currentWorker();
            replyTo(worker, '__warmup', { ok: true, result: WARMUP_RESULT });
            await warmup;
            expect(client.isWarm()).toBe(true);

            // Aborting an op terminates the worker; the next use starts a cold one.
            const controller = new AbortController();
            const extraction = client.extractSerialized(new Uint8Array([1]), extractArgs, controller.signal);
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            await expect(extraction).rejects.toBeInstanceOf(WorkerAbortError);
            expect(worker.terminate).toHaveBeenCalled();
            expect(client.isWarm()).toBe(false);

            const next = client.extractSerialized(new Uint8Array([2]), extractArgs);
            await vi.advanceTimersByTimeAsync(0);
            const fresh = currentWorker();
            expect(fresh).not.toBe(worker);
            replyTo(fresh, 'extractSerialized', { ok: true, result: serialized });
            await next;
            expect(client.isWarm()).toBe(true);
        } finally {
            client.dispose();
        }
    });

    it('prewarmMuPDFWorker warms the hot slot', async () => {
        prewarmMuPDFWorker();
        await vi.advanceTimersByTimeAsync(0);
        expect(opsPosted(currentWorker())).toEqual(['__warmup']);
        expect(getMuPDFWorkerClient().getStats().warmupCount).toBe(1);
    });

    it('holds a call until the warm-up finishes, then reports the first extraction as warmed', async () => {
        const client = new MuPDFWorkerClient();
        try {
            void client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();

            const timing: WorkerCallTiming = {};
            const extraction = client.extractSerialized(new Uint8Array([1]), extractArgs, undefined, timing);
            await vi.advanceTimersByTimeAsync(0);
            expect(opsPosted(worker)).toEqual(['__warmup']);
            expect(client.inFlight).toBe(2);

            replyTo(worker, '__warmup', { ok: true, result: WARMUP_RESULT });
            await vi.advanceTimersByTimeAsync(0);
            expect(opsPosted(worker)).toEqual(['__warmup', 'extractSerialized']);
            replyTo(worker, 'extractSerialized', { ok: true, result: serialized, opMs: 40 });
            await expect(extraction).resolves.toEqual(serialized);
            expect(timing.workerState).toBe('warmed');

            const nextTiming: WorkerCallTiming = {};
            const next = client.extractSerialized(new Uint8Array([2]), extractArgs, undefined, nextTiming);
            replyTo(worker, 'extractSerialized', { ok: true, result: serialized });
            await next;
            expect(nextTiming.workerState).toBe('warm');
        } finally {
            client.dispose();
        }
    });

    it('reports first_extract without a warm-up, or when the warm-up failed', async () => {
        const plain = new MuPDFWorkerClient();
        try {
            const timing: WorkerCallTiming = {};
            const extraction = plain.extractSerialized(new Uint8Array([1]), extractArgs, undefined, timing);
            await vi.advanceTimersByTimeAsync(0);
            replyTo(currentWorker(), 'extractSerialized', { ok: true, result: serialized });
            await extraction;
            expect(timing.workerState).toBe('first_extract');
        } finally {
            plain.dispose();
        }

        const log = vi.fn();
        configurePDF({ ...getConfig(), log });
        const failed = new MuPDFWorkerClient();
        try {
            const warmup = failed.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            replyTo(worker, '__warmup', { ok: false, error: { name: 'Error', message: 'no text' } });
            await expect(warmup).resolves.toBeUndefined();
            expect(log).toHaveBeenCalledWith(expect.stringContaining('warm-up failed: no text'), 2);
            expect(worker.terminate).not.toHaveBeenCalled();

            const timing: WorkerCallTiming = {};
            const extraction = failed.extractSerialized(new Uint8Array([1]), extractArgs, undefined, timing);
            await vi.advanceTimersByTimeAsync(0);
            replyTo(worker, 'extractSerialized', { ok: true, result: serialized });
            await extraction;
            expect(timing.workerState).toBe('first_extract');
            // A worker gets one warm-up attempt.
            await failed.prewarm();
            expect(opsPosted(worker)).toEqual(['__warmup', 'extractSerialized']);
        } finally {
            failed.dispose();
        }
    });

    it('a caller that gives up waiting for the warm-up leaves the worker running', async () => {
        const client = new MuPDFWorkerClient();
        try {
            void client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();

            const controller = new AbortController();
            const call = client.getPageCount(new Uint8Array([1]), controller.signal);
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            await expect(call).rejects.toBeInstanceOf(WorkerAbortError);
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(client.getStats()).toMatchObject({ hasWorker: true, warmupInFlight: true });
            expect(client.inFlight).toBe(1);

            replyTo(worker, '__warmup', { ok: true, result: WARMUP_RESULT });
            await vi.advanceTimersByTimeAsync(0);
            expect(opsPosted(worker)).toEqual(['__warmup']);
            expect(client.getStats()).toMatchObject({ warmedUp: true, hasWorker: true });
        } finally {
            client.dispose();
        }
    });

    it('sends a waiting call after 10 s when the warm-up stalls', async () => {
        const client = new MuPDFWorkerClient();
        try {
            void client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            const call = client.getPageCount(new Uint8Array([1]));
            await vi.advanceTimersByTimeAsync(9_999);
            expect(opsPosted(worker)).toEqual(['__warmup']);
            await vi.advanceTimersByTimeAsync(1);
            expect(opsPosted(worker)).toEqual(['__warmup', 'getPageCount']);
            replyTo(worker, 'getPageCount', { ok: true, result: { count: 2 } });
            await expect(call).resolves.toBe(2);
        } finally {
            client.dispose();
        }
    });

    it('never counts the warm-up toward recycling', async () => {
        const client = new MuPDFWorkerClient({ recycleAfterDataOperations: 1, recycleHeapBytes: null });
        try {
            void client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            replyTo(worker, '__warmup', { ok: true, result: WARMUP_RESULT, heapBytes: 64 });
            await vi.advanceTimersByTimeAsync(0);
            expect(client.getStats()).toMatchObject({
                completedDataOperationsSinceSpawn: 0,
                proactiveRecyclePending: false,
            });
            expect(worker.terminate).not.toHaveBeenCalled();
        } finally {
            client.dispose();
        }
    });

    it('skips the warm-up on a worker that already ran an extraction or is busy', async () => {
        const client = new MuPDFWorkerClient();
        try {
            const busy = client.getPageCount(new Uint8Array([1]));
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            await client.prewarm();
            expect(opsPosted(worker)).toEqual(['getPageCount']);
            replyTo(worker, 'getPageCount', { ok: true, result: { count: 1 } });
            await busy;

            const extraction = client.extractSerialized(new Uint8Array([1]), extractArgs);
            replyTo(worker, 'extractSerialized', { ok: true, result: serialized });
            await extraction;
            await client.prewarm();
            expect(opsPosted(worker)).toEqual(['getPageCount', 'extractSerialized']);
            expect(client.getStats()).toMatchObject({ warmupCount: 0, idleTimerArmed: true });
        } finally {
            client.dispose();
        }
    });

    it('a prewarm on an idle warm worker restarts its idle timeout', async () => {
        const client = new MuPDFWorkerClient({ idleTimeoutMs: 1_000 });
        try {
            void client.prewarm();
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            replyTo(worker, '__warmup', { ok: true, result: WARMUP_RESULT });
            await vi.advanceTimersByTimeAsync(800);
            await client.prewarm();
            await vi.advanceTimersByTimeAsync(800);
            expect(worker.terminate).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(200);
            expect(worker.terminate).toHaveBeenCalledOnce();
        } finally {
            client.dispose();
        }
    });
});

describe('MuPDFWorkerClient hot-slot defaults and telemetry', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        MockWorker.dropNextConfigureAck = false;
        setupZoteroMainWindowWithMockWorker();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await disposeMuPDFWorker();
    });

    it('keeps an idle hot worker for 10 minutes and a background worker for 1 minute', async () => {
        const hot = new MuPDFWorkerClient({ slotName: 'hot' });
        const background = new MuPDFWorkerClient({ slotName: 'background' });
        try {
            const hotCall = hot.getPageCount(new Uint8Array([1]));
            await vi.advanceTimersByTimeAsync(0);
            const hotWorker = currentWorker();
            replyTo(hotWorker, 'getPageCount', { ok: true, result: { count: 1 } });
            await hotCall;
            const backgroundCall = background.getPageCount(new Uint8Array([1]));
            await vi.advanceTimersByTimeAsync(0);
            const backgroundWorker = currentWorker();
            replyTo(backgroundWorker, 'getPageCount', { ok: true, result: { count: 1 } });
            await backgroundCall;

            await vi.advanceTimersByTimeAsync(60_000);
            expect(backgroundWorker.terminate).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(10 * 60_000 - 60_001);
            expect(hotWorker.terminate).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(hotWorker.terminate).toHaveBeenCalledOnce();
        } finally {
            hot.dispose();
            background.dispose();
        }
    });

    it('reports the heap after an op and the client peak on its timing', async () => {
        const client = new MuPDFWorkerClient({ recycleHeapBytes: null });
        try {
            const first = client.getPageCount(new Uint8Array([1]));
            await vi.advanceTimersByTimeAsync(0);
            const worker = currentWorker();
            replyTo(worker, 'getPageCount', { ok: true, result: { count: 1 }, heapBytes: 400 });
            await first;

            const timing: WorkerCallTiming = {};
            const extraction = client.extractSerialized(new Uint8Array([1]), extractArgs, undefined, timing);
            replyTo(worker, 'extractSerialized', { ok: true, result: serialized, heapBytes: 300 });
            await extraction;
            expect(timing).toMatchObject({ heapBytes: 300, peakHeapBytes: 400 });
            expect(client.heapBytes).toBe(300);
        } finally {
            client.dispose();
        }
    });

    it('counts calls waiting in the work queue separately from accepted ones', async () => {
        configurePDF({ ...getConfig(), maxQueuedOperations: 32 });
        const client = new MuPDFWorkerClient();
        try {
            const calls = [1, 2, 3].map((n) => client.getPageCount(new Uint8Array([n])));
            await vi.advanceTimersByTimeAsync(0);
            expect(client.inFlight).toBe(1);
            expect(client.queued).toBe(2);
            const worker = currentWorker();
            for (let i = 0; i < 3; i++) {
                replyTo(worker, 'getPageCount', { ok: true, result: { count: i } });
                await vi.advanceTimersByTimeAsync(0);
            }
            await Promise.all(calls);
            expect(client.queued).toBe(0);
        } finally {
            client.dispose();
        }
    });
});
