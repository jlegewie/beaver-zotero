import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeProfileWithPlan } from '@beaver/agent-core/types/profile';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';

const { updateExcludedLibrariesMock, popupMessages } = vi.hoisted(() => ({
    updateExcludedLibrariesMock: vi.fn(),
    popupMessages: [] as any[],
}));

vi.mock('@beaver/agent-core/transport/clients/accountService', () => ({
    accountService: {
        updateExcludedLibraries: updateExcludedLibrariesMock,
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-local' })),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await vi.importActual<typeof import('jotai')>('jotai');
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: any) => {
            popupMessages.push(message);
        }),
    };
});

import {
    allLibrariesExcludedAtom,
    isLibraryAccessReadyAtom,
    isProfileLoadedAtom,
    libraryScopeInitializedAtom,
    localZoteroLibrariesAtom,
    localZoteroLibrariesInitializedAtom,
    profileProjectionAtom as profileWithPlanAtom,
    searchableLibraryIdsAtom,
} from '../../../react/atoms/profile';
import { toggleExcludedLibraryAtom, isUpdatingExcludedLibrariesAtom } from '../../../react/atoms/excludedLibraries';

function library(overrides: Partial<ZoteroLibrary>): ZoteroLibrary {
    return {
        library_id: 1,
        group_id: null,
        name: 'My Library',
        is_group: false,
        type: 'user',
        type_id: 1,
        read_only: false,
        ...overrides,
    };
}

function profile(overrides: Partial<SafeProfileWithPlan> = {}): SafeProfileWithPlan {
    return {
        user_id: 'user-1',
        current_plan_id: 'plan-1',
        credit_plan: null,
        credit_plan_status: 'none',
        credit_plan_monthly_credits: 0,
        credit_period_start: null,
        credit_period_end: null,
        credit_monthly_reset_at: null,
        credit_cancel_at_period_end: false,
        credit_pending_downgrade: false,
        rolled_over_credits: 0,
        purchased_credits_expires_at: null,
        zotero_user_id: null,
        zotero_local_ids: ['test-local'],
        use_zotero_sync: false,
        has_authorized_access: false,
        has_completed_onboarding: true,
        has_authorized_free_access: true,
        pending_upgrade_consent: false,
        pending_downgrade_ack: false,
        consent_to_share: false,
        email_notifications: false,
        libraries: [],
        excluded_libraries: [],
        first_run_completed_at: null,
        first_run_completion_kind: null,
        standard_page_balance: 0,
        purchased_standard_page_balance: 0,
        chat_credits_used: 0,
        purchased_chat_credits: 0,
        indexing_complete: false,
        data_version: 0,
        data_migrated_at: null,
        plan: {
            id: 'plan-1',
            name: 'free',
            display_name: 'Free',
            price_monthly: 0,
            active: true,
            monthly_chat_credits: 0,
            initial_page_grant: 0,
            monthly_page_grant: 0,
            sync_database: false,
            upload_files: false,
            mcp_server: false,
            supported_file_types: [],
            max_file_size_mb: 10,
            max_page_count: 100,
            max_storage_gb: 0,
            max_user_attachments: 2,
        },
        ...overrides,
    };
}

describe('searchableLibraryIdsAtom', () => {
    it('initializes library scope only after both profile and local libraries load', () => {
        const store = createStore();

        expect(store.get(libraryScopeInitializedAtom)).toBe(false);

        store.set(localZoteroLibrariesInitializedAtom, true);
        expect(store.get(libraryScopeInitializedAtom)).toBe(false);

        store.set(isProfileLoadedAtom, true);
        expect(store.get(libraryScopeInitializedAtom)).toBe(true);

        store.set(isProfileLoadedAtom, false);
        expect(store.get(libraryScopeInitializedAtom)).toBe(false);
    });

    it('keeps access decisions pending until profile and local libraries are loaded', () => {
        const store = createStore();

        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(profileWithPlanAtom, profile());
        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(isProfileLoadedAtom, true);

        expect(store.get(isLibraryAccessReadyAtom)).toBe(true);
    });

    it('returns all local library IDs when nothing is excluded', () => {
        const store = createStore();
        store.set(isProfileLoadedAtom, true);
        store.set(profileWithPlanAtom, profile());
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1, 42]);
    });

    it('removes the personal library for the global user exclusion entry', () => {
        const store = createStore();
        store.set(isProfileLoadedAtom, true);
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'user' }] }));
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([42]);
    });

    it('removes group libraries by global group ID', () => {
        const store = createStore();
        store.set(isProfileLoadedAtom, true);
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'group', group_id: 123 }] }));
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);
    });

    it('reports all libraries excluded only after local libraries are loaded', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'user' }] }));

        expect(store.get(allLibrariesExcludedAtom)).toBe(false);

        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);

        expect(store.get(allLibrariesExcludedAtom)).toBe(false);

        store.set(isProfileLoadedAtom, true);

        expect(store.get(allLibrariesExcludedAtom)).toBe(true);
    });
});

describe('toggleExcludedLibraryAtom', () => {
    beforeEach(() => {
        updateExcludedLibrariesMock.mockReset();
        updateExcludedLibrariesMock.mockResolvedValue(undefined);
        Zotero.Beaver ??= {} as any;
        Zotero.Beaver.account = { updateExcludedLibraries: updateExcludedLibrariesMock } as any;
        popupMessages.length = 0;
    });

    it('delegates addition while preserving exclusions absent from this device', async () => {
        const store = createStore();
        const absent = { type: 'group' as const, group_id: 999 };
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [absent] }));
        await store.set(toggleExcludedLibraryAtom, library({library_id: 42, group_id: 123, is_group: true, type: 'group'}));
        expect(updateExcludedLibrariesMock).toHaveBeenCalledWith([absent, {type: 'group', group_id: 123}]);
    });

    it('delegates removal without overwriting the authoritative projection', async () => {
        const store = createStore();
        const entries = [{type: 'user' as const}, {type: 'group' as const, group_id: 999}];
        store.set(profileWithPlanAtom, profile({excluded_libraries: entries}));
        await store.set(toggleExcludedLibraryAtom, library({library_id: 1}));
        expect(updateExcludedLibrariesMock).toHaveBeenCalledWith([entries[1]]);
        expect(store.get(profileWithPlanAtom)?.excluded_libraries).toEqual(entries);
    });

    it('waits for the instance command and surfaces save failures', async () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile());
        let reject!: (error: Error) => void;
        updateExcludedLibrariesMock.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
        const pending = store.set(toggleExcludedLibraryAtom, library({library_id: 1}));
        expect(store.get(isUpdatingExcludedLibrariesAtom)).toBe(true);
        reject(new Error('offline'));
        await pending;
        expect(store.get(isUpdatingExcludedLibrariesAtom)).toBe(false);
        expect(popupMessages).toEqual([expect.objectContaining({type: 'error'})]);
    });
});
