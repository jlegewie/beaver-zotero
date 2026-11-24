// @vitest-environment jsdom

/**
 * Switching between the library and reader sidebars mounts a new thread view
 * in a pane of another width. It must put the reader back at what they were
 * reading, not at the pixel offset they had in the other pane.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, atom } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../../react/atoms/ui', () => ({
    userScrolledAtom: atom(false), isAtBottomAtom: atom(true),
}));
vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: atom(null), pendingScrollToRunAtom: atom(null),
    isLoadingThreadAtom: atom(false), currentThreadScrollPositionAtom: atom<unknown>(undefined),
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    allRunsAtom: atom([]), activeRunAtom: atom(null),
}));
vi.mock('../../../react/agents/agentActions', () => ({ pendingApprovalsAtom: atom(new Map()) }));
vi.mock('../../../react/atoms/messageUIState', () => ({
    toolExpansionRevisionAtom: atom(0), messageSourcesVisibilityAtom: atom({}), annotationPanelStateAtom: atom({}),
}));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => window }));
vi.mock('../../../react/components/agentRuns/AgentRunView', () => ({
    AgentRunView: ({ run }: any) => React.createElement('div', { id: `run-${run.id}` }),
}));

import { ThreadView } from '../../../react/components/agentRuns/ThreadView';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../../react/store';
import { scrollAtoms } from '../../../react/utils/scrollPosition';
import type { ScrollAnchor } from '../../../react/utils/scrollAnchor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
    observe() {}
    disconnect() {}
}

/** Content-relative boxes of the runs in the pane the thread is mounted into. */
const runBoxes: Record<string, { top: number; height: number }> = {
    'run-one': { top: 0, height: 600 },
    'run-two': { top: 616, height: 800 },
    'run-three': { top: 1432, height: 568 },
};

let root: Root;
let host: HTMLDivElement;

const isContainer = (el: Element) => el.id === 'beaver-thread-view';

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    // jsdom lays nothing out. The container is a 500px viewport over 2000px of
    // content; each run's box moves up as the container scrolls.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return isContainer(this) ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return isContainer(this) ? 2000 : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const container = document.getElementById('beaver-thread-view');
        const box = runBoxes[this.id];
        const top = box ? box.top - (container?.scrollTop ?? 0) : 0;
        const height = box ? box.height : isContainer(this) ? 500 : 0;
        return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    store.set(allRunsAtom, [{ id: 'one', status: 'completed' }, { id: 'two', status: 'completed' }, { id: 'three', status: 'completed' }] as any);
    store.set(scrollAtoms.userScrolled, true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set(scrollAtoms.position, null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('restores the remembered place by what was being read when the pane is another width', () => {
    // Taken in a narrower pane: halfway through run two, at an offset that in
    // this pane would land near the top of run one.
    const anchor: ScrollAnchor = { levels: [{ id: 'run-two', fraction: 0.5 }], scrollTop: 150 };
    store.set(scrollAtoms.position, anchor);

    act(() => root.render(React.createElement(Provider, { store }, React.createElement(ThreadView))));

    const container = document.getElementById('beaver-thread-view')!;
    // Run two starts at 616 here, and is 800 tall.
    expect(container.scrollTop).toBe(1016);
});

it('restores a remembered place that resolves only a short way down the thread', () => {
    // In a wider pane a place can resolve to a few dozen pixels; the newly
    // mounted container starts at the top and must still be moved there.
    const anchor: ScrollAnchor = { levels: [{ id: 'run-one', fraction: 0.1 }], scrollTop: 300 };
    store.set(scrollAtoms.position, anchor);

    act(() => root.render(React.createElement(Provider, { store }, React.createElement(ThreadView))));

    const container = document.getElementById('beaver-thread-view')!;
    expect(container.scrollTop).toBe(60);
});

it('opens at the bottom when no place is remembered', () => {
    store.set(scrollAtoms.position, null);
    store.set(scrollAtoms.userScrolled, false);

    act(() => root.render(React.createElement(Provider, { store }, React.createElement(ThreadView))));

    const container = document.getElementById('beaver-thread-view')!;
    expect(container.scrollTop).toBe(2000);
});
