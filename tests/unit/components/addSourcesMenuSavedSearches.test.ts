// @vitest-environment jsdom

/**
 * Saved searches in the Add Sources menu: a row opens a submenu of the active
 * library's saved searches (trashed ones left out). The composer attaches a
 * picked search to the message and detaches it on a second pick; a target
 * offers the row only when it can take a saved search.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../react/utils/search', () => ({ searchSourceItems: vi.fn(async () => ({ items: [], matchCount: 0 })) }));

const searchable = vi.hoisted(() => ({ ids: [1] }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom(() => searchable.ids) };
});

vi.mock('../../../react/atoms/zoteroContext', async () => {
    const { atom } = await import('jotai');
    return { selectedZoteroItemsAtom: atom([]) };
});

vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        currentMessageFiltersAtom: atom({ libraryIds: [], collectionIds: [], tagSelections: [] }),
        currentMessageItemsAtom: atom([]),
        currentMessageViewsAtom: atom([]),
        addItemToCurrentMessageItemsAtom: atom(null, () => {}),
        removeItemFromMessageAtom: atom(null, () => {}),
    };
});

vi.mock('../../../react/store', async () => {
    const { createStore } = await import('jotai');
    return { store: createStore() };
});

// Stable across renders, as the real hook's callback is: the menu rebuilds its rows when it changes.
const attachExternalFiles = vi.hoisted(() => () => {});
vi.mock('../../../react/hooks/useAttachExternalFiles', () => ({ useAttachExternalFiles: () => attachExternalFiles }));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => window }));
const activeLibrary = vi.hoisted(() => ({ id: 1 }));
vi.mock('../../../react/utils/zoteroTargetContext', () => ({ getActiveZoteroLibraryId: () => activeLibrary.id }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => null, setPref: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemData: vi.fn(async () => {}),
    getRecentAsync: vi.fn(async () => []),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    UNRESOLVED_LIBRARY_ID: 0,
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : null),
}));
vi.mock('../../../react/components/ui/menus/hooks/useLibrariesMenu', () => ({ useLibrariesMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useCollectionsMenu', () => ({ useCollectionsMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useTagsMenu', () => ({ useTagsMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useNotesMenu', () => ({ useNotesMenu: () => ({ menuItems: [] }) }));

import AddSourcesMenu, { type AddSourcesTarget } from '../../../react/components/ui/menus/AddSourcesMenu';
import { currentMessageViewsAtom } from '../../../react/atoms/messageComposition';

const search = (key: string, name: string, deleted = false, libraryID = 1) => ({ libraryID, key, name, deleted });

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
let searches: ReturnType<typeof search>[];
let onCommit: ReturnType<typeof vi.fn>;

const render = async (target?: AddSourcesTarget) => {
    await act(async () => {
        root.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(AddSourcesMenu, {
                    isMenuOpen: true,
                    menuPosition: { x: 0, y: 0 },
                    searchQuery: '',
                    querySource: 'editor',
                    onQueryChange: () => {},
                    onOpen: () => {},
                    onDismiss: () => {},
                    onCommit,
                    onResetQuery: () => {},
                    menuPortalContainer: container,
                    verticalPosition: 'below',
                    target,
                }),
            ),
        );
    });
    await settle();
};

/** Let every pending promise and zero-delay timer settle. */
const settle = async () => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
};

const rows = () => [...container.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
const row = (text: string) => rows().find((element) => element.textContent?.includes(text));
const click = async (element: HTMLElement | undefined) => {
    if (!element) throw new Error(`No row: ${rows().map((r) => r.textContent).join(' | ')}`);
    await act(async () => element.click());
    await settle();
};

/** A table-like target: takes items and scopes, records picked saved searches. */
const tableTarget = (overrides: Partial<AddSourcesTarget> = {}): AddSourcesTarget => ({
    isAttached: () => false,
    addItem: () => {},
    removeItem: () => {},
    filters: { libraryIds: [], collectionIds: [], tagSelections: [] },
    setFilters: () => {},
    attachFiles: () => {},
    entries: { libraries: false, notes: false, files: false, scopeVerb: 'add' },
    ...overrides,
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.clearAllMocks();
    activeLibrary.id = 1;
    searchable.ids = [1];
    onCommit = vi.fn();
    searches = [search('SRCH0001', 'Recent RCTs'), search('SRCH0002', 'Old drafts', true), search('SRCH0003', 'Meta-analyses')];
    const all = () => searches;
    (globalThis as any).Zotero = {
        Collections: { getAllIDs: vi.fn(async () => []), get: vi.fn() },
        Tags: { getAll: vi.fn(async () => []) },
        Searches: {
            getAll: vi.fn(async (libraryID: number) => all().filter((s) => s.libraryID === libraryID)),
            getByLibraryAndKey: (libraryID: number, key: string) =>
                all().find((s) => s.libraryID === libraryID && s.key === key) ?? false,
        },
        Libraries: { get: () => ({ name: 'My Library' }) },
    };
    store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
});

describe('saved searches in the Add Sources menu', () => {
    it('lets the composer attach a saved search to the message, checked, and detach it with a second pick', async () => {
        await render();
        await click(row('Filter by Saved Searches'));
        expect(container.textContent).toContain('Saved Searches in My Library');
        expect(row('Recent RCTs')).toBeTruthy();
        expect(row('Meta-analyses')).toBeTruthy();
        expect(row('Old drafts')).toBeUndefined();

        await click(row('Recent RCTs'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(store.get(currentMessageViewsAtom)).toEqual([
            { type: 'saved_search', library_ref: 'u', zotero_key: 'SRCH0001', name: 'Recent RCTs' },
        ]);

        await render();
        await click(row('Filter by Saved Searches'));
        expect(row('Recent RCTs')!.querySelector('svg')).toBeTruthy();
        expect(row('Meta-analyses')!.querySelector('svg')).toBeNull();
        await click(row('Recent RCTs'));
        expect(store.get(currentMessageViewsAtom)).toEqual([]);
    });

    it('lists the personal library\'s saved searches, not the active excluded library\'s', async () => {
        activeLibrary.id = 7;
        searches = [search('SRCH0001', 'Recent RCTs'), search('SRCH0007', 'Excluded search', false, 7)];
        await render();
        await click(row('Filter by Saved Searches'));
        expect(row('Recent RCTs')).toBeTruthy();
        expect(row('Excluded search')).toBeUndefined();
    });

    it('disables the row when neither the active library nor My Library is searchable', async () => {
        activeLibrary.id = 7;
        searchable.ids = [2];
        searches = [search('SRCH0001', 'Recent RCTs'), search('SRCH0007', 'Excluded search', false, 7)];
        await render();
        expect(row('Filter by Saved Searches')!.className).toContain('cursor-not-allowed');
        await click(row('Filter by Saved Searches'));
        expect(row('Excluded search')).toBeUndefined();
        expect(row('Recent RCTs')).toBeUndefined();
    });

    it('disables the row when the library has no saved searches outside the trash', async () => {
        searches = [search('SRCH0002', 'Old drafts', true)];
        await render();
        expect(row('Filter by Saved Searches')!.className).toContain('cursor-not-allowed');
        await click(row('Filter by Saved Searches'));
        expect(row('Filter by Saved Searches')).toBeTruthy();
    });

    it('offers saved searches to a target only when it can take them', async () => {
        await render(tableTarget());
        expect(row('Add Collection')).toBeTruthy();
        expect(row('Saved Search')).toBeUndefined();

        const pickSavedSearch = vi.fn();
        await render(tableTarget({ pickSavedSearch, isSavedSearchPicked: (s) => s.key === 'SRCH0003' }));
        await click(row('Add Saved Search'));
        expect(row('Meta-analyses')!.querySelector('svg')).toBeTruthy();
        await click(row('Recent RCTs'));
        expect(pickSavedSearch).toHaveBeenCalledWith(expect.objectContaining({ key: 'SRCH0001' }));
        expect(store.get(currentMessageViewsAtom)).toEqual([]);
    });
});
