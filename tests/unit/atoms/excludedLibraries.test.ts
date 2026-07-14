import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeProfileWithPlan } from '../../../react/types/profile';
import { ZoteroLibrary } from '../../../react/types/zotero';

const { updateExcludedLibrariesMock, popupMessages } = vi.hoisted(() => ({
    updateExcludedLibrariesMock: vi.fn(),
    popupMessages: [] as any[],
}));

vi.mock('../../../src/services/accountService', () => ({
    accountService: {
        updateExcludedLibraries: updateExcludedLibrariesMock,
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-local' })),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

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
    localZoteroLibrariesAtom,
    profileWithPlanAtom,
    searchableLibraryIdsAtom,
} from '../../../react/atoms/profile';
import { toggleExcludedLibraryAtom } from '../../../react/atoms/excludedLibraries';

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
    it('keeps access decisions pending until profile and local libraries are loaded', () => {
        const store = createStore();

        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(profileWithPlanAtom, profile());
        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(isProfileLoadedAtom, true);

        expect(store.get(isLibraryAccessReadyAtom)).toBe(true);
    });

    it('returns all local library IDs when nothing is excluded', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile());
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1, 42]);
    });

    it('removes the personal library for the global user exclusion entry', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'user' }] }));
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([42]);
    });

    it('removes group libraries by global group ID', () => {
        const store = createStore();
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
        updateExcludedLibrariesMock.mockResolvedValue({ message: 'ok' });
        popupMessages.length = 0;
    });

    it('adds a library while preserving exclusions absent from this device', async () => {
        const store = createStore();
        const absentGroup = { type: 'group' as const, group_id: 999 };
        const visibleGroup = library({
            library_id: 42,
            group_id: 123,
            name: 'Visible Group',
            is_group: true,
            type: 'group',
        });
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [absentGroup] }));

        await store.set(toggleExcludedLibraryAtom, visibleGroup);

        expect(store.get(profileWithPlanAtom)?.excluded_libraries).toEqual([
            absentGroup,
            { type: 'group', group_id: 123 },
        ]);
        expect(updateExcludedLibrariesMock).toHaveBeenCalledWith([
            absentGroup,
            { type: 'group', group_id: 123 },
        ]);
    });

    it('removes a library and keeps other stored exclusions', async () => {
        const store = createStore();
        const absentGroup = { type: 'group' as const, group_id: 999 };
        const personal = library({ library_id: 1 });
        store.set(profileWithPlanAtom, profile({
            excluded_libraries: [{ type: 'user' }, absentGroup],
        }));

        await store.set(toggleExcludedLibraryAtom, personal);

        expect(store.get(profileWithPlanAtom)?.excluded_libraries).toEqual([absentGroup]);
        expect(updateExcludedLibrariesMock).toHaveBeenCalledWith([absentGroup]);
    });

    it('reverts the optimistic update and surfaces a popup on save failure', async () => {
        const store = createStore();
        const initial = [{ type: 'user' as const }];
        const personal = library({ library_id: 1 });
        updateExcludedLibrariesMock.mockRejectedValueOnce(new Error('offline'));
        store.set(profileWithPlanAtom, profile({ excluded_libraries: initial }));

        await store.set(toggleExcludedLibraryAtom, personal);

        expect(store.get(profileWithPlanAtom)?.excluded_libraries).toEqual(initial);
        expect(popupMessages).toHaveLength(1);
        expect(popupMessages[0]).toMatchObject({ type: 'error' });
    });

    it('does not clobber a profile refresh when reverting a failed save', async () => {
        const store = createStore();
        const initial = [{ type: 'user' as const }];
        const personal = library({ library_id: 1 });
        let rejectSave!: (error: Error) => void;
        updateExcludedLibrariesMock.mockReturnValueOnce(new Promise((_resolve, reject) => {
            rejectSave = reject;
        }));
        store.set(profileWithPlanAtom, profile({
            data_version: 1,
            excluded_libraries: initial,
        }));

        const operation = store.set(toggleExcludedLibraryAtom, personal);
        const refreshedProfile = store.get(profileWithPlanAtom);
        store.set(profileWithPlanAtom, refreshedProfile ? {
            ...refreshedProfile,
            data_version: 2,
            credit_plan: 'plus',
        } : refreshedProfile);

        rejectSave(new Error('offline'));
        await operation;

        expect(store.get(profileWithPlanAtom)).toMatchObject({
            data_version: 2,
            credit_plan: 'plus',
            excluded_libraries: initial,
        });
        expect(popupMessages).toHaveLength(1);
    });
});
