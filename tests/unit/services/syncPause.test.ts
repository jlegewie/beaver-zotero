import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

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
    const module = await import('../../../src/services/syncPause');
    return { ...module, ...module.createSyncPauseService() };
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
            const { pauseSyncForMutatingRun, resumeSyncNow } = await loadSyncPause(() => resume);

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

        it('reschedules sync on explicit instance release', async () => {
            // The plugin-disable / window-close path calls this hook with `true`
            // so an interrupted run still pushes its edits (hooks.ts onMainWindowUnload).
            const resume = vi.fn();
            const win: any = {};
            (globalThis as any).window = win;
            const { pauseSyncForMutatingRun, resumeSyncNow } = await loadSyncPause(() => resume);


            pauseSyncForMutatingRun();
            resumeSyncNow(true);

            expect(resume).toHaveBeenCalledTimes(1);
            expect(runner().delaySync).toHaveBeenLastCalledWith(0);
            expect(runner().setSyncTimeout).toHaveBeenCalledTimes(1);
        });

        it('does not reschedule sync on instance disposal', async () => {
            // During an app quit hooks.ts passes `false`: Zotero runs its own
            // shutdown sync, so arming a timer mid-teardown is pointless.
            const resume = vi.fn();
            const win: any = {};
            (globalThis as any).window = win;
            const { pauseSyncForMutatingRun, resumeSyncNow } = await loadSyncPause(() => resume);

            pauseSyncForMutatingRun();
            resumeSyncNow(false);

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

it('closing one window retains another run and an executing write', async () => {
    vi.useFakeTimers();
    try {
        const resume = vi.fn();
        const service = await loadSyncPause(() => resume);
        service.pauseSyncForMutatingRun('chat:A:run-1');
        service.pauseSyncForMutatingRun('chat:B:run-2');
        service.pauseSyncForMutatingRun('mutation:1');
        service.releaseWindow('A');
        await vi.advanceTimersByTimeAsync(service.RELEASE_DEBOUNCE_MS);
        expect(resume).not.toHaveBeenCalled();
        service.releaseWindow('B');
        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS - service.RELEASE_DEBOUNCE_MS - 1);
        expect(resume).not.toHaveBeenCalled();
        service.scheduleResumeAfterRun('mutation:1');
        await vi.advanceTimersByTimeAsync(service.RELEASE_DEBOUNCE_MS);
        expect(resume).toHaveBeenCalledOnce();
    } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
    }
});

describe('syncPause leases', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.resetModules();
        (globalThis as any).Zotero.Sync.Runner = { syncInProgress: false };
    });

    it('releases sync when a write never settles', async () => {
        const resume = vi.fn();
        const service = await loadSyncPause(() => resume);
        service.pauseSyncForMutatingRun('mutation:1');

        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS - 1);
        expect(resume).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(resume).toHaveBeenCalledOnce();
        expect(service.isSyncPaused()).toBe(false);
    });

    it('keeps sync paused for a run that keeps writing after a stuck write lapses', async () => {
        const resume = vi.fn();
        const service = await loadSyncPause(() => resume);
        service.pauseSyncForMutatingRun('mutation:1');
        service.pauseSyncForMutatingRun('chat:A:run-1');

        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS / 2);
        service.pauseSyncForMutatingRun('chat:A:run-1');
        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS / 2);
        expect(resume).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS / 2);
        expect(resume).toHaveBeenCalledOnce();
    });

    it('caps a continuously renewed hold and pushes its edits', async () => {
        const resume = vi.fn();
        const service = await loadSyncPause(() => resume);
        const step = service.SAFETY_IDLE_MS / 2;

        for (let elapsed = 0; elapsed < service.MAX_HOLD_MS; elapsed += step) {
            service.pauseSyncForMutatingRun('chat:A:run-1');
            expect(resume).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(step);
        }

        expect(resume).toHaveBeenCalledOnce();
        expect(runner().setSyncTimeout).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh hold when a capped run writes again', async () => {
        const first = vi.fn();
        const second = vi.fn();
        const delayIndefinite = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const service = await loadSyncPause(delayIndefinite);
        const step = service.SAFETY_IDLE_MS / 2;

        for (let elapsed = 0; elapsed < service.MAX_HOLD_MS; elapsed += step) {
            service.pauseSyncForMutatingRun('chat:A:run-1');
            await vi.advanceTimersByTimeAsync(step);
        }
        expect(first).toHaveBeenCalledOnce();

        service.pauseSyncForMutatingRun('chat:A:run-1');
        expect(delayIndefinite).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS);
        expect(second).toHaveBeenCalledOnce();
    });

    it('ignores the late release of a write whose lease already lapsed', async () => {
        const resume = vi.fn();
        const service = await loadSyncPause(() => resume);
        service.pauseSyncForMutatingRun('mutation:1');
        await vi.advanceTimersByTimeAsync(service.SAFETY_IDLE_MS);
        expect(resume).toHaveBeenCalledOnce();

        service.scheduleResumeAfterRun('mutation:1');
        await vi.advanceTimersByTimeAsync(service.RELEASE_DEBOUNCE_MS);
        expect(resume).toHaveBeenCalledOnce();
    });
});
