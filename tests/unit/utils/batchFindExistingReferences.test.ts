/**
 * Unit tests for `batchFindExistingReferences`.
 *
 * These tests exercise the real SQL (via better-sqlite3 in MockDBConnection)
 * against a seeded minimal Zotero schema. Tests cover:
 *   - exact-match title fast path
 *   - keyword LIKE fallback
 *   - DOI / ISBN identifier match
 *   - phase ordering (Phase 2 skips items already matched by Phase 1)
 *   - no-match fuzzy rejection (DOI conflict, year drift, creator mismatch)
 *   - deleted / wrong-type items skipped
 *   - empty inputs
 *   - chunking (> 500 items)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import { MockDBConnection } from '../../mocks/mockDBConnection';
import {
    createZoteroSchema,
    createSeedContext,
    installZoteroDB,
    seedZoteroItem,
} from '../../helpers/zoteroSchemaSeed';

import {
    batchFindExistingReferences,
    BatchReferenceCheckItem,
} from '../../../react/utils/batchFindExistingReferences';

let conn: MockDBConnection;
let ctx: ReturnType<typeof createSeedContext>;
let queryAsyncSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    conn = new MockDBConnection();
    await createZoteroSchema(conn);
    installZoteroDB(conn);

    // Wrap queryAsync to count / inspect calls per test.
    const original = (globalThis as any).Zotero.DB.queryAsync.bind((globalThis as any).Zotero.DB);
    queryAsyncSpy = vi.fn(original);
    (globalThis as any).Zotero.DB.queryAsync = queryAsyncSpy;

    ctx = createSeedContext();
});

afterEach(async () => {
    await conn.closeDatabase();
    vi.clearAllMocks();
});

// Count how many times queryAsync was invoked with SQL matching a substring.
function countSqlCalls(substring: string): number {
    return queryAsyncSpy.mock.calls.filter(call => {
        const sql = call[0] as string;
        return typeof sql === 'string' && sql.includes(substring);
    }).length;
}

function makeItem(id: string, data: Partial<BatchReferenceCheckItem['data']>): BatchReferenceCheckItem {
    return { id, data };
}

describe('batchFindExistingReferences — exact-match title fast path', () => {
    it('resolves input titles via BINARY value match against the UNIQUE index', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'The Origin of Species',
            creators: ['Darwin'],
            date: '1859',
        });
        await seedZoteroItem(conn, ctx, {
            title: 'Relativity: The Special and General Theory',
            creators: ['Einstein'],
            date: '1916',
        });

        const items = [
            makeItem('a', { title: 'The Origin of Species', creators: ['Darwin'] }),
            makeItem('b', { title: 'A Book Not In Library', creators: ['Nobody'] }),
        ];

        const { results, timing } = await batchFindExistingReferences(items, [1]);

        expect(results.find(r => r.id === 'a')?.item).not.toBeNull();
        expect(results.find(r => r.id === 'b')?.item).toBeNull();
        expect(timing.candidates_fetched).toBeGreaterThan(0);
        expect(timing.matches_by_fuzzy).toBe(1);
        expect(timing.matches_by_identifier).toBe(0);
    });

    it('still runs the LIKE scan when 2a finds a candidate — Phase 3 may reject 2a', async () => {
        // Regression: 2a used to populate a "resolved" set that suppressed 2b
        // for that normalized title, even when the 2a candidate was wrong.
        // See reviewer note: two DB items share a normalized title; the
        // byte-equal one is rejected by Phase 3, and the correct one
        // (differs only in case) would have been missed without 2b.
        await seedZoteroItem(conn, ctx, {
            title: 'Relativity',      // exact-match candidate for 2a
            creators: ['Wrong'],       // but Phase 3 rejects on creator
            date: '2020',
        });
        await seedZoteroItem(conn, ctx, {
            title: 'RelaTivity',       // 2a misses (BINARY), 2b finds via keyword
            creators: ['Einstein'],
            date: '2020',
        });

        const items = [makeItem('a', { title: 'Relativity', creators: ['Einstein'], date: '2020' })];
        const { results } = await batchFindExistingReferences(items, [1]);

        expect(results[0].item).not.toBeNull();
        expect(countSqlCalls('LOWER(title_val.value) LIKE')).toBeGreaterThan(0);
    });

    it('falls back to LIKE when the input title differs only in case', async () => {
        // Mixed-case DB title, lowercase input → BINARY exact miss.
        await seedZoteroItem(conn, ctx, {
            title: 'NeuroScience',
            creators: ['Kandel'],
        });

        const items = [makeItem('a', { title: 'neuroscience', creators: ['Kandel'] })];
        const { results } = await batchFindExistingReferences(items, [1]);

        expect(results[0].item).not.toBeNull();
        expect(countSqlCalls('LOWER(title_val.value) LIKE')).toBeGreaterThan(0);
    });
});

describe('batchFindExistingReferences — keyword LIKE fallback', () => {
    it('matches across diacritic variants', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Études sur la Psychologie',
            creators: ['Bernard'],
            date: '1899',
        });

        const items = [makeItem('a', { title: 'Etudes sur la Psychologie', creators: ['Bernard'], date: '1899' })];
        const { results } = await batchFindExistingReferences(items, [1]);

        expect(results[0].item).not.toBeNull();
    });
});

describe('batchFindExistingReferences — identifier match', () => {
    it('matches by DOI via COLLATE NOCASE', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Different Title Here',
            doi: '10.1234/FOO-BAR',
            creators: ['Smith'],
        });

        const items = [makeItem('a', { DOI: '10.1234/foo-bar' })];
        const { results, timing } = await batchFindExistingReferences(items, [1]);

        expect(results[0].item).not.toBeNull();
        expect(timing.matches_by_identifier).toBe(1);
        expect(timing.matches_by_fuzzy).toBe(0);
    });

    it('two input items sharing one DOI both resolve to the same reference', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Paper Title',
            doi: '10.9999/shared',
            creators: ['Sharer'],
        });

        const items = [
            makeItem('a', { DOI: '10.9999/shared' }),
            makeItem('b', { DOI: '10.9999/shared' }),
        ];
        const { results } = await batchFindExistingReferences(items, [1]);

        expect(results[0].item).not.toBeNull();
        expect(results[1].item).not.toBeNull();
        expect(results[0].item).toEqual(results[1].item);
    });

    it('matches by ISBN regardless of hyphen formatting', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'A Book',
            isbn: '978-0-13-468599-1',
            itemType: 'book',
            creators: ['Author'],
        });

        const items = [makeItem('a', { ISBN: '9780134685991' })];
        const { results, timing } = await batchFindExistingReferences(items, [1]);

        expect(results[0].item).not.toBeNull();
        expect(timing.matches_by_identifier).toBe(1);
    });
});

describe('batchFindExistingReferences — phase ordering', () => {
    it('skips Phase 2 for items already resolved by Phase 1', async () => {
        // Two items in the DB: both could match on title, but one also has a
        // DOI that will resolve it in Phase 1.
        await seedZoteroItem(conn, ctx, {
            title: 'Covered by DOI',
            doi: '10.5555/uniq1',
            creators: ['DoiAuthor'],
        });
        await seedZoteroItem(conn, ctx, {
            title: 'Covered by Title Only',
            creators: ['TitleAuthor'],
        });

        const items = [
            makeItem('a', { title: 'Covered by DOI', DOI: '10.5555/uniq1', creators: ['DoiAuthor'] }),
            makeItem('b', { title: 'Covered by Title Only', creators: ['TitleAuthor'] }),
        ];
        const { results, timing } = await batchFindExistingReferences(items, [1]);

        expect(results.find(r => r.id === 'a')?.item).not.toBeNull();
        expect(results.find(r => r.id === 'b')?.item).not.toBeNull();
        expect(timing.matches_by_identifier).toBe(1);
        expect(timing.matches_by_fuzzy).toBe(1);

        // Phase 2 should only have looked for one title, not two.
        // candidates_fetched captures how many candidate rows Phase 2 pulled.
        expect(timing.candidates_fetched).toBeLessThanOrEqual(1);
    });
});

describe('batchFindExistingReferences — no-match cases', () => {
    it('rejects a candidate when DOIs conflict', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Identical Title',
            doi: '10.1111/aaa',
            creators: ['Shared'],
        });

        const items = [makeItem('a', {
            title: 'Identical Title',
            DOI: '10.2222/bbb',  // different DOI → should NOT match
            creators: ['Shared'],
        })];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).toBeNull();
    });

    it('rejects when years differ by more than one', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Identical Title',
            date: '2000',
            creators: ['Smith'],
        });

        const items = [makeItem('a', {
            title: 'Identical Title',
            date: '2010',
            creators: ['Smith'],
        })];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).toBeNull();
    });

    it('rejects when creators do not overlap', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Identical Title',
            creators: ['Alice'],
        });

        const items = [makeItem('a', {
            title: 'Identical Title',
            creators: ['Bob'],
        })];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).toBeNull();
    });

    it('rejects when input has creators but candidate has none', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Identical Title',
        });

        const items = [makeItem('a', {
            title: 'Identical Title',
            creators: ['Someone'],
        })];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).toBeNull();
    });

    it('matches when both have no creators and titles agree', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Anonymous Work',
        });

        const items = [makeItem('a', { title: 'Anonymous Work' })];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).not.toBeNull();
    });
});

describe('batchFindExistingReferences — edge cases', () => {
    it('returns empty with zero timing when items is empty', async () => {
        const { results, timing } = await batchFindExistingReferences([], [1]);
        expect(results).toEqual([]);
        expect(timing.total_ms).toBe(0);
    });

    it('returns all null when libraryIds is empty', async () => {
        const items = [
            makeItem('a', { title: 'Anything', creators: ['X'] }),
            makeItem('b', { DOI: '10.1/nope' }),
        ];
        const { results } = await batchFindExistingReferences(items, []);
        expect(results.every(r => r.item === null)).toBe(true);
    });

    it('returns null for items with no title, no DOI, no ISBN', async () => {
        await seedZoteroItem(conn, ctx, { title: 'Something', creators: ['X'] });
        const items = [makeItem('a', {})];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).toBeNull();
    });
});

describe('batchFindExistingReferences — deleted / wrong-type items skipped', () => {
    it('ignores a candidate that is in deletedItems', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Deleted Book',
            creators: ['Del'],
            deleted: true,
        });
        const items = [makeItem('a', { title: 'Deleted Book', creators: ['Del'] })];
        const { results } = await batchFindExistingReferences(items, [1]);
        expect(results[0].item).toBeNull();
    });

    it('ignores notes, attachments, annotations', async () => {
        await seedZoteroItem(conn, ctx, {
            title: 'Note Title',
            itemType: 'note',
            creators: ['N'],
        });
        await seedZoteroItem(conn, ctx, {
            title: 'Attachment Title',
            itemType: 'attachment',
            creators: ['A'],
        });
        await seedZoteroItem(conn, ctx, {
            title: 'Annotation Title',
            itemType: 'annotation',
            creators: ['Ann'],
        });

        const items = [
            makeItem('a', { title: 'Note Title', creators: ['N'] }),
            makeItem('b', { title: 'Attachment Title', creators: ['A'] }),
            makeItem('c', { title: 'Annotation Title', creators: ['Ann'] }),
        ];
        const { results } = await batchFindExistingReferences(items, [1]);
        for (const r of results) expect(r.item).toBeNull();
    });
});

describe('batchFindExistingReferences — chunking', () => {
    it('handles more than 500 items without exceeding the SQL variable limit', async () => {
        // Seed 600 items with distinct titles and matching creators.
        const N = 600;
        for (let i = 0; i < N; i++) {
            await seedZoteroItem(conn, ctx, {
                title: `ChunkTitle${i}`,
                creators: [`Author${i}`],
            });
        }

        // Build 600 inputs matching each seeded item exactly.
        const items: BatchReferenceCheckItem[] = [];
        for (let i = 0; i < N; i++) {
            items.push(makeItem(`id${i}`, { title: `ChunkTitle${i}`, creators: [`Author${i}`] }));
        }

        const { results, timing } = await batchFindExistingReferences(items, [1]);
        const matched = results.filter(r => r.item !== null).length;
        expect(matched).toBe(N);
        expect(timing.matches_by_fuzzy).toBe(N);
    });
});
