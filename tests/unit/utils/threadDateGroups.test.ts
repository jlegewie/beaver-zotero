import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupThreadsByDate } from '../../../react/utils/threadDateGroups';
import type { ThreadData } from '../../../src/services/threads/types';

const thread = (id: string, daysAgo: number): ThreadData => {
    const updatedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    return { id, name: id, createdAt: updatedAt, updatedAt, isPinned: false };
};

describe('groupThreadsByDate', () => {
    beforeEach(() => {
        // Local midday, so "now" and "today" agree in every time zone.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

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
