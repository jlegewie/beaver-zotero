import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// zoteroUtils pulls in a transitive chain (sourceUtils → react atoms) at load.
// react/atoms/profile.ts calls getZoteroUserIdentifier() at module top-level, so a
// minimal Zotero.Users must exist before import; and supabaseClient throws without env.
vi.hoisted(() => {
    const Z = ((globalThis as any).Zotero = (globalThis as any).Zotero || {});
    Z.Users = Z.Users || {
        getCurrentUserID: () => 0,
        getLocalUserKey: () => 'bootstrap',
        getCurrentUsername: () => '',
        getCurrentName: () => '',
    };
});
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({ store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() } }));

import { getInstanceLibraryRefs, getZoteroUserIdentifier } from '../../../src/utils/zoteroUtils';

/**
 * getZoteroUserIdentifier() identifies a Zotero install for the WS handshake.
 * localUserKey is always present; the rest are best-effort and must degrade to
 * `undefined` (never throw) so auth is never blocked.
 */
describe('getZoteroUserIdentifier', () => {
    const Z = () => (globalThis as any).Zotero;
    let savedUsers: any;
    let savedCc: any;

    beforeEach(() => {
        savedUsers = Z().Users;
        savedCc = (globalThis as any).Cc;

        Z().Users = {
            getCurrentUserID: () => 17517181,
            getLocalUserKey: () => '28tUI2tp',
            getCurrentUsername: () => 'greg.hoch',
            getCurrentName: () => 'greg.hoch',
        };
        (globalThis as any).Ci = { nsIDNSService: {} };
        (globalThis as any).Cc = {
            '@mozilla.org/network/dns-service;1': {
                getService: () => ({ myHostName: 'XY-MacBook-Pro-3' }),
            },
        };
    });

    afterEach(() => {
        Z().Users = savedUsers;
        (globalThis as any).Cc = savedCc;
    });

    it('returns all fields when synced and APIs succeed', () => {
        expect(getZoteroUserIdentifier()).toEqual({
            userID: '17517181',
            localUserKey: '28tUI2tp',
            accountName: 'greg.hoch',
            deviceName: 'XY-MacBook-Pro-3',
        });
    });

    it('omits account fields when sync is off (no userID)', () => {
        Z().Users.getCurrentUserID = () => 0;
        const id = getZoteroUserIdentifier();
        expect(id.userID).toBeUndefined();
        expect(id.accountName).toBeUndefined();
        // localUserKey and deviceName are independent of sync and still present
        expect(id.localUserKey).toBe('28tUI2tp');
        expect(id.deviceName).toBe('XY-MacBook-Pro-3');
    });

    it('degrades deviceName to undefined when the DNS API throws', () => {
        (globalThis as any).Cc['@mozilla.org/network/dns-service;1'].getService = () => {
            throw new Error('no dns service');
        };
        const id = getZoteroUserIdentifier();
        expect(id.deviceName).toBeUndefined();
        // The always-present discriminator survives regardless
        expect(id.localUserKey).toBe('28tUI2tp');
    });
});

describe('getInstanceLibraryRefs', () => {
    const Z = () => (globalThis as any).Zotero;
    let savedLibraries: any;
    let savedGroups: any;

    beforeEach(() => {
        savedLibraries = Z().Libraries;
        savedGroups = Z().Groups;

        Z().Users = {
            getCurrentUserID: () => 17517181,
            getLocalUserKey: () => '28tUI2tp',
            getCurrentUsername: () => 'greg.hoch',
            getCurrentName: () => 'greg.hoch',
        };
        Z().Libraries = {
            get: vi.fn((libraryID: number) => {
                if (libraryID === 1) return { libraryID: 1, libraryType: 'user' };
                if (libraryID === 42) return { libraryID: 42, libraryType: 'group' };
                if (libraryID === 99) return { libraryID: 99, libraryType: 'feed' };
                return null;
            }),
            getAll: vi.fn(() => {
                throw new Error('getAll should not be used for handshake scope');
            }),
        };
        Z().Groups = {
            getGroupIDFromLibraryID: vi.fn((libraryID: number) => libraryID === 42 ? 123 : null),
        };
    });

    afterEach(() => {
        Z().Libraries = savedLibraries;
        Z().Groups = savedGroups;
    });

    it('returns canonical refs only for searchable libraries', () => {
        expect(getInstanceLibraryRefs([1, 42, 99])).toEqual(['u17517181', 'g123']);
        expect(Z().Libraries.getAll).not.toHaveBeenCalled();
        expect(Z().Libraries.get).toHaveBeenCalledWith(1);
        expect(Z().Libraries.get).toHaveBeenCalledWith(42);
        expect(Z().Libraries.get).toHaveBeenCalledWith(99);
    });
});
