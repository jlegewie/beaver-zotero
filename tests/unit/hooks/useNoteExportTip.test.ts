// @vitest-environment jsdom

/**
 * The trigger for the export tip: a note Beaver just created, once the run is over.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ show: vi.fn(() => true) }));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { isSidebarVisibleAtom: atom(false), isBeaverWindowOpenAtom: atom(false) };
});
vi.mock('../../../react/atoms/featureTips', async () => {
    const { atom } = await import('jotai');
    return { showFeatureTipAtom: atom(null, (_get, _set, tipId: string) => mocks.show(tipId)) };
});
vi.mock('../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return { threadAgentActionsAtom: atom([]) };
});

import { activeRunAtom, currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { isBeaverWindowOpenAtom, isSidebarVisibleAtom } from '../../../react/atoms/ui';
import { windowSurfaceAtom } from '../../../react/atoms/windowSurface';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { useNoteExportTip } from '../../../react/hooks/useNoteExportTip';

const LIVE_RUN = { id: 'run-1', status: 'in_progress' } as any;
const note = (overrides: Record<string, unknown> = {}) => ({
    id: 'action-1',
    run_id: 'run-1',
    action_type: 'create_note',
    status: 'applied',
    proposed_data: {},
    ...overrides,
}) as any;

let store = createStore();
const roots: { root: Root; container: HTMLDivElement }[] = [];

function mount() {
    const Harness: React.FC = () => { useNoteExportTip(); return null; };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => { root.render(React.createElement(Provider, { store }, React.createElement(Harness))); });
}

const set = (atom: any, value: unknown) => act(() => { store.set(atom, value); });
const wait = () => act(() => { vi.advanceTimersByTime(2000); });

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    store = createStore();
    store.set(isSidebarVisibleAtom as any, true);
    store.set(currentThreadIdAtom, 'thread-1');
    mocks.show.mockReturnValue(true);
});

afterEach(() => {
    act(() => { roots.forEach(({ root }) => root.unmount()); });
    roots.forEach(({ container }) => container.remove());
    roots.length = 0;
    vi.useRealTimers();
});

describe('useNoteExportTip', () => {
    it('asks for the tip once a run that created a note is over', () => {
        mount();
        set(activeRunAtom, LIVE_RUN);
        set(threadAgentActionsAtom, [note()]);
        wait();
        expect(mocks.show).not.toHaveBeenCalled();

        set(activeRunAtom, null);
        wait();
        expect(mocks.show).toHaveBeenCalledExactlyOnceWith('note-export');
    });

    it('asks when the user applies a note here', () => {
        store.set(threadAgentActionsAtom as any, [note({ status: 'pending' })]);
        mount();
        set(threadAgentActionsAtom, [note()]);
        wait();
        expect(mocks.show).toHaveBeenCalledExactlyOnceWith('note-export');
    });

    it('does not ask for notes that come with a thread\'s history', () => {
        mount();
        set(threadAgentActionsAtom, [note({ run_id: 'old-run' })]);
        wait();
        expect(mocks.show).not.toHaveBeenCalled();
    });

    it('waits for the sidebar, and lets the moment pass when the chat changes', () => {
        store.set(isSidebarVisibleAtom as any, false);
        mount();
        set(activeRunAtom, LIVE_RUN);
        set(threadAgentActionsAtom, [note()]);
        set(activeRunAtom, null);
        wait();
        expect(mocks.show).not.toHaveBeenCalled();

        set(isSidebarVisibleAtom, true);
        wait();
        expect(mocks.show).toHaveBeenCalledTimes(1);

        mocks.show.mockClear();
        set(activeRunAtom, { ...LIVE_RUN, id: 'run-2' });
        set(threadAgentActionsAtom, [note(), note({ id: 'action-2', run_id: 'run-2' })]);
        set(activeRunAtom, null);
        set(currentThreadIdAtom, 'thread-2');
        wait();
        expect(mocks.show).not.toHaveBeenCalled();
    });

    it('asks in the separate window while it shows the chat, not a table', () => {
        store.set(isSidebarVisibleAtom as any, false);
        store.set(isBeaverWindowOpenAtom as any, true);
        store.set(windowSurfaceAtom, { kind: 'table', id: 'table-1' } as any);
        mount();
        set(activeRunAtom, LIVE_RUN);
        set(threadAgentActionsAtom, [note()]);
        set(activeRunAtom, null);
        wait();
        expect(mocks.show).not.toHaveBeenCalled();

        set(windowSurfaceAtom, { kind: 'thread' });
        wait();
        expect(mocks.show).toHaveBeenCalledExactlyOnceWith('note-export');
    });

    it('asks when a note from history is undone and applied again', () => {
        store.set(threadAgentActionsAtom as any, [note({ run_id: 'old-run' })]);
        mount();
        set(threadAgentActionsAtom, [note({ run_id: 'old-run', status: 'undone' })]);
        set(threadAgentActionsAtom, [note({ run_id: 'old-run' })]);
        wait();
        expect(mocks.show).toHaveBeenCalledExactlyOnceWith('note-export');
    });

    it('does not re-render as a run streams', () => {
        let renders = 0;
        const Owner: React.FC = () => {
            renders++;
            useNoteExportTip();
            return null;
        };
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        roots.push({ root, container });
        act(() => { root.render(React.createElement(Provider, { store }, React.createElement(Owner))); });
        set(activeRunAtom, LIVE_RUN);
        const before = renders;
        for (let i = 0; i < 10; i++) set(activeRunAtom, { ...LIVE_RUN, model_messages: [i] });
        expect(renders).toBe(before);
    });

    it('stops asking once the tip was shown', () => {
        mount();
        set(activeRunAtom, LIVE_RUN);
        set(threadAgentActionsAtom, [note()]);
        set(activeRunAtom, null);
        wait();
        set(activeRunAtom, { ...LIVE_RUN, id: 'run-2' });
        set(threadAgentActionsAtom, [note(), note({ id: 'action-2', run_id: 'run-2' })]);
        set(activeRunAtom, null);
        wait();
        expect(mocks.show).toHaveBeenCalledTimes(1);
    });
});
