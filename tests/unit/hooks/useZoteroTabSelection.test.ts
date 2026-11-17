// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: undefined as any, updateUI: vi.fn(), syncLibrarySidebar: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => mocks.context }));
vi.mock('../../../react/ui/UIManager', () => ({ uiManager: { updateUI: mocks.updateUI } }));
vi.mock('../../../react/ui/librarySidebar', () => ({ syncLibrarySidebar: mocks.syncLibrarySidebar }));
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

it('shows the library sidebar for a Zotero 11 library tab whose view is still loading', async () => {
    mocks.context.Zotero_Tabs.selectedID = 'zotero-pane';
    mocks.context.Zotero_Tabs._tabs[0].type = 'library-loading';
    await act(async () => { await observer.notify('select', 'tab', ['zotero-pane'], {}); });
    expect(store.get(isLibraryTabAtom)).toBe(true);
    expect(mocks.syncLibrarySidebar).toHaveBeenCalled();
    expect(mocks.updateUI).toHaveBeenCalledWith(expect.objectContaining({ isLibraryTab: true }));
    expect(mocks.syncLibrarySidebar.mock.invocationCallOrder.at(-1))
        .toBeLessThan(mocks.updateUI.mock.invocationCallOrder[0]);
});

it('moves the library sidebar when another library tab of the window is selected', async () => {
    mocks.context.Zotero_Tabs._tabs.push({ id: 'library-b', type: 'library-loading' });
    mocks.context.Zotero_Tabs.selectedID = 'zotero-pane';
    await act(async () => { await observer.notify('select', 'tab', ['zotero-pane'], {}); });
    mocks.syncLibrarySidebar.mockClear();
    mocks.context.Zotero_Tabs.selectedID = 'library-b';
    await act(async () => { await observer.notify('select', 'tab', ['library-b'], {}); });
    expect(mocks.syncLibrarySidebar).toHaveBeenCalledTimes(1);
    expect(store.get(selectedZoteroTabIdAtom)).toBe('library-b');
});

it('reapplies the visible sidebar when the selected library view finishes loading', async () => {
    mocks.context.Zotero_Tabs.selectedID = 'zotero-pane';
    await act(async () => { await observer.notify('select', 'tab', ['zotero-pane'], {}); });
    mocks.syncLibrarySidebar.mockClear();
    mocks.updateUI.mockClear();
    await act(async () => { await observer.notify('load', 'tab', ['zotero-pane'], {}); });
    expect(mocks.syncLibrarySidebar).toHaveBeenCalledTimes(1);
    expect(mocks.updateUI).toHaveBeenCalledWith(expect.objectContaining({ isVisible: true, isLibraryTab: true }));
});

it('ignores a reader tab finishing its load', async () => {
    mocks.updateUI.mockClear();
    await act(async () => { await observer.notify('load', 'tab', ['reader-a'], {}); });
    expect(mocks.updateUI).not.toHaveBeenCalled();
});
