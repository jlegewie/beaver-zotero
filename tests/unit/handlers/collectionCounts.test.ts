import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import {
    countsFor,
    getCollectionItemCounts,
    getSubcollectionCounts,
} from '../../../src/services/agentDataProvider/collectionCounts';
import { logger } from '@beaver/agent-core/platform/logger';

/** Build a grouped `collectionID -> count` result row. */
function row(collectionId: number, count: number) {
    return {
        getResultByIndex: vi.fn((i: number) => (i === 0 ? collectionId : count)),
    };
}

/**
 * Classify which count query a SQL string is. The item query LEFT JOINs both
 * itemNotes and itemAttachments to exclude them, so it has to be identified
 * first — by the annotations join that only it performs.
 */
function queryKind(sql: string): 'items' | 'attachments' | 'notes' | 'subcollections' {
    if (sql.includes('parentCollectionID')) return 'subcollections';
    if (sql.includes('itemAnnotations')) return 'items';
    if (sql.includes('itemAttachments')) return 'attachments';
    return 'notes';
}

describe('collection counts', () => {
    const queryAsync = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.DB = { queryAsync };
    });

    /** Serve fixed per-kind results regardless of the ids requested. */
    function serve(results: Partial<Record<ReturnType<typeof queryKind>, Array<[number, number]>>>) {
        queryAsync.mockImplementation(async (sql: string, _params: any[], opts: any) => {
            for (const [id, count] of results[queryKind(sql)] ?? []) {
                opts.onRow(row(id, count));
            }
        });
    }

    describe('getCollectionItemCounts', () => {
        it('returns per-collection counts keyed by collection id', async () => {
            serve({
                items: [[10, 42], [11, 7]],
                attachments: [[10, 2]],
                notes: [[10, 3], [11, 1]],
            });

            const counts = await getCollectionItemCounts([10, 11]);

            expect(counts.get(10)).toEqual({
                itemCount: 42,
                standaloneAttachmentCount: 2,
                standaloneNoteCount: 3,
            });
            expect(counts.get(11)).toEqual({
                itemCount: 7,
                standaloneAttachmentCount: 0,
                standaloneNoteCount: 1,
            });
        });

        it('omits collections with nothing in them, and countsFor defaults them to zero', async () => {
            serve({ items: [[10, 5]] });

            const counts = await getCollectionItemCounts([10, 99]);

            expect(counts.has(99)).toBe(false);
            expect(countsFor(counts, 99)).toEqual({
                itemCount: 0,
                standaloneAttachmentCount: 0,
                standaloneNoteCount: 0,
            });
            expect(countsFor(counts, 10).itemCount).toBe(5);
        });

        it('does not query at all for an empty collection list', async () => {
            const counts = await getCollectionItemCounts([]);
            expect(counts.size).toBe(0);
            expect(queryAsync).not.toHaveBeenCalled();
        });

        it('chunks large id lists so the bound-variable limit is not exceeded', async () => {
            serve({});
            const ids = Array.from({ length: 1201 }, (_, i) => i + 1);

            await getCollectionItemCounts(ids);

            // Three queries per chunk of 500 -> 3 chunks
            const chunkSizes = queryAsync.mock.calls
                .filter(([sql]) => queryKind(sql) === 'items')
                .map(([, params]) => params.length);
            expect(chunkSizes).toEqual([500, 500, 201]);
        });

        it('degrades to an empty map and logs when the queries fail', async () => {
            queryAsync.mockRejectedValue(new Error('database is locked'));

            const counts = await getCollectionItemCounts([10]);

            expect(counts.size).toBe(0);
            expect(logger).toHaveBeenCalledWith(
                expect.stringContaining('database is locked'),
                2,
            );
        });
    });

    describe('getSubcollectionCounts', () => {
        it('counts direct subcollections per parent', async () => {
            serve({ subcollections: [[10, 4], [11, 1]] });

            const counts = await getSubcollectionCounts([10, 11, 12]);

            expect(counts.get(10)).toBe(4);
            expect(counts.get(11)).toBe(1);
            // A collection with no subcollections is simply absent
            expect(counts.has(12)).toBe(false);
        });

        it('excludes trashed subcollections', async () => {
            serve({ subcollections: [] });
            await getSubcollectionCounts([10]);

            const [sql] = queryAsync.mock.calls[0];
            expect(sql).toContain('deletedCollections');
        });

        it('does not query at all for an empty collection list', async () => {
            const counts = await getSubcollectionCounts([]);
            expect(counts.size).toBe(0);
            expect(queryAsync).not.toHaveBeenCalled();
        });

        it('degrades to an empty map and logs when the query fails', async () => {
            queryAsync.mockRejectedValue(new Error('no such table'));

            const counts = await getSubcollectionCounts([10]);

            expect(counts.size).toBe(0);
            expect(logger).toHaveBeenCalledWith(expect.stringContaining('no such table'), 2);
        });
    });
});
