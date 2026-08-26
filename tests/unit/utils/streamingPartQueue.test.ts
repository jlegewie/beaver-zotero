import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock is hoisted above the module body, so the store is created inside the
// factory and read back through the mocked module.
vi.mock('../../../react/store', async () => {
    const { createStore } = await import('jotai');
    return { store: createStore() };
});

import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { WSPartEvent } from '@beaver/agent-core/protocol/agentProtocol';
import { flushPendingPartEvents, queuePartEvent } from '../../../react/utils/streamingPartQueue';
import { store as testStore } from '../../../react/store';

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

function streamingRun(): AgentRun {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'in_progress',
        model_messages: [],
        user_prompt: { content: 'question', is_resume: false },
    } as unknown as AgentRun;
}

function textPart(content: string): WSPartEvent {
    return {
        event: 'part',
        run_id: 'run-1',
        message_index: 0,
        part_index: 0,
        part: { part_kind: 'text', content },
    } as unknown as WSPartEvent;
}

function streamedText(): string | undefined {
    const run = testStore.get(activeRunAtom);
    const message = run?.model_messages[0];
    if (!message || message.kind !== 'response') return undefined;
    const part = message.parts[0];
    return part?.part_kind === 'text' ? part.content : undefined;
}

/**
 * Stand-in for the system timer module the queue backstops with. Absent unless
 * a test installs it, which is why the frame tests above see frames only.
 */
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
        uninstall(): void {
            delete (globalThis as any).ChromeUtils;
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

describe('streamingPartQueue', () => {
    let win: ReturnType<typeof fakeWindow>;

    beforeEach(() => {
        win = fakeWindow();
        (globalThis as any).Zotero = { getMainWindow: () => win };
        testStore.set(activeRunAtom, streamingRun());
    });

    afterEach(() => {
        // Never leave a queued event behind for the next test.
        flushPendingPartEvents();
        delete (globalThis as any).Zotero;
        delete (globalThis as any).ChromeUtils;
    });

    it('does not apply a queued event before the frame runs', () => {
        queuePartEvent(textPart('Hello'));

        expect(streamedText()).toBeUndefined();
    });

    it('applies the queued event on the next frame', () => {
        queuePartEvent(textPart('Hello'));
        win.runFrame();

        expect(streamedText()).toBe('Hello');
    });

    it('collapses a burst of events into one store write', () => {
        let writes = 0;
        const unsubscribe = testStore.sub(activeRunAtom, () => {
            writes++;
        });

        queuePartEvent(textPart('Hel'));
        queuePartEvent(textPart('Hello'));
        queuePartEvent(textPart('Hello there'));
        expect(win.pendingFrames()).toBe(1);

        win.runFrame();
        unsubscribe();

        // Parts carry the whole accumulated text, so the last event queued is
        // the state the reader should end up seeing.
        expect(streamedText()).toBe('Hello there');
        expect(writes).toBe(1);
    });

    it('applies queued events immediately on flush', () => {
        queuePartEvent(textPart('Hello'));
        flushPendingPartEvents();

        expect(streamedText()).toBe('Hello');
    });

    it('leaves no frame armed after a flush', () => {
        queuePartEvent(textPart('Hello'));
        flushPendingPartEvents();
        expect(win.pendingFrames()).toBe(0);

        // A frame that somehow still fires must not re-apply anything.
        win.runFrame();
        expect(streamedText()).toBe('Hello');
    });

    it('writes nothing when there is nothing queued', () => {
        let writes = 0;
        const unsubscribe = testStore.sub(activeRunAtom, () => {
            writes++;
        });

        flushPendingPartEvents();
        unsubscribe();

        expect(writes).toBe(0);
    });

    it('arms a new frame for events queued after a flush', () => {
        queuePartEvent(textPart('Hello'));
        flushPendingPartEvents();

        queuePartEvent(textPart('Hello there'));
        expect(win.pendingFrames()).toBe(1);
        win.runFrame();

        expect(streamedText()).toBe('Hello there');
    });

    it('drops parts when no run is active', () => {
        testStore.set(activeRunAtom, null);

        queuePartEvent(textPart('Hello'));
        win.runFrame();

        expect(testStore.get(activeRunAtom)).toBeNull();
    });

    it('applies synchronously when there is no window to schedule against', () => {
        (globalThis as any).Zotero = { getMainWindow: () => null };

        queuePartEvent(textPart('Hello'));

        expect(streamedText()).toBe('Hello');
    });

    it('re-arms on the live window when the one holding the frame has closed', () => {
        queuePartEvent(textPart('Hello'));
        expect(streamedText()).toBeUndefined();

        // The frame callback belongs to the closed window and will never run,
        // so the queue must not keep waiting on it.
        win.closed = true;
        const replacement = fakeWindow();
        (globalThis as any).Zotero = { getMainWindow: () => replacement };

        queuePartEvent(textPart('Hello there'));
        expect(replacement.pendingFrames()).toBe(1);
        replacement.runFrame();

        expect(streamedText()).toBe('Hello there');
    });

    describe('when the main window stops painting', () => {
        let timers: ReturnType<typeof fakeSystemTimers>;

        beforeEach(() => {
            timers = fakeSystemTimers();
            timers.install();
        });

        it('applies queued events on the backstop timer', () => {
            queuePartEvent(textPart('Hello'));

            // The window is open but delivering no frames, as a minimized or
            // occluded one does while the reader watches the Beaver window.
            expect(streamedText()).toBeUndefined();
            timers.run();

            expect(streamedText()).toBe('Hello');
        });

        it('does not apply the same events twice when the frame follows the backstop', () => {
            queuePartEvent(textPart('Hello'));
            timers.run();

            let writes = 0;
            const unsubscribe = testStore.sub(activeRunAtom, () => {
                writes++;
            });
            win.runFrame();
            unsubscribe();

            expect(writes).toBe(0);
            expect(streamedText()).toBe('Hello');
        });

        it('drops the backstop once a frame has flushed the queue', () => {
            queuePartEvent(textPart('Hello'));
            win.runFrame();

            expect(streamedText()).toBe('Hello');
            expect(timers.pending()).toBe(0);
        });

        it('drops the backstop on an explicit flush', () => {
            queuePartEvent(textPart('Hello'));
            flushPendingPartEvents();

            expect(timers.pending()).toBe(0);
            expect(streamedText()).toBe('Hello');
        });

        it('drains the queue even with no window at all', () => {
            (globalThis as any).Zotero = { getMainWindow: () => null };

            queuePartEvent(textPart('Hello'));
            timers.run();

            expect(streamedText()).toBe('Hello');
        });
    });

    it('does not throw out of a flush when an event cannot be applied', () => {
        // Malformed wire data: the reducer throws on it. The flush is the first
        // step of stopping a run, so it must not abort what follows.
        queuePartEvent({
            event: 'part',
            run_id: 'run-1',
            message_index: 0,
            part_index: 0,
        } as unknown as WSPartEvent);

        expect(() => flushPendingPartEvents()).not.toThrow();
    });

    it('applies synchronously in a window with no animation frames', () => {
        (globalThis as any).Zotero = { getMainWindow: () => ({ closed: false }) };

        queuePartEvent(textPart('Hello'));

        expect(streamedText()).toBe('Hello');
    });

    it('applies synchronously when the only window left is closed', () => {
        queuePartEvent(textPart('Hello'));
        expect(streamedText()).toBeUndefined();

        win.closed = true;
        queuePartEvent(textPart('Hello there'));

        expect(streamedText()).toBe('Hello there');
    });
});
