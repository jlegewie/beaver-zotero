/**
 * Live batch panel above the composer: draws what is running, holds a finished
 * batch briefly, and keeps an expanded leftover until the user closes it.
 *
 * Hook stand-in rather than mounted (jsdom is not loaded). Effects run
 * synchronously; re-render is manual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hookState, stampRef } = vi.hoisted(() => ({
    hookState: { slots: [] as any[], index: 0 },
    stampRef: { current: null as any },
}));

vi.mock('react', async () => {
    const actual = await vi.importActual<any>('react');

    const slot = <T,>(initial: () => T): { value: T } => {
        const i = hookState.index++;
        if (hookState.slots.length <= i) hookState.slots[i] = { value: initial() };
        return hookState.slots[i];
    };

    const changed = (next: unknown[] | undefined, prev: unknown[] | undefined) =>
        !prev || !next || next.length !== prev.length || next.some((d, i) => !Object.is(d, prev[i]));

    // Run the effect when deps change, cleaning up first. The dwell timer
    // depends on that: a batch stays in later stamps, so a restarted timer
    // would never fire.
    const effect = (fn: () => void | (() => void), deps?: unknown[]) => {
        const cell = slot(() => ({ deps: undefined as unknown[] | undefined, cleanup: undefined as any }));
        if (!changed(deps, cell.value.deps)) return;
        cell.value.cleanup?.();
        cell.value.deps = deps;
        cell.value.cleanup = fn();
    };

    const hooks = {
        useState: (initial: any) => {
            const cell = slot(() => (typeof initial === 'function' ? initial() : initial));
            return [cell.value, (next: any) => {
                cell.value = typeof next === 'function' ? next(cell.value) : next;
            }];
        },
        useRef: (initial: any) => slot(() => ({ current: initial })).value,
        useMemo: (fn: any) => fn(),
        useCallback: (fn: any) => fn,
        useEffect: effect,
        useLayoutEffect: effect,
    };

    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

vi.mock('jotai', async () => ({
    ...(await vi.importActual<any>('jotai')),
    useAtomValue: () => stampRef.current,
}));

// Keep this test off the WebSocket/Supabase graph; the stamp arrives via useAtomValue.
vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai/vanilla');
    return { batchProgressAtom: atom(null) };
});

import React from 'react';
import type {
    BatchProgressEntry,
    BatchProgressStamp,
} from '@beaver/agent-core/run-state/batchProgress';
import BatchProgressPanel from '../../../react/components/input/BatchProgressPanel';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '109 of 184',
        show_progress: true,
        ...overrides,
    };
}

function stamp(...batches: BatchProgressEntry[]): BatchProgressStamp {
    return { batches };
}

/** Render the panel again with whatever stamp is current, keeping its state. */
function render(next?: BatchProgressStamp | null): React.ReactElement<any> | null {
    if (next !== undefined) stampRef.current = next;
    hookState.index = 0;
    return BatchProgressPanel({}) as React.ReactElement<any> | null;
}

/** The batch the panel is drawing, or null when it is drawing nothing. */
function drawn(next?: BatchProgressStamp | null): BatchProgressEntry | null {
    const element = render(next);
    return element ? (element.props.batch as BatchProgressEntry) : null;
}

beforeEach(() => {
    vi.useFakeTimers();
    hookState.slots = [];
    hookState.index = 0;
    stampRef.current = null;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the live batch panel', () => {
    it('draws nothing when no batch has been stamped', () => {
        expect(drawn(null)).toBeNull();
    });

    it('draws the batch being worked, and the queue behind it', () => {
        const element = render(stamp(
            entry({ batch_id: 'open', is_handover: true }),
            entry({ batch_id: 'next' }),
        ));
        expect(element?.props.batch.batch_id).toBe('open');
        expect(element?.props.queuedBatches.map((b: BatchProgressEntry) => b.batch_id)).toEqual(['next']);
    });

    it('draws nothing for a batch that had already ended when it mounted', () => {
        // Reload mid-run: completion already happened.
        expect(drawn(stamp(entry({ status: 'completed' })))).toBeNull();
    });

    it('holds a batch it drew open for a beat after it ends, then lets it go', () => {
        expect(drawn(stamp(entry()))?.batch_id).toBe('b1');

        // Ended stamp: keep the bar up so the tick and totals are the finished ones.
        render(stamp(entry({ status: 'completed', progress_primary: '184 of 184' })));
        const held = drawn();
        expect(held?.status).toBe('completed');
        expect(held?.progress_primary).toBe('184 of 184');

        vi.advanceTimersByTime(3000);
        expect(drawn()).toBeNull();
    });

    it('gives an ended batch up at once when the stamp does', () => {
        // Run went terminal: receipt has it. Holding here would draw it twice.
        expect(drawn(stamp(entry()))?.batch_id).toBe('b1');
        render(stamp(entry({ status: 'completed' })));
        expect(drawn()?.status).toBe('completed');

        render(null);
        expect(drawn()).toBeNull();
    });

    it('stays expanded when a batch the user is looking at ends', () => {
        render(stamp(entry()))!.props.onExpandedChange(true);
        const ended = render(stamp(entry({ status: 'completed', progress_primary: '184 of 184' })));
        expect(ended?.props.expanded).toBe(true);
        expect(ended?.props.batch.progress_primary).toBe('184 of 184');
    });

    it('keeps an expanded batch after the stamp is gone, until the user closes it', () => {
        render(stamp(entry()))!.props.onExpandedChange(true);
        render(stamp(entry({ status: 'completed' })));
        expect(drawn(null)?.status).toBe('completed');
        expect(render()?.props.expanded).toBe(true);

        render()!.props.onExpandedChange(false);
        expect(drawn()).toBeNull();
    });

    it('drops an expanded batch when the run stops before the batch ends', () => {
        render(stamp(entry()))!.props.onExpandedChange(true);
        expect(drawn()?.progress_primary).toBe('109 of 184');
        expect(drawn(null)).toBeNull();
    });

    it('still dwells after the user collapses a completed batch the run is still carrying', () => {
        render(stamp(entry()))!.props.onExpandedChange(true);
        render(stamp(entry({ status: 'completed' })));
        render()!.props.onExpandedChange(false);
        expect(drawn()?.status).toBe('completed');

        vi.advanceTimersByTime(3000);
        expect(drawn()).toBeNull();
    });

    it('keeps a batch the user opened during the dwell after the stamp is gone', () => {
        expect(drawn(stamp(entry()))?.batch_id).toBe('b1');
        render(stamp(entry({ status: 'completed' })));
        render()!.props.onExpandedChange(true);

        expect(drawn(null)?.status).toBe('completed');
    });

    it('drops what it is holding as soon as the next batch opens', () => {
        expect(drawn(stamp(entry({ batch_id: 'first' })))?.batch_id).toBe('first');
        render(stamp(entry({ batch_id: 'first', status: 'completed' })));
        expect(drawn()?.batch_id).toBe('first');

        render(stamp(entry({ batch_id: 'second', is_handover: true })));
        expect(drawn()?.batch_id).toBe('second');
    });

    it('draws a batch the backend did not flag as worth showing', () => {
        // The model decided this work was a batch; the panel says so.
        expect(drawn(stamp(entry({ batch_id: 'small', show_progress: false })))?.batch_id).toBe(
            'small',
        );
    });
});
