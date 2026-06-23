import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

async function loadSyncPause(delayIndefinite?: () => () => void) {
    vi.resetModules();
    (globalThis as any).Zotero.Sync.Runner = delayIndefinite
        ? { delayIndefinite }
        : {};
    return import('../../../src/services/syncPause');
}

describe('syncPause', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.resetModules();
        (globalThis as any).Zotero.Sync.Runner = {
            syncInProgress: false,
        };
        delete (globalThis as any).window;
    });

    it('acquires the Zotero sync pause exactly once across repeated mutating actions', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const { pauseSyncForMutatingRun } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun();
        pauseSyncForMutatingRun();
        pauseSyncForMutatingRun();

        expect(delayIndefinite).toHaveBeenCalledTimes(1);
        expect(resume).not.toHaveBeenCalled();
    });

    it('resumes once after the release debounce elapses', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const {
            pauseSyncForMutatingRun,
            scheduleResumeAfterRun,
            RELEASE_DEBOUNCE_MS,
        } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun();
        scheduleResumeAfterRun();

        await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS - 1);
        expect(resume).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('cancels a scheduled resume when the run becomes active again', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const {
            pauseSyncForMutatingRun,
            scheduleResumeAfterRun,
            cancelScheduledResume,
            RELEASE_DEBOUNCE_MS,
        } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun();
        scheduleResumeAfterRun();
        cancelScheduledResume();

        await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);
        expect(resume).not.toHaveBeenCalled();
    });

    it('resumes immediately and is idempotent', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const { pauseSyncForMutatingRun, resumeSyncNow } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun();
        resumeSyncNow();
        resumeSyncNow();

        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('releases through the idle safety timer', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const { pauseSyncForMutatingRun, SAFETY_IDLE_MS } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun();

        await vi.advanceTimersByTimeAsync(SAFETY_IDLE_MS - 1);
        expect(resume).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('re-arms the idle safety timer on each mutating action', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const { pauseSyncForMutatingRun, SAFETY_IDLE_MS } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun();
        await vi.advanceTimersByTimeAsync(SAFETY_IDLE_MS - 1000);
        pauseSyncForMutatingRun();

        await vi.advanceTimersByTimeAsync(SAFETY_IDLE_MS - 1);
        expect(resume).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('does not throw when Zotero lacks delayIndefinite', async () => {
        const { pauseSyncForMutatingRun, resumeSyncNow } = await loadSyncPause();

        expect(() => pauseSyncForMutatingRun()).not.toThrow();
        expect(() => resumeSyncNow()).not.toThrow();
    });
});
