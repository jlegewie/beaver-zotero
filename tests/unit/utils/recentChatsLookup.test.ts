import { describe, expect, it } from 'vitest';
import { buildRecentChatsItemLookup } from '../../../react/utils/recentChatsLookup';

describe('buildRecentChatsItemLookup', () => {
    it('returns no backend lookup payload for an excluded library', () => {
        expect(buildRecentChatsItemLookup(42, ['ITEMKEY1'], [1, 7])).toBeNull();
    });

    it('returns the item lookup payload for a searchable library', () => {
        expect(buildRecentChatsItemLookup(42, ['ATTACH01', 'PARENT01'], [1, 42])).toEqual({
            libraryId: 42,
            zoteroKeys: ['ATTACH01', 'PARENT01'],
        });
    });

    it('returns no lookup payload when the item context is incomplete', () => {
        expect(buildRecentChatsItemLookup(undefined, ['ITEMKEY1'], [1])).toBeNull();
        expect(buildRecentChatsItemLookup(1, [], [1])).toBeNull();
    });
});
