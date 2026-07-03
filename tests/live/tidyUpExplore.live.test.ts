/**
 * Live coverage for the `tidy-up` built-in action's Step 1 "Explore" tool
 * recipes (react/types/builtinActions.ts, id `builtin-tidy-up`).
 *
 * The action prompt hard-codes concrete tool calls the agent is told to run to
 * find "messes" — unfiled items, untagged items, items missing an abstract, and
 * recent additions — and promises the user *exact counts* from each. Those
 * recipes are plain strings with no typecheck, so a rename of a search field,
 * operator, or list param would silently rot the prompt: the agent would issue
 * a call that the search handler drops as invalid, quietly relaxing the query
 * and returning a wrong count with no error. This suite is the tripwire.
 *
 * It does two things:
 *   1. Binds prompt <-> test: asserts the exact recipe substrings still live in
 *      the `builtin-tidy-up` text, so editing a recipe forces updating this test.
 *   2. Executes each recipe against live Zotero and asserts it is genuinely
 *      applied — no dropped-condition `warnings`, a numeric `total_count`, and
 *      (for the recent-items list) that the dateAdded/desc sort is honored.
 *
 * Prerequisites:
 *   - Dev build running against Zotero (npm start) with the library management
 *     endpoints registered.
 *   - Authenticated, with a synced user library (library_id 1).
 *
 * Run: npm run test:live -- tidyUpExplore
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_ACTIONS } from '../../react/types/builtinActions';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

const USER_LIBRARY_ID = 1;

let available = false;

beforeAll(async () => {
    available = await isZoteroAvailable();
});

interface SearchResponse {
    items: Array<{ item_id?: string }>;
    total_count: number;
    warnings?: string[];
    error?: string | null;
    error_code?: string | null;
}

interface ListItem {
    item_id?: string;
    date_added?: string;
}

interface ListResponse {
    items: ListItem[];
    total_count: number;
    error?: string | null;
    error_code?: string | null;
}

interface CollectionsResponse {
    collections: Array<{ collection_key?: string }>;
    total_count: number;
    error?: string | null;
}

interface TagsResponse {
    tags: Array<{ tag?: string }>;
    total_count: number;
    error?: string | null;
}

// The exact recipe substrings embedded in the tidy-up prompt. Kept in sync with
// the conditions executed below — if the prompt changes a field/operator, the
// substring assertion fails here AND the execution below changes, forcing both
// to move together.
const UNFILED_RECIPE = "{'field': 'unfiled', 'operator': 'true'}";
const UNTAGGED_RECIPE = "{'field': 'tag', 'operator': 'doesNotContain', 'value': ''}";
const NO_ABSTRACT_RECIPE = "{'field': 'abstractNote', 'operator': 'doesNotContain', 'value': ''}";
const NO_DOI_RECIPE = "{'field': 'DOI', 'operator': 'doesNotContain', 'value': ''}";
const RECENT_ITEMS_RECIPE = "'sort_by': 'dateAdded', 'sort_order': 'desc', 'limit': 20, 'item_category': 'regular'";

function tidyUpText(): string {
    const action = BUILTIN_ACTIONS.find(a => a.id === 'builtin-tidy-up');
    if (!action) throw new Error('builtin-tidy-up action not found');
    return action.text;
}

async function search(conditions: Array<Record<string, unknown>>): Promise<SearchResponse> {
    return post<SearchResponse>(
        '/beaver/library/search',
        { library_id: USER_LIBRARY_ID, item_category: 'regular', conditions, limit: 20 },
        { timeout: 30000 },
    );
}

/** A condition that was accepted (not dropped) yields no warnings, no error,
 * and a numeric total_count. This is the core drift assertion. */
function expectAppliedCondition(res: SearchResponse): void {
    expect(res.error).toBeFalsy();
    expect(res.warnings ?? []).toEqual([]);
    expect(typeof res.total_count).toBe('number');
    expect(res.total_count).toBeGreaterThanOrEqual(0);
}

describe('tidy-up explore recipes', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    describe('prompt keeps the exact recipes this test verifies', () => {
        it('embeds the unfiled, untagged, no-abstract and recent-items recipes', () => {
            const text = tidyUpText();
            expect(text).toContain(UNFILED_RECIPE);
            expect(text).toContain(UNTAGGED_RECIPE);
            expect(text).toContain(NO_ABSTRACT_RECIPE);
            expect(text).toContain(NO_DOI_RECIPE);
            expect(text).toContain(RECENT_ITEMS_RECIPE);
        });
    });

    describe('search recipes are applied, not silently dropped', () => {
        it('unfiled condition is valid and returns a real count', async () => {
            const res = await search([{ field: 'unfiled', operator: 'true' }]);
            expectAppliedCondition(res);
            // Unfiled is a strict subset of all regular items.
            const all = await search([]);
            expect(res.total_count).toBeLessThanOrEqual(all.total_count);
        }, 30000);

        it('untagged condition is valid and returns a real count', async () => {
            const res = await search([{ field: 'tag', operator: 'doesNotContain', value: '' }]);
            expectAppliedCondition(res);
        }, 30000);

        it('missing-abstract condition is valid and returns a real count', async () => {
            const res = await search([{ field: 'abstractNote', operator: 'doesNotContain', value: '' }]);
            expectAppliedCondition(res);
            const all = await search([]);
            expect(res.total_count).toBeLessThanOrEqual(all.total_count);
        }, 30000);

        it('missing-DOI condition is valid and returns a real count', async () => {
            const res = await search([{ field: 'DOI', operator: 'doesNotContain', value: '' }]);
            expectAppliedCondition(res);
            const all = await search([]);
            expect(res.total_count).toBeLessThanOrEqual(all.total_count);
        }, 30000);

        it('join_mode=any with a category filter is NOT used (it inflates the count past the whole library)', async () => {
            // Documents why the prompt forbids join_mode:'any' here: the
            // item_category filter injects `itemType isNot ...` conditions that
            // share the single global join mode, so under 'any' they are OR'd in
            // and the count exceeds the regular-item universe — a meaningless
            // number the prompt must never report.
            const regularOnly = await search([]);
            const inflated = await post<SearchResponse>(
                '/beaver/library/search',
                {
                    library_id: USER_LIBRARY_ID,
                    item_category: 'regular',
                    join_mode: 'any',
                    conditions: [
                        { field: 'DOI', operator: 'doesNotContain', value: '' },
                        { field: 'abstractNote', operator: 'doesNotContain', value: '' },
                    ],
                    limit: 1,
                },
                { timeout: 30000 },
            );
            expect(inflated.total_count).toBeGreaterThan(regularOnly.total_count);
        }, 30000);
    });

    describe('recent-items list recipe honors the dateAdded/desc sort', () => {
        it('list_items returns a real count in non-increasing dateAdded order', async () => {
            const res = await post<ListResponse>(
                '/beaver/library/list',
                {
                    library_id: USER_LIBRARY_ID,
                    sort_by: 'dateAdded',
                    sort_order: 'desc',
                    limit: 20,
                    item_category: 'regular',
                },
                { timeout: 30000 },
            );
            expect(res.error).toBeFalsy();
            expect(typeof res.total_count).toBe('number');

            const dates = res.items
                .map(i => i.date_added)
                .filter((d): d is string => typeof d === 'string' && d.length > 0);
            // Ordering only asserts when the sort had something to order.
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1] >= dates[i]).toBe(true);
            }
        }, 30000);
    });

    describe('structure recipes (list_collections / list_tags) respond', () => {
        it('list_collections returns an array and a count', async () => {
            const res = await post<CollectionsResponse>(
                '/beaver/library/collections',
                { library_id: USER_LIBRARY_ID, include_item_counts: true },
                { timeout: 30000 },
            );
            expect(res.error).toBeFalsy();
            expect(Array.isArray(res.collections)).toBe(true);
            expect(typeof res.total_count).toBe('number');
        }, 30000);

        it('list_tags returns an array and a count', async () => {
            const res = await post<TagsResponse>(
                '/beaver/library/tags',
                { library_id: USER_LIBRARY_ID },
                { timeout: 30000 },
            );
            expect(res.error).toBeFalsy();
            expect(Array.isArray(res.tags)).toBe(true);
            expect(typeof res.total_count).toBe('number');
        }, 30000);
    });
});
