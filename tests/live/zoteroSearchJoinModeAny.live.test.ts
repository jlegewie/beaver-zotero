/**
 * Live coverage for `item_category` under `join_mode="any"` in zotero_search
 * (`/beaver/library/search`).
 *
 * Zotero ORs together every non-special condition when joinMode is 'any', so
 * expressing `item_category` as itemType conditions turned it into an
 * always-true disjunct ("isNot attachment OR isNot note" holds for every item)
 * and an `any` search silently matched the entire library. The category is now
 * applied as a post-filter on the matched itemIDs instead.
 *
 * The assertions below are data-independent invariants, so they hold against
 * any library:
 *   - with a SINGLE condition, `any` and `all` must produce identical results;
 *   - an `any` search can never return more than the whole category;
 *   - results never carry a result_type outside the requested category.
 *
 * Prerequisites:
 *   - Dev build running against Zotero (npm start) with the library management
 *     endpoints registered.
 *   - Authenticated, with a synced user library (library_id 1).
 *
 * Run: npm run test:live -- zoteroSearchJoinModeAny
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

const USER_LIBRARY_ID = 1;

/** Matches a broad but bounded slice of any real library. */
const COMMON_TERM = 'a';
/** Same, for note bodies — notes are matched on content, not title. */
const COMMON_NOTE_TERM = 'the';
/** Matches nothing — the single-condition proof from the bug report. */
const NONSENSE_TERM = 'zzzz-no-such-term-zzzz';

let available = false;

beforeAll(async () => {
    available = await isZoteroAvailable();
});

interface SearchResultItem {
    item_id?: string;
    attachment_id?: string;
    result_type?: string;
}

interface SearchResponse {
    items: SearchResultItem[];
    total_count: number;
    warnings?: string[];
    error?: string | null;
    error_code?: string | null;
}

async function search(options: {
    conditions: Array<Record<string, unknown>>;
    join_mode: 'all' | 'any';
    item_category: string;
    include_children?: boolean;
    limit?: number;
}): Promise<SearchResponse> {
    return post<SearchResponse>(
        '/beaver/library/search',
        {
            library_id: USER_LIBRARY_ID,
            conditions: options.conditions,
            join_mode: options.join_mode,
            item_category: options.item_category,
            include_children: options.include_children ?? true,
            limit: options.limit ?? 50,
        },
        { timeout: 30000 },
    );
}

const titleContains = (value: string) => ({ field: 'title', operator: 'contains', value });
const noteContains = (value: string) => ({ field: 'note', operator: 'contains', value });

/**
 * A condition per category that actually matches rows in that category.
 * Notes carry no `title` field, so a title condition would match zero notes and
 * every assertion over the result rows would pass vacuously.
 * `resultType` is null where the response mixes shapes (`all`).
 */
const MATCHING_CASES: Array<{ item_category: string; condition: Record<string, unknown>; resultType: string | null }> = [
    { item_category: 'regular', condition: titleContains(COMMON_TERM), resultType: 'regular' },
    { item_category: 'note', condition: noteContains(COMMON_NOTE_TERM), resultType: 'note' },
    { item_category: 'attachment', condition: titleContains(COMMON_TERM), resultType: 'attachment' },
    { item_category: 'all', condition: titleContains(COMMON_TERM), resultType: null },
];

/** Stable identity across the regular/note (item_id) and attachment shapes. */
const idsOf = (res: SearchResponse) =>
    res.items.map(item => item.item_id ?? item.attachment_id ?? '');

describe('zotero_search item_category under join_mode="any"', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    describe('a single condition makes join_mode irrelevant', () => {
        for (const { item_category, condition } of MATCHING_CASES) {
            it(`any === all for item_category="${item_category}"`, async () => {
                const conditions = [condition];
                const anyMode = await search({ conditions, join_mode: 'any', item_category });
                const allMode = await search({ conditions, join_mode: 'all', item_category });

                expect(anyMode.error).toBeFalsy();
                expect(allMode.error).toBeFalsy();
                // Guard against a vacuous pass: both sides must actually match.
                expect(anyMode.total_count).toBeGreaterThan(0);
                expect(anyMode.total_count).toBe(allMode.total_count);
                expect(idsOf(anyMode)).toEqual(idsOf(allMode));
            }, 30000);
        }
    });

    it('returns nothing when the only condition matches nothing', async () => {
        // The production symptom: this used to return the whole library.
        const res = await search({
            conditions: [titleContains(NONSENSE_TERM)],
            join_mode: 'any',
            item_category: 'regular',
        });

        expect(res.error).toBeFalsy();
        expect(res.total_count).toBe(0);
        expect(res.items).toEqual([]);
    }, 30000);

    it('never exceeds the size of the requested category', async () => {
        const wholeCategory = await search({
            conditions: [],
            join_mode: 'all',
            item_category: 'regular',
            limit: 1,
        });
        const anyMode = await search({
            conditions: [titleContains(COMMON_TERM), titleContains(NONSENSE_TERM)],
            join_mode: 'any',
            item_category: 'regular',
            limit: 1,
        });

        expect(anyMode.error).toBeFalsy();
        expect(anyMode.total_count).toBeLessThanOrEqual(wholeCategory.total_count);
    }, 30000);

    // The production trigger: a long OR-list of conditions plus a category.
    describe('an OR-list stays inside the requested category', () => {
        for (const { item_category, condition, resultType } of MATCHING_CASES) {
            if (!resultType) continue;
            it(`item_category="${item_category}" yields only ${resultType} rows`, async () => {
                // One matching branch OR one that matches nothing — the union is
                // exactly the matching branch, so 'all' over that branch alone is
                // the expected answer.
                const conditions = [condition, titleContains(NONSENSE_TERM)];
                const res = await search({ conditions, join_mode: 'any', item_category });
                const expected = await search({ conditions: [condition], join_mode: 'all', item_category });

                expect(res.error).toBeFalsy();
                // Guard against a vacuous pass: an empty page proves nothing
                // about which rows survive the category filter.
                expect(res.items.length).toBeGreaterThan(0);
                expect(res.items.map(item => item.result_type)).toEqual(
                    res.items.map(() => resultType),
                );
                // Catches a category leak that inflates the count without
                // changing row types (e.g. "itemType is note" ORing in every note).
                expect(res.total_count).toBe(expected.total_count);
            }, 30000);
        }
    });

    it('still ORs the caller conditions together', async () => {
        const left = titleContains(COMMON_TERM);
        const right = titleContains('e');

        const leftOnly = await search({ conditions: [left], join_mode: 'any', item_category: 'regular', limit: 1 });
        const rightOnly = await search({ conditions: [right], join_mode: 'any', item_category: 'regular', limit: 1 });
        const union = await search({ conditions: [left, right], join_mode: 'any', item_category: 'regular', limit: 1 });
        const intersection = await search({ conditions: [left, right], join_mode: 'all', item_category: 'regular', limit: 1 });

        expect(union.error).toBeFalsy();
        // A union is at least either branch and at most their sum...
        expect(union.total_count).toBeGreaterThanOrEqual(Math.max(leftOnly.total_count, rightOnly.total_count));
        expect(union.total_count).toBeLessThanOrEqual(leftOnly.total_count + rightOnly.total_count);
        // ...and never smaller than the corresponding intersection.
        expect(union.total_count).toBeGreaterThanOrEqual(intersection.total_count);
    }, 30000);

    it('drops annotations for item_category="all"', async () => {
        const res = await search({
            conditions: [titleContains(COMMON_TERM)],
            join_mode: 'any',
            item_category: 'all',
        });

        expect(res.error).toBeFalsy();
        expect(res.items.some(item => item.result_type === 'annotation')).toBe(false);
    }, 30000);
});
