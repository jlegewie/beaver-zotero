// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExcludedLibrary } from '@beaver/agent-core/types/profile';
import {
    isProfileLoadedAtom,
    localZoteroLibrariesAtom,
    profileProjectionAtom,
} from '../../../react/atoms/profile';
import LibraryAccessList from '../../../react/components/preferences/LibraryAccessList';

// The real profile atoms drive the checkboxes, so the list is proven to use
// the same exclusion keying as the searchable-library boundary. Only the
// account round-trip and the local item counts are stood in for.
const { toggled, state, counts } = vi.hoisted(() => ({
    toggled: [] as any[],
    state: { updating: false },
    counts: vi.fn(async (libraryID: number) => ({
        libraryID, groupID: null, name: '', isGroup: false,
        itemCount: libraryID * 10, attachmentCount: libraryID, pdfCount: 0, imageCount: 0,
    })),
}));
vi.mock('../../../src/utils/libraries', () => ({ getLibraryItemCounts: counts }));
vi.mock('../../../react/atoms/excludedLibraries', async () => {
    const { atom } = await import('jotai');
    return {
        isUpdatingExcludedLibrariesAtom: atom(() => state.updating),
        toggleExcludedLibraryAtom: atom(null, (_get, _set, library: any) => { toggled.push(library); }),
    };
});
vi.mock('../../../react/components/icons/icons', async () => {
    const React = await import('react');
    return {
        AlertIcon: () => null,
        Icon: () => React.createElement('span'),
        CSSIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
    };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const libraries = [
    { libraryID: 2, id: 77, name: 'Shared Group', isGroup: true, libraryType: 'group' },
    { libraryID: 1, id: 1, name: 'My Library', isGroup: false, libraryType: 'user' },
    { libraryID: 3, id: 3, name: 'A Feed', isGroup: false, libraryType: 'feed' },
];
const localLibraries = [
    { library_id: 1, group_id: null, name: 'My Library', is_group: false, type: 'user', type_id: 0, read_only: false },
    { library_id: 2, group_id: 77, name: 'Shared Group', is_group: true, type: 'group', type_id: 0, read_only: false },
];

let previousLibraries: any;
afterEach(() => {
    vi.clearAllMocks();
    toggled.length = 0;
    state.updating = false;
    (Zotero as any).Libraries = previousLibraries;
});

/** A loaded profile carrying only the exclusions; nothing else on it is read here. */
function storeWithProfile(excluded: ExcludedLibrary[] | null) {
    const store = createStore();
    store.set(localZoteroLibrariesAtom, localLibraries);
    if (excluded !== null) {
        store.set(isProfileLoadedAtom, true);
        store.set(profileProjectionAtom, { excluded_libraries: excluded } as any);
    }
    return store;
}

async function render(store: ReturnType<typeof createStore>, check: (container: HTMLDivElement) => Promise<void> | void, extra: typeof libraries = []) {
    previousLibraries = (Zotero as any).Libraries;
    (Zotero as any).Libraries = { getAll: vi.fn(async () => [...libraries, ...extra]) };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(LibraryAccessList))));
        await act(async () => { await Promise.resolve(); });
        await check(container);
    } finally {
        act(() => root.unmount());
    }
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

it('lists the personal library first, then groups, with a checked box per accessible library and item counts', async () => {
    await render(storeWithProfile([{ type: 'group', group_id: 77 }]), (container) => {
        const boxes = checkboxes(container);
        expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
            'Allow Beaver to use My Library',
            'Allow Beaver to use Shared Group',
        ]);
        expect(boxes.map((box) => box.checked)).toEqual([true, false]);
        expect(container.textContent).toContain('10 items, 1 attachments');
        expect(container.textContent).toContain('20 items, 2 attachments');
        expect(container.textContent).not.toContain('A Feed');
        expect(container.textContent).toContain('every device signed in to your account');
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
});

it('draws no checkbox until the profile that holds the exclusions has loaded', async () => {
    await render(storeWithProfile(null), (container) => {
        expect(checkboxes(container)).toHaveLength(0);
        expect(container.textContent).toContain('Waiting for your Beaver account to load…');
    });
});

it('toggles exclusion through the shared atom from the checkbox and from the row', async () => {
    await render(storeWithProfile([]), async (container) => {
        const [personal, group] = checkboxes(container);
        await act(async () => personal.click());
        expect(toggled).toHaveLength(1);
        expect(toggled[0]).toMatchObject({ library_id: 1, is_group: false, group_id: null });
        await act(async () => (group.closest('div[style]') as HTMLElement).click());
        expect(toggled).toHaveLength(2);
        expect(toggled[1]).toMatchObject({ library_id: 2, is_group: true, group_id: 77 });
    });
});

it('warns when the personal library or every library is unchecked', async () => {
    await render(storeWithProfile([{ type: 'user' }]), (container) => {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('personal library is unchecked');
        expect(checkboxes(container).map((box) => box.checked)).toEqual([false, true]);
    });
    await render(storeWithProfile([{ type: 'user' }, { type: 'group', group_id: 77 }]), (container) => {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("can't access any libraries");
        expect(checkboxes(container).every((box) => !box.checked)).toBe(true);
    });
});

it('disables every checkbox while an update is in flight and ignores clicks', async () => {
    state.updating = true;
    await render(storeWithProfile([]), async (container) => {
        const boxes = checkboxes(container);
        expect(boxes.every((box) => box.disabled)).toBe(true);
        await act(async () => (boxes[0].closest('div[style]') as HTMLElement).click());
        expect(toggled).toHaveLength(0);
    });
});

it('collapses long lists to three libraries and says how many hidden ones are unchecked', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ libraryID: 10 + i, id: 100 + i, name: `Group ${i}`, isGroup: true, libraryType: 'group' }));
    const store = storeWithProfile([{ type: 'group', group_id: 104 }, { type: 'group', group_id: 105 }]);
    store.set(localZoteroLibrariesAtom, [...localLibraries, ...many.map((g) => ({
        library_id: g.libraryID, group_id: g.id, name: g.name, is_group: true, type: 'group', type_id: 0, read_only: false,
    }))]);
    await render(store, async (container) => {
        expect(checkboxes(container)).toHaveLength(3);
        expect(checkboxes(container).map((box) => box.getAttribute('aria-label'))).toEqual([
            'Allow Beaver to use My Library', 'Allow Beaver to use Group 0', 'Allow Beaver to use Group 1',
        ]);
        const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
        expect(toggle.textContent).toBe('Show all 8 libraries · 2 unchecked');
        await act(async () => toggle.click());
        expect(checkboxes(container)).toHaveLength(8);
        expect(checkboxes(container).filter((box) => !box.checked)).toHaveLength(2);
        expect(toggle.textContent).toBe('Show fewer');
    }, many);
});

it('never collapses a list of three or fewer libraries', async () => {
    await render(storeWithProfile([]), (container) => {
        expect(checkboxes(container)).toHaveLength(2);
        expect(container.querySelector('button[aria-expanded]')).toBeNull();
    });
    const third = [{ libraryID: 10, id: 100, name: 'Group 0', isGroup: true, libraryType: 'group' }];
    await render(storeWithProfile([]), (container) => {
        expect(checkboxes(container)).toHaveLength(3);
        expect(container.querySelector('button[aria-expanded]')).toBeNull();
    }, third);
});

it('collapses at exactly four libraries and re-collapses to three on Show fewer', async () => {
    const two = [
        { libraryID: 10, id: 100, name: 'Group 0', isGroup: true, libraryType: 'group' },
        { libraryID: 11, id: 101, name: 'Group 1', isGroup: true, libraryType: 'group' },
    ];
    // Sorted: My Library, Group 0, Group 1, then Shared Group hidden and unchecked.
    await render(storeWithProfile([{ type: 'group', group_id: 77 }]), async (container) => {
        expect(checkboxes(container)).toHaveLength(3);
        expect(checkboxes(container).every((box) => box.checked)).toBe(true);
        const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
        expect(toggle.textContent).toBe('Show all 4 libraries · 1 unchecked');
        await act(async () => toggle.click());
        expect(checkboxes(container)).toHaveLength(4);
        expect(checkboxes(container)[3].checked).toBe(false);
        await act(async () => toggle.click());
        expect(checkboxes(container)).toHaveLength(3);
        expect(toggle.textContent).toBe('Show all 4 libraries · 1 unchecked');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }, two);
});

it('still lists a library whose item count could not be read', async () => {
    counts.mockRejectedValueOnce(new Error('db locked'));
    await render(storeWithProfile([]), (container) => {
        expect(checkboxes(container)).toHaveLength(2);
        expect(container.textContent).toContain('My Library');
    });
});
