// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ win: undefined as any }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => mocks.win }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { isLibraryAccessReadyAtom: atom(false), searchableLibraryIdsAtom: atom([1]) };
});
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { isLibraryTabAtom: atom(false) };
});
vi.mock('../../../react/atoms/zoteroContext', async () => {
    const { atom } = await import('jotai');
    return {
        currentNoteItemAtom: atom(null), selectedZoteroItemsAtom: atom([]),
        selectedZoteroItemCountAtom: atom(0), libraryViewAtom: atom(null),
        selectedTagsAtom: atom([]), recentlyAddedTodayCountAtom: atom(0),
        libraryItemCountAtom: atom(0), SMALL_LIBRARY_THRESHOLD: 10,
    };
});
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    const { currentNoteItemAtom } = await import('../../../react/atoms/zoteroContext');
    return { updateNoteItemAtom: atom(null, (_get, set, item) => set(currentNoteItemAtom, item)) };
});
import { useZoteroContext } from '../../../react/hooks/useZoteroContext';
import { currentNoteItemAtom } from '../../../react/atoms/zoteroContext';
import { isLibraryTabAtom } from '../../../react/atoms/ui';
let store: ReturnType<typeof createStore>;
let root: ReturnType<typeof createRoot>;
let observer: any;
let resolveOld: (value: any) => void;
let oldNote: any;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    oldNote = { id: 1, loadDataType: vi.fn(async () => {}) };
    const oldRead = new Promise(resolve => { resolveOld = resolve; });
    mocks.win = { closed: false, ZoteroPane: {}, Zotero_Tabs: {
        selectedID: 'old', _tabs: [{ id: 'old', type: 'note', data: { itemID: 1 } }],
    } };
    (Zotero as any).Items = { getAsync: vi.fn(() => oldRead) };
    (Zotero as any).DB = { queryAsync: vi.fn(async () => []) };
    vi.mocked(Zotero.Notifier.registerObserver).mockImplementation((value: any, types: any) => {
        if (types.includes('tab')) observer = value;
        return types[0];
    });
    store = createStore(); store.set(isLibraryTabAtom, false);
    root = createRoot(document.createElement('div'));
    function Harness() { useZoteroContext(); return null; }
    act(() => root.render(React.createElement(Provider, { store }, React.createElement(Harness))));
});
afterEach(() => act(() => root?.unmount()));

it('drops a note read that finishes after the local tab changes, even for an untagged foreign batch', async () => {
    mocks.win.Zotero_Tabs.selectedID = 'zotero-pane';
    mocks.win.Zotero_Tabs._tabs.push({ id: 'zotero-pane', type: 'library' });
    await act(async () => { await observer.notify('select', 'tab', ['foreign', 'zotero-pane'], {}); });
    await act(async () => { resolveOld(oldNote); });
    expect(store.get(currentNoteItemAtom)).toBeNull();
});

it('drops a note read that finishes after its host closes', async () => {
    mocks.win.closed = true;
    await act(async () => { resolveOld(oldNote); });
    expect(store.get(currentNoteItemAtom)).toBeNull();
});
