import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks — useProfileSync's import chain reaches supabase-backed services
// =============================================================================

vi.mock('../../../src/services/FileUploader', () => ({ fileUploader: {} }));
vi.mock('../../../src/services/accountService', () => ({ accountService: {} }));

const claimThreadsMock = vi.fn();
vi.mock('../../../src/services/threadService', () => ({
    threadService: { claimThreads: (...args: unknown[]) => claimThreadsMock(...args) },
}));

const getZoteroUserIdentifierMock = vi.fn();
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: (...args: unknown[]) => getZoteroUserIdentifierMock(...args),
    currentZoteroInstanceRef: vi.fn(() => null),
}));

const getPrefMock = vi.fn();
const setPrefMock = vi.fn();
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (...args: unknown[]) => getPrefMock(...args),
    setPref: (...args: unknown[]) => setPrefMock(...args),
}));

const storeGetMock = vi.fn();
vi.mock('../../../react/store', () => ({
    store: { get: (...args: unknown[]) => storeGetMock(...args) },
}));

vi.mock('../../../react/atoms/auth', async () => {
    const { atom } = await import('jotai');
    return {
        isAuthenticatedAtom: atom(false),
        logoutAtom: atom(null, () => {}),
        userAtom: atom<{ id: string } | null>(null),
        isWaitingForProfileAtom: atom(false),
    };
});

vi.mock('../../../react/atoms/models', async () => {
    const { atom } = await import('jotai');
    return { setModelsAtom: atom(null, () => {}) };
});

vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return {
        isSidebarVisibleAtom: atom(false),
        isPreferencePageVisibleAtom: atom(false),
    };
});

vi.mock('../../../src/utils/zoteroSerializers', () => ({ serializeZoteroLibrary: vi.fn() }));

vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        isProfileLoadedAtom: atom(false),
        profileWithPlanAtom: atom(null),
        isMigratingDataAtom: atom(false),
        requiredDataVersionAtom: atom(0),
        localZoteroLibrariesAtom: atom([]),
        minimumFrontendVersionAtom: atom(null),
        syncDeniedForPlanAtom: atom(false),
        prefWindowFocusRefreshAtom: atom(0),
        errorCreditCheckAtom: atom(0),
        profileSyncStatusAtom: atom({ kind: 'ok' }),
    };
});

import { claimPreSyncThreads } from '../../../react/hooks/useProfileSync';

const USER_ID = 'beaver-user-1';

describe('claimPreSyncThreads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getZoteroUserIdentifierMock.mockReturnValue({ userID: '123456', localUserKey: 'LOCALKEY' });
        getPrefMock.mockReturnValue('');
        storeGetMock.mockReturnValue({ id: USER_ID });
        claimThreadsMock.mockResolvedValue({ claimed: 2 });
    });

    it('claims once and persists the Beaver-account-scoped throttle key', async () => {
        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).toHaveBeenCalledWith(
            { zoteroUserId: '123456', zoteroLocalId: 'LOCALKEY' },
            USER_ID
        );
        expect(setPrefMock).toHaveBeenCalledWith('threadsClaimKey', `${USER_ID}:123456:LOCALKEY`);
    });

    it('does nothing without a Zotero account id (logged out) and clears the throttle', async () => {
        getZoteroUserIdentifierMock.mockReturnValue({ userID: undefined, localUserKey: 'LOCALKEY' });
        getPrefMock.mockReturnValue(`${USER_ID}:123456:LOCALKEY`);

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).not.toHaveBeenCalled();
        expect(setPrefMock).toHaveBeenCalledWith('threadsClaimKey', '');
    });

    it('leaves an empty throttle untouched when logged out of Zotero', async () => {
        getZoteroUserIdentifierMock.mockReturnValue({ userID: undefined, localUserKey: 'LOCALKEY' });
        getPrefMock.mockReturnValue('');

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).not.toHaveBeenCalled();
        expect(setPrefMock).not.toHaveBeenCalled();
    });

    it('re-claims after logout cleared the throttle for the same Zotero account', async () => {
        // Simulates: previously claimed, user logged out (pref cleared), then
        // logged back into the same Zotero account with new local-only threads.
        getPrefMock.mockReturnValue('');

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).toHaveBeenCalledWith(
            { zoteroUserId: '123456', zoteroLocalId: 'LOCALKEY' },
            USER_ID
        );
        expect(setPrefMock).toHaveBeenCalledWith('threadsClaimKey', `${USER_ID}:123456:LOCALKEY`);
    });

    it('skips when the throttle key already matches this combination', async () => {
        getPrefMock.mockReturnValue(`${USER_ID}:123456:LOCALKEY`);

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).not.toHaveBeenCalled();
    });

    it('re-claims when the Beaver account differs from the recorded key', async () => {
        getPrefMock.mockReturnValue(`other-beaver-user:123456:LOCALKEY`);

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).toHaveBeenCalled();
    });

    it('aborts before claiming when the session moved to another Beaver account', async () => {
        storeGetMock.mockReturnValue({ id: 'different-user' });

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).not.toHaveBeenCalled();
        expect(setPrefMock).not.toHaveBeenCalled();
    });

    it('does not persist the throttle when the account switched mid-request', async () => {
        storeGetMock
            .mockReturnValueOnce({ id: USER_ID })
            .mockReturnValueOnce({ id: 'different-user' });

        await claimPreSyncThreads(USER_ID);

        expect(claimThreadsMock).toHaveBeenCalled();
        expect(setPrefMock).not.toHaveBeenCalled();
    });

    it('leaves the throttle unset on failure so the next sync retries', async () => {
        claimThreadsMock.mockRejectedValue(new Error('endpoint missing'));

        await expect(claimPreSyncThreads(USER_ID)).resolves.toBeUndefined();

        expect(setPrefMock).not.toHaveBeenCalled();
    });
});
