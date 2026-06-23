import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

// The fix suppresses the auto-sync spinner via three additional runner APIs.
// Install them as spies on every mock runner so the module's suppress/restore
// calls work and can be asserted via `globalThis.Zotero.Sync.Runner`.
async function loadSyncPause(delayIndefinite?: () => () => void) {
    vi.resetModules();
    const runner: any = {
        clearSyncTimeout: vi.fn(),
        delaySync: vi.fn(),
        setSyncTimeout: vi.fn(),
    };
    if (delayIndefinite) {
        runner.delayIndefinite = delayIndefinite;
    }
    (globalThis as any).Zotero.Sync.Runner = runner;
    return import('../../../src/services/syncPause');
}

function runner() {
    return (globalThis as any).Zotero.Sync.Runner;
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

    it('does not let one owner release another active owner', async () => {
        const resume = vi.fn();
        const delayIndefinite = vi.fn(() => resume);
        const {
            pauseSyncForMutatingRun,
            scheduleResumeAfterRun,
            RELEASE_DEBOUNCE_MS,
        } = await loadSyncPause(delayIndefinite);

        pauseSyncForMutatingRun('local');
        pauseSyncForMutatingRun('provider');
        scheduleResumeAfterRun('provider');

        await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);
        expect(resume).not.toHaveBeenCalled();

        scheduleResumeAfterRun('local');
        await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);
        expect(resume).toHaveBeenCalledTimes(1);
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

    describe('auto-sync spinner suppression', () => {
        it('cancels the pending auto-sync timer and arms the suppression window on pause', async () => {
            const resume = vi.fn();
            const { pauseSyncForMutatingRun, SAFETY_IDLE_MS } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();

            expect(runner().clearSyncTimeout).toHaveBeenCalled();
            expect(runner().delaySync).toHaveBeenCalledWith(SAFETY_IDLE_MS);
            // No sync is scheduled while paused.
            expect(runner().setSyncTimeout).not.toHaveBeenCalled();
        });

        it('re-applies suppression on every mutating action, even while already paused', async () => {
            const resume = vi.fn();
            const { pauseSyncForMutatingRun } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();
            pauseSyncForMutatingRun();
            pauseSyncForMutatingRun();

            // delayIndefinite is acquired once, but the spinner suppression is
            // refreshed each time so freshly-armed auto-sync timers stay covered.
            expect(runner().clearSyncTimeout).toHaveBeenCalledTimes(3);
            expect(runner().delaySync).toHaveBeenCalledTimes(3);
        });

        it('clears the window and reschedules one sync when a run completes', async () => {
            const resume = vi.fn();
            const {
                pauseSyncForMutatingRun,
                scheduleResumeAfterRun,
                RELEASE_DEBOUNCE_MS,
            } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();
            scheduleResumeAfterRun();
            await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);

            expect(resume).toHaveBeenCalledTimes(1);
            // Window dropped...
            expect(runner().delaySync).toHaveBeenLastCalledWith(0);
            // ...and a single, non-recurring auto-sync scheduled to push edits.
            expect(runner().setSyncTimeout).toHaveBeenCalledTimes(1);
            expect(runner().setSyncTimeout.mock.calls[0][1]).toBe(false);
        });

        it('clears the window but does not reschedule a sync on a direct resume', async () => {
            const resume = vi.fn();
            const { pauseSyncForMutatingRun, resumeSyncNow } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();
            resumeSyncNow();

            expect(resume).toHaveBeenCalledTimes(1);
            expect(runner().delaySync).toHaveBeenLastCalledWith(0);
            expect(runner().setSyncTimeout).not.toHaveBeenCalled();
        });

        it('does not reschedule a sync when the idle safety timer fires', async () => {
            const resume = vi.fn();
            const { pauseSyncForMutatingRun, SAFETY_IDLE_MS } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();
            await vi.advanceTimersByTimeAsync(SAFETY_IDLE_MS);

            expect(resume).toHaveBeenCalledTimes(1);
            expect(runner().delaySync).toHaveBeenLastCalledWith(0);
            expect(runner().setSyncTimeout).not.toHaveBeenCalled();
        });

        it('reschedules a sync through the window resume hook used on unload', async () => {
            // The plugin-disable / window-close path calls this hook with `true`
            // so an interrupted run still pushes its edits (hooks.ts onMainWindowUnload).
            const resume = vi.fn();
            const win: any = {};
            (globalThis as any).window = win;
            const { pauseSyncForMutatingRun } = await loadSyncPause(() => resume);

            expect(typeof win.__beaverResumeSyncAfterRun).toBe('function');

            pauseSyncForMutatingRun();
            win.__beaverResumeSyncAfterRun(true);

            expect(resume).toHaveBeenCalledTimes(1);
            expect(runner().delaySync).toHaveBeenLastCalledWith(0);
            expect(runner().setSyncTimeout).toHaveBeenCalledTimes(1);
        });

        it('does not reschedule a sync through the window resume hook when quitting', async () => {
            // During an app quit hooks.ts passes `false`: Zotero runs its own
            // shutdown sync, so arming a timer mid-teardown is pointless.
            const resume = vi.fn();
            const win: any = {};
            (globalThis as any).window = win;
            const { pauseSyncForMutatingRun } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();
            win.__beaverResumeSyncAfterRun(false);

            expect(resume).toHaveBeenCalledTimes(1);
            expect(runner().delaySync).toHaveBeenLastCalledWith(0);
            expect(runner().setSyncTimeout).not.toHaveBeenCalled();
        });

        it('does not touch runner suppression APIs when no pause was held', async () => {
            const resume = vi.fn();
            const { resumeSyncNow } = await loadSyncPause(() => resume);

            resumeSyncNow(true);

            expect(resume).not.toHaveBeenCalled();
            expect(runner().delaySync).not.toHaveBeenCalled();
            expect(runner().setSyncTimeout).not.toHaveBeenCalled();
        });
    });
});
