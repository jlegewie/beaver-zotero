import { describe, it, expect } from 'vitest';
import { deduplicateByThread } from '../../../react/utils/threadMatches';
import { ThreadRunMatch } from '../../../src/services/threadService';

function match(overrides: Partial<ThreadRunMatch> = {}): ThreadRunMatch {
    return {
        id: 'thread-1',
        user_id: 'user-1',
        name: 'Thread 1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        run_id: 'run-1',
        match_type: 'user_attachment',
        ...overrides,
    };
}

describe('deduplicateByThread', () => {
    it('keeps the most-recent updated_at when a thread has multiple matches', () => {
        const matches: ThreadRunMatch[] = [
            match({ id: 'thread-1', updated_at: '2026-01-01T00:00:00Z', name: 'Older' }),
            match({ id: 'thread-1', updated_at: '2026-01-03T00:00:00Z', name: 'Newer' }),
            match({ id: 'thread-1', updated_at: '2026-01-02T00:00:00Z', name: 'Middle' }),
        ];

        const result = deduplicateByThread(matches);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: 'thread-1', name: 'Newer', updatedAt: '2026-01-03T00:00:00Z' });
    });

    it('sorts distinct threads newest-first', () => {
        const matches: ThreadRunMatch[] = [
            match({ id: 'thread-old', updated_at: '2026-01-01T00:00:00Z' }),
            match({ id: 'thread-new', updated_at: '2026-01-05T00:00:00Z' }),
            match({ id: 'thread-mid', updated_at: '2026-01-03T00:00:00Z' }),
        ];

        const result = deduplicateByThread(matches);

        expect(result.map(t => t.id)).toEqual(['thread-new', 'thread-mid', 'thread-old']);
    });

    it('falls back to an empty name when the match has none', () => {
        const matches: ThreadRunMatch[] = [match({ name: undefined })];

        const result = deduplicateByThread(matches);

        expect(result[0].name).toBe('');
    });

    it('returns an empty array for no matches', () => {
        expect(deduplicateByThread([])).toEqual([]);
    });
});
