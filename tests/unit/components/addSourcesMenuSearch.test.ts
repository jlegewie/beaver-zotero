// @vitest-environment jsdom

/**
 * The Add Sources menu's item search: it waits for typing to pause, searches
 * every searchable library whatever filters the message carries, never claims
 * "no results" for rows it is still preparing, says when it
 * is still searching, and says when more items matched than it lists.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import { createMockItem } from '../../helpers/factories';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    searchSourceItems: vi.fn(),
    attachExternalFiles: () => {},
    createSourceMenuItem: vi.fn(),
}));

const buildRow = async (item: any) => ({ label: `row:${item.getField('title')}`, onClick: () => {} });

vi.mock('../../../react/utils/search', () => ({ searchSourceItems: mocks.searchSourceItems }));

vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom([1, 5]) };
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

vi.mock('../../../react/hooks/useAttachExternalFiles', () => ({ useAttachExternalFiles: () => mocks.attachExternalFiles }));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => window }));
vi.mock('../../../react/utils/zoteroTargetContext', () => ({ getActiveZoteroLibraryId: () => 1 }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => null, setPref: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemData: vi.fn(async () => {}),
    getRecentAsync: vi.fn(async () => []),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    UNRESOLVED_LIBRARY_ID: 0,
    libraryRefForLibraryID: () => null,
}));
vi.mock('../../../react/components/ui/menus/utils/menuItemFactories', () => ({
    createSourceMenuItem: (item: any) => mocks.createSourceMenuItem(item),
}));
vi.mock('../../../react/components/ui/menus/hooks/useLibrariesMenu', () => ({ useLibrariesMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useCollectionsMenu', () => ({ useCollectionsMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useTagsMenu', () => ({ useTagsMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useNotesMenu', () => ({ useNotesMenu: () => ({ menuItems: [] }) }));
vi.mock('../../../react/components/ui/menus/hooks/useSavedSearchesMenu', () => ({
    useSavedSearchesMenu: () => ({ menuItems: [] }),
    availableSavedSearches: async () => [],
}));

import AddSourcesMenu from '../../../react/components/ui/menus/AddSourcesMenu';
import { currentMessageFiltersAtom } from '../../../react/atoms/messageComposition';

const DEBOUNCE_MS = 150;

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

let nextId = 1;
const paper = (title: string) => createMockItem({ id: nextId++, key: `ITEM${nextId}`, fields: { title } });

/** The search answering with `items` as its best matches, out of `matchCount`. */
const answer = (items: any[], matchCount = items.length) =>
    mocks.searchSourceItems.mockResolvedValue({ items, matchCount });

const render = async (searchQuery: string, verticalPosition: 'above' | 'below' = 'below', isMenuOpen = true) => {
    await act(async () => {
        root.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(AddSourcesMenu, {
                    isMenuOpen,
                    menuPosition: { x: 0, y: 0 },
                    searchQuery,
                    querySource: 'editor',
                    onQueryChange: () => {},
                    onOpen: () => {},
                    onDismiss: () => {},
                    onCommit: () => {},
                    onResetQuery: () => {},
                    menuPortalContainer: container,
                    verticalPosition,
                }),
            ),
        );
    });
};

/** Let the debounce elapse and every pending promise settle. */
const settle = async (ms = DEBOUNCE_MS) => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
};

const menuText = () => container.textContent ?? '';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.clearAllMocks();
    mocks.createSourceMenuItem.mockImplementation(buildRow);
    (globalThis as any).Zotero = {
        Collections: { getAllIDs: vi.fn(async () => []), get: vi.fn() },
        Tags: { getAll: vi.fn(async () => []) },
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

describe('AddSourcesMenu item search', () => {
    it('waits for typing to pause and runs one search for the final query', async () => {
        answer([]);
        await render('l');
        await render('lo');
        await render('lov');
        expect(mocks.searchSourceItems).not.toHaveBeenCalled();

        await settle();

        expect(mocks.searchSourceItems).toHaveBeenCalledTimes(1);
        expect(mocks.searchSourceItems).toHaveBeenCalledWith('lov', [1, 5], 10, expect.anything());
    });

    it.each(['above', 'below'] as const)('says it is searching, not that nothing was found, until the search answers (opening %s)', async (side) => {
        let respond: (result: any) => void = () => {};
        mocks.searchSourceItems.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
        await render('lovelace', side);

        expect(menuText()).toContain('Searching…');
        expect(menuText()).not.toContain('No results found');

        await settle();
        expect(menuText()).toContain('Searching…');

        await act(async () => respond({ items: [], matchCount: 0 }));
        await settle(0);
        expect(menuText()).toContain('No results found');
    });

    it('keeps saying it is searching while the rows for an answer are still being built', async () => {
        let finishRow: () => void = () => {};
        mocks.createSourceMenuItem.mockImplementation((item: any) =>
            new Promise((resolve) => { finishRow = () => resolve(buildRow(item)); }));
        answer([paper('Engine study')]);
        await render('engine', 'above');
        await settle();

        expect(menuText()).toContain('Searching…');
        expect(menuText()).not.toContain('No results found');

        await act(async () => finishRow());
        await settle(0);
        expect(menuText()).toContain('row:Engine study');
    });

    it('drops the answer to a query the user has typed past', async () => {
        let respondToFirst: (result: any) => void = () => {};
        mocks.searchSourceItems
            .mockReturnValueOnce(new Promise((resolve) => { respondToFirst = resolve; }))
            .mockResolvedValueOnce({ items: [paper('Second query')], matchCount: 1 });
        await render('first');
        await settle();
        await render('second');
        await settle();

        const [, , , { isCurrent }] = mocks.searchSourceItems.mock.calls[0];
        expect(isCurrent()).toBe(false);
        await act(async () => respondToFirst({ items: [paper('First query')], matchCount: 1 }));
        await settle(0);

        expect(menuText()).toContain('row:Second query');
        expect(menuText()).not.toContain('row:First query');
    });

    it('searches every searchable library even when the message is filtered to one', async () => {
        store.set(currentMessageFiltersAtom, {
            libraryIds: [5],
            collectionIds: [],
            tagSelections: [{ id: 1, tag: 'theory', libraryId: 5 } as any],
        });
        answer([paper('Notes on the Analytical Engine')]);
        await render('engine');
        await settle();

        expect(mocks.searchSourceItems).toHaveBeenCalledWith('engine', [1, 5], 10, expect.anything());
        expect(menuText()).toContain('row:Notes on the Analytical Engine');
    });

    it('says how many items matched when it lists only the best of them', async () => {
        answer(Array.from({ length: 10 }, (_, i) => paper(`Engine study ${i}`)), 25);
        await render('engine');
        await settle();

        expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(10);
        expect(menuText()).toContain('Top 10 of 25 matches');
    });

    it('lists every match without a count when they all fit', async () => {
        answer([paper('Engine study')]);
        await render('engine');
        await settle();

        expect(menuText()).toContain('Search Results');
        expect(menuText()).not.toContain('matches');
    });

    it.each(['above', 'below'] as const)('shows no empty-state text while preparing the rows for a bare @, on every open (opening %s)', async (side) => {
        const gateCollections = () => {
            let release: () => void = () => {};
            (globalThis as any).Zotero.Collections.getAllIDs = vi.fn(() => new Promise((resolve) => { release = () => resolve([]); }));
            return () => release();
        };

        let release = gateCollections();
        await render('', side);
        expect(menuText()).not.toMatch(/No results found|Start typing to search/);
        await act(async () => release());
        await settle(0);
        expect(menuText()).toContain('Add Note');

        await render('', side, false);
        release = gateCollections();
        await render('', side);
        expect(menuText()).not.toMatch(/No results found|Start typing to search/);
        await act(async () => release());
        await settle(0);
        expect(menuText()).toContain('Add Note');
    });
});
