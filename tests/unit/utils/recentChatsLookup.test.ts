import { describe, expect, it } from 'vitest';
import {
    buildRecentChatsCacheKey,
    buildRecentChatsItemLookup,
} from '../../../react/utils/recentChatsLookup';

describe('buildRecentChatsCacheKey', () => {
    it('changes when searchable library access changes', () => {
        const baseKey = 'user-1:reader:ATTACH01';

        expect(buildRecentChatsCacheKey(baseKey, [1, 42])).not.toBe(
            buildRecentChatsCacheKey(baseKey, [1]),
        );
    });

    it('is stable when searchable library IDs are reordered', () => {
        const baseKey = 'user-1:reader:ATTACH01';

        expect(buildRecentChatsCacheKey(baseKey, [42, 1])).toBe(
            buildRecentChatsCacheKey(baseKey, [1, 42]),
        );
    });
});

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
