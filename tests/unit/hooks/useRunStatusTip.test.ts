// @vitest-environment jsdom

/**
 * The trigger for the run-status tip: a live run with the sidebar open.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prefs: {} as Record<string, unknown>, show: vi.fn(() => true) }));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => mocks.prefs[key],
    setPref: (key: string, value: unknown) => { mocks.prefs[key] = value; },
}));
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { isSidebarVisibleAtom: atom(false) };
});
vi.mock('../../../react/atoms/featureTips', async () => {
    const { atom } = await import('jotai');
    return { showFeatureTipAtom: atom(null, (_get, _set, tipId: string) => mocks.show(tipId)) };
});

import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isSidebarVisibleAtom } from '../../../react/atoms/ui';
import { useRunStatusTip } from '../../../react/hooks/useRunStatusTip';

const LIVE_RUN = { id: 'run-1', status: 'in_progress' } as any;
let store = createStore();
const roots: { root: Root; container: HTMLDivElement }[] = [];

function mount() {
    const Harness: React.FC = () => { useRunStatusTip(); return null; };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => { root.render(React.createElement(Provider, { store }, React.createElement(Harness))); });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    store = createStore();
    mocks.prefs = {};
    mocks.show.mockReturnValue(true);
});

afterEach(() => {
    act(() => { roots.forEach(({ root }) => root.unmount()); });
    roots.forEach(({ container }) => container.remove());
    roots.length = 0;
    vi.useRealTimers();
});

describe('useRunStatusTip', () => {
    it('asks for the tip once a run is live with the sidebar open', () => {
        store.set(isSidebarVisibleAtom as any, true);
        store.set(activeRunAtom, LIVE_RUN);
        mount();
        expect(mocks.show).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(2000); });
        expect(mocks.show).toHaveBeenCalledExactlyOnceWith('run-status-popup');
    });

    it('asks again next time if the moment was declined', () => {
        mocks.show.mockReturnValue(false);
        store.set(isSidebarVisibleAtom as any, true);
        store.set(activeRunAtom, LIVE_RUN);
        mount();
        act(() => { vi.advanceTimersByTime(2000); });
        act(() => { store.set(activeRunAtom, null); });
        act(() => { store.set(activeRunAtom, { ...LIVE_RUN, id: 'run-2' }); });
        act(() => { vi.advanceTimersByTime(2000); });
        expect(mocks.show).toHaveBeenCalledTimes(2);
    });

    it('needs no tip with the sidebar closed', () => {
        store.set(activeRunAtom, LIVE_RUN);
        mount();
        act(() => { vi.advanceTimersByTime(2000); });
        expect(mocks.show).not.toHaveBeenCalled();
    });

    it('needs no tip when the popup is turned off', () => {
        mocks.prefs.enableRunStatusPopup = false;
        store.set(isSidebarVisibleAtom as any, true);
        store.set(activeRunAtom, LIVE_RUN);
        mount();
        act(() => { vi.advanceTimersByTime(2000); });
        expect(mocks.show).not.toHaveBeenCalled();
    });
});
