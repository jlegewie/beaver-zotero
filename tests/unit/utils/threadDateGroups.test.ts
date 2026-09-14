import { describe, expect, it } from 'vitest';
import { groupThreadsByDate } from '../../../react/utils/threadDateGroups';
import type { ThreadData } from '../../../src/services/threads/types';

const thread = (id: string, daysAgo: number): ThreadData => {
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    // Wire dates are UTC strings without a zone suffix.
    const updatedAt = date.toISOString().replace('Z', '');
    return { id, name: id, createdAt: updatedAt, updatedAt, isPinned: false };
};

describe('groupThreadsByDate', () => {
    it('buckets chats by age in display order and drops empty groups', () => {
        const groups = groupThreadsByDate([thread('old', 400), thread('now', 0), thread('now-2', 0)]);
        expect(groups.map(g => g.label)).toEqual(['Today', 'Older']);
        expect(groups[0].threads.map(t => t.id)).toEqual(['now', 'now-2']);
        expect(groups[1].threads.map(t => t.id)).toEqual(['old']);
    });

    it('returns nothing for an empty history', () => {
        expect(groupThreadsByDate([])).toEqual([]);
    });
});
