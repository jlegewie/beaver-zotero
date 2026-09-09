// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: undefined as any, updateUI: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => mocks.context }));
vi.mock('../../../react/ui/UIManager', () => ({ uiManager: { updateUI: mocks.updateUI } }));
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { isLibraryTabAtom: atom(true), selectedZoteroTabIdAtom: atom('') };
});
import { useZoteroTabSelection } from '../../../react/hooks/useZoteroTabSelection';
import { isLibraryTabAtom, selectedZoteroTabIdAtom } from '../../../react/atoms/ui';
let store = createStore();
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let observer: any;

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    store = createStore();
    mocks.context = {
        Zotero_Tabs: { selectedID: 'reader-a', selectedType: 'reader', _tabs: [
            { id: 'zotero-pane', type: 'library' }, { id: 'reader-a', type: 'reader' },
        ] },
        document: { querySelector: () => ({ hasAttribute: () => true }) },
    };
    vi.mocked(Zotero.Notifier.registerObserver).mockImplementation((value: any) => { observer = value; return 'tabs'; });
    container = document.createElement('div');
    root = createRoot(container);
    function Harness() { useZoteroTabSelection(); return null; }
    act(() => root.render(React.createElement(Provider, { store }, React.createElement(Harness))));
});
afterEach(() => { act(() => root.unmount()); });

it('ignores another window selecting the shared library tab while this window stays in its reader', async () => {
    await act(async () => { await observer.notify('select', 'tab', ['zotero-pane'], {}); });
    expect(store.get(isLibraryTabAtom)).toBe(false);
    expect(store.get(selectedZoteroTabIdAtom)).toBe('reader-a');
    expect(mocks.updateUI).not.toHaveBeenCalled();
});

it('updates the sidebar when its own selected tab changes', async () => {
    mocks.context.Zotero_Tabs.selectedID = 'zotero-pane';
    await act(async () => { await observer.notify('select', 'tab', ['zotero-pane'], {}); });
    expect(store.get(isLibraryTabAtom)).toBe(true);
    expect(store.get(selectedZoteroTabIdAtom)).toBe('zotero-pane');
    expect(mocks.updateUI).toHaveBeenCalledWith(expect.objectContaining({ isLibraryTab: true }));
});
