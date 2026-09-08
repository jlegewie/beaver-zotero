import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveItemsByFilters } from '../../../react/utils/searchTools';

interface Condition { c: string; op: string; val: string }

// Maps each search's conditions to returned item IDs.
let resolver: (conditions: Condition[]) => number[];
// Tags returned by Zotero.Tags.getAll.
let libraryTags: string[];

class MockSearch {
    // Set via the libraryID property.
    libraryID?: number;
    conditions: Condition[] = [];
    addCondition = vi.fn((c: string, op = '', val = '') => {
        this.conditions.push({ c, op, val });
    });
    search = vi.fn(async () => resolver(this.conditions));
}

const defaultResolver = (conds: Condition[]): number[] => {
    if (conds.some((c) => c.c === 'collection')) return [1, 2, 3];
    if (conds.some((c) => c.c === 'tag')) return [2, 3, 4];
    if (conds.some((c) => c.c === 'creator')) {
        const creator = conds.find((c) => c.c === 'creator');
        return creator?.val === 'Smith' ? [5] : [];
    }
    if (conds.some((c) => c.c === 'date' || c.c === 'year')) return [7, 8];
    return [];
};

beforeEach(() => {
    vi.clearAllMocks();
    resolver = defaultResolver;
    libraryTags = ['ml'];
    (globalThis as any).Zotero.Search = MockSearch;
    (globalThis as any).Zotero.Tags = {
        getAll: vi.fn(async () => libraryTags.map((tag) => ({ tag }))),
    };
});

describe('resolveItemsByFilters', () => {
    it('returns the collection item set when only collections are given', async () => {
        const result = await resolveItemsByFilters(1, { collectionKeys: ['K1'] });
        expect(result.itemIDs.sort()).toEqual([1, 2, 3]);
    });

    it('intersects (AND) across dimensions and reports matched tags', async () => {
        const result = await resolveItemsByFilters(1, {
            collectionKeys: ['K1'],
            tags: ['ml'],
        });
        expect(result.itemIDs.sort()).toEqual([2, 3]);
        expect(result.matchedTags).toEqual(['ml']);
    });

    it('treats a tag absent from the library as unproductive (empty AND term)', async () => {
        libraryTags = ['ml'];
        const result = await resolveItemsByFilters(1, { tags: ['ghost'] });
        expect(result.matchedTags).toEqual([]);
        expect(result.itemIDs).toEqual([]);
    });

    it('runs one search per author and reports which matched', async () => {
        const result = await resolveItemsByFilters(1, { authors: ['Smith', 'Nobody'] });
        expect(result.itemIDs).toEqual([5]);
        expect(result.matchedAuthors).toEqual(['Smith']);
    });

    it('builds inclusive year-range date conditions', async () => {
        const searches: MockSearch[] = [];
        const Orig = MockSearch;
        (globalThis as any).Zotero.Search = class extends Orig {
            constructor() {
                super();
                searches.push(this);
            }
        };

        const result = await resolveItemsByFilters(1, { year: { min: 2018, max: 2020 } });
        expect(result.itemIDs.sort()).toEqual([7, 8]);

        const allConds = searches.flatMap((s) => s.conditions);
        expect(allConds).toContainEqual({ c: 'date', op: 'isAfter', val: '2017-12-31' });
        expect(allConds).toContainEqual({ c: 'date', op: 'isBefore', val: '2021-01-01' });
    });

    it('uses an exact-year condition when year.exact is set', async () => {
        const searches: MockSearch[] = [];
        const Orig = MockSearch;
        (globalThis as any).Zotero.Search = class extends Orig {
            constructor() {
                super();
                searches.push(this);
            }
        };

        await resolveItemsByFilters(1, { year: { exact: 2021 } });
        const allConds = searches.flatMap((s) => s.conditions);
        expect(allConds).toContainEqual({ c: 'year', op: 'is', val: '2021' });
    });

    it('returns empty when no dimensions are provided', async () => {
        const result = await resolveItemsByFilters(1, {});
        expect(result.itemIDs).toEqual([]);
    });

    it('scopes via the libraryID property (never a condition) and ORs multi-value dimensions', async () => {
        // joinMode='any' applies to conditions, so library scope must stay on
        // the libraryID property.
        const searches: MockSearch[] = [];
        const Orig = MockSearch;
        (globalThis as any).Zotero.Search = class extends Orig {
            constructor() {
                super();
                searches.push(this);
            }
        };
        libraryTags = ['t1', 't2'];

        await resolveItemsByFilters(7, {
            collectionKeys: ['K1', 'K2'],
            tags: ['t1', 't2'],
        });

        expect(searches.length).toBeGreaterThan(0);
        for (const s of searches) {
            expect(s.libraryID).toBe(7);
            expect(s.conditions.some((c) => c.c === 'libraryID')).toBe(false);
        }
        const collSearch = searches.find((s) => s.conditions.some((c) => c.c === 'collection'));
        const tagSearch = searches.find((s) => s.conditions.some((c) => c.c === 'tag'));
        expect(collSearch?.conditions).toContainEqual({ c: 'joinMode', op: 'any', val: '' });
        expect(tagSearch?.conditions).toContainEqual({ c: 'joinMode', op: 'any', val: '' });
    });
});
