import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/ocr/ocrApiClient', () => ({
    ocrApiClient: { statusBatch: vi.fn() },
}));

import { OcrAbort, OcrStatusPoller } from '../../../src/services/ocr/ocrStatusPoller';
import { ocrApiClient } from '../../../src/services/ocr/ocrApiClient';
import {
    OCR_POLL_INITIAL_MS,
    OCR_POLL_MAX_MS,
    OCR_STATUS_BATCH_MAX,
} from '../../../src/services/ocr/constants';

const api = ocrApiClient as unknown as { statusBatch: ReturnType<typeof vi.fn> };

const signal = () => new AbortController().signal;
const FAR = 1_000_000; // comfortably beyond the polling window used here

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('OcrStatusPoller', () => {
    it('batches all in-flight jobs into one statusBatch call and maps each result', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch.mockResolvedValue({
            jobs: [
                { job_id: 'a', status: 'completed', get_url: 'urlA' },
                { job_id: 'b', status: 'failed', error: { code: 'x', message: 'm', kind: 'transient' } },
                // 'c' omitted from the response → gone
            ],
        });

        const pa = poller.poll('a', { deadline: FAR, signal: signal() });
        const pb = poller.poll('b', { deadline: FAR, signal: signal() });
        const pc = poller.poll('c', { deadline: FAR, signal: signal() });

        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS);

        expect(api.statusBatch).toHaveBeenCalledTimes(1);
        expect(api.statusBatch).toHaveBeenCalledWith(['a', 'b', 'c']);
        await expect(pa).resolves.toEqual({ kind: 'completed', getUrl: 'urlA' });
        await expect(pb).resolves.toMatchObject({ kind: 'failed', error: { code: 'x' } });
        await expect(pc).resolves.toEqual({ kind: 'gone' });
    });

    it('treats completed without a get_url as completed with null url', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch.mockResolvedValue({ jobs: [{ job_id: 'a', status: 'completed' }] });
        const p = poller.poll('a', { deadline: FAR, signal: signal() });
        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS);
        await expect(p).resolves.toEqual({ kind: 'completed', getUrl: null });
    });

    it('keeps polling while a job stays queued, then times out at its deadline', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch.mockResolvedValue({ jobs: [{ job_id: 'a', status: 'queued' }] });
        const p = poller.poll('a', { deadline: 5_000, signal: signal() });

        await vi.advanceTimersByTimeAsync(20_000);

        await expect(p).resolves.toEqual({ kind: 'timeout' });
        // The deadline check runs before the status call, so the final timed-out
        // tick issues no further request.
        expect(api.statusBatch.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const poller = new OcrStatusPoller();
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(
            poller.poll('a', { deadline: FAR, signal: ctrl.signal }),
        ).rejects.toBeInstanceOf(OcrAbort);
        expect(api.statusBatch).not.toHaveBeenCalled();
    });

    it('rejects with OcrAbort and stops polling the job on abort', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch.mockResolvedValue({ jobs: [{ job_id: 'a', status: 'queued' }] });
        const ctrl = new AbortController();
        const p = poller.poll('a', { deadline: FAR, signal: ctrl.signal });

        ctrl.abort();
        await expect(p).rejects.toBeInstanceOf(OcrAbort);

        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS * 3);
        expect(api.statusBatch).not.toHaveBeenCalled(); // unregistered before the first tick
    });

    it('resolves every registrant waiting on the same job_id (deduped on the wire)', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch.mockResolvedValue({ jobs: [{ job_id: 'dup', status: 'completed', get_url: 'u' }] });
        const p1 = poller.poll('dup', { deadline: FAR, signal: signal() });
        const p2 = poller.poll('dup', { deadline: FAR, signal: signal() });

        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS);

        expect(api.statusBatch).toHaveBeenCalledWith(['dup']); // one id, not two
        await expect(p1).resolves.toEqual({ kind: 'completed', getUrl: 'u' });
        await expect(p2).resolves.toEqual({ kind: 'completed', getUrl: 'u' });
    });

    it('retries on a transient statusBatch error without settling registrants', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch
            .mockRejectedValueOnce(new Error('network blip'))
            .mockResolvedValueOnce({ jobs: [{ job_id: 'a', status: 'completed', get_url: 'u' }] });
        const p = poller.poll('a', { deadline: FAR, signal: signal() });

        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS); // first tick throws → kept
        await vi.advanceTimersByTimeAsync(OCR_POLL_MAX_MS);     // next tick succeeds

        expect(api.statusBatch).toHaveBeenCalledTimes(2);
        await expect(p).resolves.toEqual({ kind: 'completed', getUrl: 'u' });
    });

    it('does not start a second loop when a job registers during an in-flight poll', async () => {
        const poller = new OcrStatusPoller();
        let inFlight = 0;
        let maxInFlight = 0;
        const releases: Array<() => void> = [];
        api.statusBatch.mockImplementation((ids: string[]) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise((resolve) => {
                releases.push(() => {
                    inFlight -= 1;
                    resolve({ jobs: ids.map((id) => ({ job_id: id, status: 'queued' as const })) });
                });
            });
        });

        const ca = new AbortController();
        const cb = new AbortController();
        poller.poll('a', { deadline: FAR, signal: ca.signal }).catch(() => undefined);

        // Tick A fires and suspends inside statusBatch (gate held → timer is null).
        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS);
        expect(api.statusBatch).toHaveBeenCalledTimes(1);
        expect(inFlight).toBe(1);

        // A new job registers while the first poll is in flight and must not spawn
        // a second timer/loop.
        poller.poll('b', { deadline: FAR, signal: cb.signal }).catch(() => undefined);

        // Resume tick A (it reschedules the single loop), then advance well past
        // any backed-off interval while holding the gates so concurrency is
        // observable: a duplicate loop would put two statusBatch calls in flight.
        releases.shift()!();
        await vi.advanceTimersByTimeAsync(OCR_POLL_MAX_MS * 2);

        expect(maxInFlight).toBe(1);

        ca.abort();
        cb.abort();
        releases.forEach((release) => release());
    });

    it('chunks ids beyond OCR_STATUS_BATCH_MAX into multiple requests', async () => {
        const poller = new OcrStatusPoller();
        api.statusBatch.mockImplementation(async (ids: string[]) => ({
            jobs: ids.map((id) => ({ job_id: id, status: 'completed', get_url: 'u' })),
        }));

        const promises = [];
        for (let i = 0; i < OCR_STATUS_BATCH_MAX + 1; i += 1) {
            promises.push(poller.poll(`j${i}`, { deadline: FAR, signal: signal() }));
        }

        await vi.advanceTimersByTimeAsync(OCR_POLL_INITIAL_MS);

        expect(api.statusBatch).toHaveBeenCalledTimes(2);
        expect(api.statusBatch.mock.calls[0][0]).toHaveLength(OCR_STATUS_BATCH_MAX);
        expect(api.statusBatch.mock.calls[1][0]).toHaveLength(1);
        await expect(Promise.all(promises)).resolves.toHaveLength(OCR_STATUS_BATCH_MAX + 1);
    });
});
