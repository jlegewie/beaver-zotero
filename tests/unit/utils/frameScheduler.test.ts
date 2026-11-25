import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { FrameScheduler } from '../../../react/utils/frameScheduler';

/** A window whose animation frames only run when this test says so. */
function fakeWindow() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;

    return {
        closed: false,
        requestAnimationFrame(callback: FrameRequestCallback): number {
            const handle = nextHandle++;
            frames.set(handle, callback);
            return handle;
        },
        cancelAnimationFrame(handle: number): void {
            frames.delete(handle);
        },
        /** Run every frame callback that is currently armed. */
        runFrame(): void {
            const armed = [...frames.entries()];
            frames.clear();
            for (const [, callback] of armed) callback(0);
        },
        pendingFrames(): number {
            return frames.size;
        },
    };
}

/** Stand-in for the system timer module the scheduler backstops with. */
function fakeSystemTimers() {
    const timers = new Map<number, () => void>();
    let nextId = 1;

    const chromeUtils = {
        importESModule: (url: string) => {
            if (url !== 'resource://gre/modules/Timer.sys.mjs') throw new Error(`unexpected module ${url}`);
            return {
                setTimeout: (callback: () => void) => {
                    const id = nextId++;
                    timers.set(id, callback);
                    return id;
                },
                clearTimeout: (id: number) => {
                    timers.delete(id);
                },
            };
        },
    };

    return {
        install(): void {
            (globalThis as any).ChromeUtils = chromeUtils;
        },
        /** Fire every timer currently armed. */
        run(): void {
            const armed = [...timers.values()];
            timers.clear();
            for (const callback of armed) callback();
        },
        pending(): number {
            return timers.size;
        },
    };
}

describe('FrameScheduler', () => {
    let win: ReturnType<typeof fakeWindow> | { closed: boolean } | undefined;
    let callback: ReturnType<typeof vi.fn>;
    let scheduler: FrameScheduler;

    beforeEach(() => {
        win = fakeWindow();
        callback = vi.fn();
        scheduler = new FrameScheduler(() => win as unknown as Window, callback);
    });

    afterEach(() => {
        scheduler.cancel();
        delete (globalThis as any).ChromeUtils;
    });

    const frames = () => win as ReturnType<typeof fakeWindow>;

    it('runs the callback on the next frame, not before', () => {
        scheduler.schedule();
        expect(callback).not.toHaveBeenCalled();

        frames().runFrame();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs a burst of requests once', () => {
        scheduler.schedule();
        scheduler.schedule();
        scheduler.schedule();
        expect(frames().pendingFrames()).toBe(1);

        frames().runFrame();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('leaves nothing armed after a cancel', () => {
        scheduler.schedule();
        scheduler.cancel();

        expect(frames().pendingFrames()).toBe(0);
        expect(scheduler.isScheduled()).toBe(false);
    });

    it('arms a new frame after the last one ran', () => {
        scheduler.schedule();
        frames().runFrame();
        scheduler.schedule();

        expect(frames().pendingFrames()).toBe(1);
        frames().runFrame();
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it('runs at once when there is no window to schedule against', () => {
        win = undefined;
        scheduler.schedule();

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs at once in a window with no animation frames', () => {
        win = { closed: false };
        scheduler.schedule();

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('stops waiting on a frame whose window has closed', () => {
        scheduler.schedule();
        frames().closed = true;

        // The armed frame belongs to the closed window and will never run.
        scheduler.schedule();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does not let a failing callback escape', () => {
        callback.mockImplementation(() => { throw new Error('bad state'); });
        win = undefined;

        expect(() => scheduler.schedule()).not.toThrow();
    });

    describe('when the window stops painting', () => {
        let timers: ReturnType<typeof fakeSystemTimers>;

        beforeEach(() => {
            timers = fakeSystemTimers();
            timers.install();
        });

        it('runs on the backstop timer', () => {
            scheduler.schedule();
            expect(callback).not.toHaveBeenCalled();

            timers.run();
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('does not run twice when the frame follows the backstop', () => {
            scheduler.schedule();
            timers.run();
            frames().runFrame();

            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('drops the backstop once a frame has run', () => {
            scheduler.schedule();
            frames().runFrame();

            expect(timers.pending()).toBe(0);
        });

        it('runs with no window at all', () => {
            win = undefined;
            scheduler.schedule();
            expect(callback).not.toHaveBeenCalled();

            timers.run();
            expect(callback).toHaveBeenCalledTimes(1);
        });
    });
});
