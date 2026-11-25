/**
 * Applies a run session's chat state to a window's store.
 *
 * The session's store is the authority for the atoms in `sessionStateAtoms()`.
 * The window renders from its own copies, which this projection keeps equal
 * to the session's: values are shared by reference, so state that did not
 * change keeps its identity and its memoized render.
 *
 * Only streaming is paced. A change of the active run that keeps its id and
 * status (text, tool calls, progress) is applied on the window's next
 * animation frame, so a response streaming many events a second renders at
 * most once per frame. Every other change (cards, status, errors, the run
 * ending) is applied at once, together with any paced change still pending,
 * so the window never shows an event ahead of the text that preceded it.
 *
 * The window must not write these atoms itself. A write that does not come
 * from the projection is reverted to the session's value and reported.
 */

import type { createStore } from 'jotai';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { citationsAtom, processCitationsAtom } from '@beaver/agent-core/citations/atoms';
import { logger } from '@beaver/agent-core/platform/logger';
import { FrameScheduler } from '../utils/frameScheduler';
import type { SessionStateAtom } from '../../src/services/agentRuns/sessionState';

type Store = ReturnType<typeof createStore>;

export interface RunProjection {
    /** Apply every pending change now, paced ones included. */
    flush(): void;
    /** Stop applying changes and release the subscriptions. */
    detach(): void;
}

/** Whether `next` only streams more of the run the window shows. */
function isStreamingChange(shown: AgentRun | null, next: AgentRun | null): boolean {
    return !!shown && !!next && shown.id === next.id && shown.status === next.status;
}

/**
 * Report a window write of session state. Unit tests make it throw (see
 * `tests/setup.ts`) so a window writer that bypasses the session fails there.
 */
function reportStrayWrite(name: string): void {
    const message = `runProjection: the window wrote session state "${name}" directly; reverted to the session's value`;
    if ((globalThis as any).__beaverStrictRunProjection) throw new Error(message);
    logger(message, 1);
}

export function attachRunProjection(
    session: Store,
    view: Store,
    atoms: ReadonlyArray<readonly [string, SessionStateAtom]>,
    frameWindow: () => Window | null | undefined,
): RunProjection {
    /**
     * The write the projection is making to the window. Only that write is
     * the projection's own: a listener it wakes that writes session state to
     * the window, the same atom included, is still reported.
     */
    let writing: { atom: SessionStateAtom; value: unknown } | null = null;
    let detached = false;

    const copy = (atom: SessionStateAtom): void => {
        const value = session.get(atom);
        writing = { atom, value };
        try {
            view.set(atom, value);
        } finally {
            writing = null;
        }
    };

    const apply = (): void => {
        if (detached) return;
        scheduler.cancel();
        let citationsChanged = false;
        for (const [, atom] of atoms) {
            if (view.get(atom) === session.get(atom)) continue;
            copy(atom);
            if (atom === citationsAtom) citationsChanged = true;
        }
        // Citation markers are the window's render state, numbered in the
        // same update that brings the citations.
        if (citationsChanged) view.set(processCitationsAtom);
    };

    const scheduler = new FrameScheduler(frameWindow, apply);

    const onSessionChange = (atom: SessionStateAtom): void => {
        if (atom === activeRunAtom && isStreamingChange(view.get(activeRunAtom), session.get(activeRunAtom))) {
            scheduler.schedule();
            return;
        }
        apply();
    };

    const onViewChange = (name: string, atom: SessionStateAtom): void => {
        if (detached || view.get(atom) === session.get(atom)) return;
        if (writing?.atom === atom && view.get(atom) === writing.value) return;
        copy(atom);
        reportStrayWrite(name);
    };

    const unsubscribers = atoms.flatMap(([name, atom]) => [
        session.sub(atom, () => onSessionChange(atom)),
        view.sub(atom, () => onViewChange(name, atom)),
    ]);
    apply();

    return {
        flush: apply,
        detach: () => {
            detached = true;
            scheduler.cancel();
            unsubscribers.forEach((unsubscribe) => unsubscribe());
        },
    };
}
