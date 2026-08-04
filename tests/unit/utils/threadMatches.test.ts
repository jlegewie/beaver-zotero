import { describe, it, expect } from 'vitest';
import { deduplicateByThread, threadModelToThreadData, isThreadInstanceMismatch } from '../../../react/utils/threadMatches';
import { ThreadRunMatch, ZoteroInstanceRef } from '@beaver/agent-core/transport/threadService';

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

    it('preserves instance identity fields through deduplication', () => {
        const matches: ThreadRunMatch[] = [
            match({ id: 'foreign', zotero_user_id: '999999', zotero_local_id: 'FOREIGNKEY' }),
            match({ id: 'unattributed', updated_at: '2026-01-02T00:00:00Z' }),
        ];

        const result = deduplicateByThread(matches);

        const foreign = result.find(t => t.id === 'foreign');
        const unattributed = result.find(t => t.id === 'unattributed');
        expect(foreign).toMatchObject({ zoteroUserId: '999999', zoteroLocalId: 'FOREIGNKEY' });
        expect(unattributed).toMatchObject({ zoteroUserId: null, zoteroLocalId: null });
    });
});

describe('threadModelToThreadData', () => {
    it('maps wire fields including instance identity', () => {
        expect(threadModelToThreadData({
            id: 't1',
            name: 'Named',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            zotero_user_id: '123',
            zotero_local_id: 'LOCAL',
        })).toEqual({
            id: 't1',
            name: 'Named',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
            zoteroUserId: '123',
            zoteroLocalId: 'LOCAL',
        });
    });

    it('normalizes absent identity fields to null', () => {
        const mapped = threadModelToThreadData({
            id: 't1',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
        });
        expect(mapped.name).toBe('');
        expect(mapped.zoteroUserId).toBeNull();
        expect(mapped.zoteroLocalId).toBeNull();
    });
});

describe('isThreadInstanceMismatch', () => {
    const current: ZoteroInstanceRef = { zoteroUserId: '111', zoteroLocalId: 'CURKEY' };
    const unsyncedCurrent: ZoteroInstanceRef = { zoteroUserId: null, zoteroLocalId: 'CURKEY' };

    it('never mismatches when the current identity is unknown', () => {
        expect(isThreadInstanceMismatch(null, { zoteroUserId: '999', zoteroLocalId: 'X' })).toBe(false);
    });

    it('unattributed threads (both null) match everywhere', () => {
        expect(isThreadInstanceMismatch(current, {})).toBe(false);
        expect(isThreadInstanceMismatch(current, { zoteroUserId: null, zoteroLocalId: null })).toBe(false);
    });

    it('matches on the account user id alone', () => {
        expect(isThreadInstanceMismatch(current, { zoteroUserId: '111', zoteroLocalId: 'OTHERKEY' })).toBe(false);
        expect(isThreadInstanceMismatch(current, { zoteroUserId: '111', zoteroLocalId: null })).toBe(false);
    });

    it('matches on the local key alone', () => {
        expect(isThreadInstanceMismatch(current, { zoteroUserId: null, zoteroLocalId: 'CURKEY' })).toBe(false);
        expect(isThreadInstanceMismatch(current, { zoteroUserId: '999', zoteroLocalId: 'CURKEY' })).toBe(false);
    });

    it('mismatches when both stored fields are foreign', () => {
        expect(isThreadInstanceMismatch(current, { zoteroUserId: '999', zoteroLocalId: 'FOREIGN' })).toBe(true);
    });

    it('mismatches on partial-null foreign identities', () => {
        expect(isThreadInstanceMismatch(current, { zoteroUserId: '999', zoteroLocalId: null })).toBe(true);
        expect(isThreadInstanceMismatch(current, { zoteroUserId: null, zoteroLocalId: 'FOREIGN' })).toBe(true);
    });

    it('a null current user id never matches a stored user id', () => {
        // Unsynced install: a thread stamped only with a foreign account id is hidden.
        expect(isThreadInstanceMismatch(unsyncedCurrent, { zoteroUserId: '999', zoteroLocalId: null })).toBe(true);
        expect(isThreadInstanceMismatch(unsyncedCurrent, { zoteroUserId: null, zoteroLocalId: 'CURKEY' })).toBe(false);
    });
});
