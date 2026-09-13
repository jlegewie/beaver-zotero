// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, atom } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../../react/atoms/ui', () => ({
    userScrolledAtom: atom(false), windowUserScrolledAtom: atom(false),
    isAtBottomAtom: atom(true), windowIsAtBottomAtom: atom(true),
}));
vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: atom(null), pendingScrollToRunAtom: atom(null),
    isLoadingThreadAtom: atom(false), currentThreadScrollPositionAtom: atom(undefined),
    windowScrollPositionAtom: atom(undefined),
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    allRunsAtom: atom([]), activeRunAtom: atom(null),
}));
vi.mock('../../../react/agents/agentActions', () => ({ pendingApprovalsAtom: atom(new Map()) }));
vi.mock('../../../react/atoms/messageUIState', () => ({
    toolExpandedAtom: atom({}), messageSourcesVisibilityAtom: atom({}), annotationPanelStateAtom: atom({}),
}));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => window }));
vi.mock('../../../react/components/agentRuns/AgentRunView', () => ({
    // Model the DOM replacement caused by the streaming-only context provider.
    AgentRunView: ({ run }: any) => React.createElement(run.status === 'in_progress' ? 'section' : 'article', { id: `run-${run.id}` }),
}));

import { ThreadView } from '../../../react/components/agentRuns/ThreadView';
import { allRunsAtom, activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../../react/store';
import { getScrollAtoms } from '../../../react/utils/scrollPosition';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const observers: ResizeObserverStub[] = [];
class ResizeObserverStub {
    targets = new Set<Element>();
    constructor(public callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
}
let root: Root;
let host: HTMLDivElement;
let container: HTMLDivElement;
let height: number;
const scrollAtoms = getScrollAtoms(false);
const run = (status: string, id = 'one') => ({ id, status }) as any;
function resizeContent() {
    // Deliver only to observers whose targets are still in the rendered tree.
    for (const observer of observers) {
        if ([...observer.targets].some(target => target !== container && container.contains(target))) {
            act(() => observer.callback());
        }
    }
}
beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    store.set(allRunsAtom, [run('in_progress')]);
    store.set(activeRunAtom, run('in_progress'));
    store.set(scrollAtoms.userScrolled, false);
    store.set(scrollAtoms.isAtBottom, true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Provider, { store }, React.createElement(ThreadView))));
    container = host.firstElementChild as HTMLDivElement;
    height = 1000;
    Object.defineProperty(container, 'clientHeight', { value: 500 });
    Object.defineProperty(container, 'scrollHeight', { get: () => height });
    container.scrollTop = 500;
    resizeContent();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    observers.length = 0;
    vi.unstubAllGlobals();
});
it('follows terminal reviews and a follow-up after a run replaces its DOM root', () => {
    const oldRoot = container.querySelector('#run-one');
    act(() => {
        store.set(allRunsAtom, [run('completed')]);
        store.set(activeRunAtom, null);
    });
    expect(oldRoot?.isConnected).toBe(false);
    height = 1400;
    resizeContent();
    expect(container.scrollTop).toBe(900);

    act(() => {
        store.set(allRunsAtom, [run('completed'), run('in_progress', 'two')]);
        store.set(activeRunAtom, run('in_progress', 'two'));
    });
    height = 1800;
    resizeContent();
    expect(container.scrollTop).toBe(1300);
});
it('updates the bottom measurement after a root replacement while the reader stays scrolled back', () => {
    act(() => store.set(allRunsAtom, [run('completed')]));
    store.set(scrollAtoms.userScrolled, true);
    height = 1600;
    resizeContent();
    expect(container.scrollTop).toBe(500);
    expect(store.get(scrollAtoms.isAtBottom)).toBe(false);
    expect(store.get(scrollAtoms.userScrolled)).toBe(true);
});
