import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetInstanceIndexScopeRefs, mockGetZoteroUserIdentifier } = vi.hoisted(() => ({
    mockGetInstanceIndexScopeRefs: vi.fn(),
    mockGetZoteroUserIdentifier: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getInstanceIndexScopeRefs: mockGetInstanceIndexScopeRefs,
    getZoteroUserIdentifier: mockGetZoteroUserIdentifier,
}));

import { buildZoteroInstanceWire } from '../../../src/services/zoteroInstanceWire';

describe('buildZoteroInstanceWire', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetZoteroUserIdentifier.mockReturnValue({
            localUserKey: 'local-user-key',
        });
        mockGetInstanceIndexScopeRefs.mockReturnValue(['l123', 'g456']);
    });

    it('includes the searchable library scope', () => {
        expect(buildZoteroInstanceWire([1, 2])).toEqual({
            local_user_key: 'local-user-key',
            index_scope_refs: ['l123', 'g456'],
        });
        expect(mockGetInstanceIndexScopeRefs).toHaveBeenCalledWith([1, 2]);
    });

    it('preserves an explicitly empty searchable library scope', () => {
        mockGetInstanceIndexScopeRefs.mockReturnValue([]);

        expect(buildZoteroInstanceWire([])).toEqual({
            local_user_key: 'local-user-key',
            index_scope_refs: [],
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
            index_scope_refs: ['l123', 'g456'],
        });
    });
});
