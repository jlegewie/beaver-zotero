import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetInstanceLibraryRefs, mockGetZoteroUserIdentifier } = vi.hoisted(() => ({
    mockGetInstanceLibraryRefs: vi.fn(),
    mockGetZoteroUserIdentifier: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getInstanceLibraryRefs: mockGetInstanceLibraryRefs,
    getZoteroUserIdentifier: mockGetZoteroUserIdentifier,
}));

import { buildZoteroInstanceWire } from '../../../src/services/zoteroInstanceWire';

describe('buildZoteroInstanceWire', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetZoteroUserIdentifier.mockReturnValue({
            localUserKey: 'local-user-key',
        });
        mockGetInstanceLibraryRefs.mockReturnValue(['u123', 'g456']);
    });

    it('includes the searchable library scope', () => {
        expect(buildZoteroInstanceWire([1, 2])).toEqual({
            local_user_key: 'local-user-key',
            libraries: ['u123', 'g456'],
        });
        expect(mockGetInstanceLibraryRefs).toHaveBeenCalledWith([1, 2]);
    });

    it('preserves an explicitly empty searchable library scope', () => {
        mockGetInstanceLibraryRefs.mockReturnValue([]);

        expect(buildZoteroInstanceWire([])).toEqual({
            local_user_key: 'local-user-key',
            libraries: [],
        });
    });

    it('includes optional Zotero account labels when available', () => {
        mockGetZoteroUserIdentifier.mockReturnValue({
            localUserKey: 'local-user-key',
            userID: '42',
            accountName: 'Ada Lovelace',
            deviceName: 'Research Mac',
        });

        expect(buildZoteroInstanceWire([1])).toEqual({
            local_user_key: 'local-user-key',
            user_id: '42',
            account_name: 'Ada Lovelace',
            device_name: 'Research Mac',
            libraries: ['u123', 'g456'],
        });
    });
});
