import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import {
    isProfileLoadedAtom,
    localZoteroLibrariesAtom,
    localZoteroLibrariesInitializedAtom,
    profileWithPlanAtom,
} from '../../../react/atoms/profile';
import { SafeProfileWithPlan } from '../../../react/types/profile';
import { ZoteroLibrary } from '../../../react/types/zotero';
import {
    publishLibraryScope,
    subscribeLibraryScopeMirror,
} from '../../../react/hooks/useLibraryScopeMirror';
import { isLibraryInScope, isLibraryScopeKnown } from '../../../src/services/libraryScope';

function library(libraryId: number, isGroup = false, groupId?: number): ZoteroLibrary {
    return {
        library_id: libraryId,
        name: `Library ${libraryId}`,
        is_group: isGroup,
        group_id: groupId ?? null,
    } as ZoteroLibrary;
}

function profile(excluded: SafeProfileWithPlan['excluded_libraries'] = []) {
    return { excluded_libraries: excluded } as SafeProfileWithPlan;
}

/** A store whose scope is loaded with libraries 1 and 2, nothing excluded. */
function loadedStore() {
    const store = createStore();
    store.set(profileWithPlanAtom, profile());
    store.set(isProfileLoadedAtom, true);
    store.set(localZoteroLibrariesAtom, [library(1), library(2, true, 55)]);
    store.set(localZoteroLibrariesInitializedAtom, true);
    return store;
}

let abortJobsOutsideScope: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    abortJobsOutsideScope = vi.fn();
    (globalThis as any).Zotero.Beaver = {
        backgroundExtractor: { abortJobsOutsideScope },
    };
});

afterEach(() => {
    (globalThis as any).Zotero.Beaver = undefined;
});

describe('library scope mirror', () => {
    it('publishes the searchable set once the scope is loaded', () => {
        publishLibraryScope(loadedStore());

        expect(isLibraryScopeKnown()).toBe(true);
        expect(isLibraryInScope(1)).toBe(true);
        expect(isLibraryInScope(2)).toBe(true);
    });

    it('fails closed while the profile or library list is still loading', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile());
        store.set(isProfileLoadedAtom, true);
        // Local libraries not yet enumerated.

        publishLibraryScope(store);

        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('applies an exclusion in the same turn as the store write', () => {
        const store = loadedStore();
        const unsubscribe = subscribeLibraryScopeMirror(store);
        expect(isLibraryInScope(1)).toBe(true);

        // No await: a background tick can run as soon as the setter returns, so
        // the mirror must already deny the excluded library at this point.
        store.set(profileWithPlanAtom, profile([{ type: 'user' }]));

        expect(isLibraryInScope(1)).toBe(false);
        expect(isLibraryInScope(2)).toBe(true);
        unsubscribe();
    });

    it('applies a group exclusion in the same turn as the store write', () => {
        const store = loadedStore();
        const unsubscribe = subscribeLibraryScopeMirror(store);

        store.set(profileWithPlanAtom, profile([{ type: 'group', group_id: 55 }]));

        expect(isLibraryInScope(2)).toBe(false);
        expect(isLibraryInScope(1)).toBe(true);
        unsubscribe();
    });

    it('clears the mirror when the profile unloads (logout / account switch)', () => {
        const store = loadedStore();
        const unsubscribe = subscribeLibraryScopeMirror(store);

        store.set(isProfileLoadedAtom, false);

        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
        unsubscribe();
    });

    it('interrupts in-flight background jobs when the scope shrinks', () => {
        const store = loadedStore();
        const unsubscribe = subscribeLibraryScopeMirror(store);
        abortJobsOutsideScope.mockClear();

        store.set(profileWithPlanAtom, profile([{ type: 'user' }]));

        expect(abortJobsOutsideScope).toHaveBeenCalled();
        unsubscribe();
    });

    it('stops publishing after unsubscribe', () => {
        const store = loadedStore();
        const unsubscribe = subscribeLibraryScopeMirror(store);
        unsubscribe();

        store.set(profileWithPlanAtom, profile([{ type: 'user' }]));

        // Stale-but-frozen is the documented trade-off for a closed window; the
        // point of the assertion is that unsubscribe really detaches.
        expect(isLibraryInScope(1)).toBe(true);
    });
});
