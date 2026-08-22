import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    validateLibraryAccess: vi.fn(),
    resolveStoredTagName: vi.fn(),
}));

import type { WSResolvePopulationRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { handleResolvePopulationRequest } from '../../../src/services/agentDataProvider/handleResolvePopulationRequest';
import { resolveStoredTagName, validateLibraryAccess } from '../../../src/services/agentDataProvider/utils';

/** One row of the fake `items` table the handler reads key/dateAdded from. */
interface ItemRow {
    itemID: number;
    key: string;
    libraryID: number;
    dateAdded: string;
}

type MockSearchInstance = {
    libraryID: number;
    addCondition: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    setScope: ReturnType<typeof vi.fn>;
    /** The search this one was scoped to, if any. */
    scope: MockSearchInstance | null;
};

const LIBRARY_ID = 1;

/** Predicate for `groupResults`: matches the OR-group carrying a condition on `field`. */
const hasCondition = (field: string) => (conditions: string[][]) =>
    conditions.some(([name]) => name === field);

describe('handleResolvePopulationRequest', () => {
    /** Fake `items` table, keyed by itemID. */
    const itemRows = new Map<number, ItemRow>();
    /** Fake `itemAttachments`: parent itemID -> non-trashed attachment itemIDs. */
    const attachmentsByParent = new Map<number, number[]>();
    /** What the native search resolves to. */
    let searchResultIds: number[] = [];
    /**
     * What a SCOPE search resolves to, when the handler runs one itself. Null
     * means "same as the main search", which is what every test that does not
     * care about the second OR-group wants.
     */
    let scopeSearchResultIds: number[] | null = null;
    /**
     * Results for individual OR-group searches, for the requests that build
     * more than one. Each entry pairs a predicate over the conditions a group
     * carries with the ids that group resolves to; the first match wins, and a
     * group no entry matches falls back to `scopeSearchResultIds`.
     */
    let groupResults: [(conditions: string[][]) => boolean, number[]][] = [];
    /** Tags that exist in the library; an unknown tag is reported, not silently empty. */
    let libraryTags: string[] = [];
    /** Every Zotero.Search the handler constructed, in construction order. */
    let searches: MockSearchInstance[] = [];
    /** Collections the handler can resolve, keyed by "<libraryID>/<key>". */
    const collections = new Map<string, { id: number; name: string }>();

    const mainSearch = () => searches[0] ?? null;

    /** Conditions handed to the primary search, as [field, operator, value]. */
    const addedConditions = () =>
        (mainSearch()?.addCondition.mock.calls ?? []).map(call => call.slice(0, 3));

    /** Conditions on one search, as [field, operator, value]. */
    const conditionsOn = (search: MockSearchInstance | null) =>
        (search?.addCondition.mock.calls ?? []).map(call => call.slice(0, 3));

    /**
     * The OR-group scope searches the main search was given, outermost first.
     * The handler chains them, so this walks the chain rather than assuming a
     * construction order.
     */
    const scopeChain = (): MockSearchInstance[] => {
        const chain: MockSearchInstance[] = [];
        let current = mainSearch()?.scope ?? null;
        while (current) {
            chain.push(current);
            current = current.scope;
        }
        return chain;
    };

    /**
     * Every OR-group search the handler built. Not the same as `scopeChain()`:
     * only one group is ever attached as a scope, and the other is run on its
     * own and intersected.
     */
    const orGroupSearches = () => searches.slice(1);

    /** The OR-group search over `field`, if one exists. */
    const scopeFor = (field: 'collection' | 'tag') =>
        orGroupSearches().find(search =>
            conditionsOn(search).some(([name]) => name === field)) ?? null;

    /** The OR-group search carrying a condition on `field`, if one exists. */
    const groupWith = (field: string) =>
        orGroupSearches().find(search =>
            conditionsOn(search).some(([name]) => name === field)) ?? null;

    /** The values of the `field is <value>` disjuncts in that group. */
    const orGroupValues = (field: 'collection' | 'tag') =>
        conditionsOn(scopeFor(field))
            .filter(([name, operator]) => name === field && operator === 'is')
            .map(([, , value]) => value);

    /** All Zotero.DB.queryAsync calls as [sql, params] pairs. */
    const dbCalls = (): [string, any[]][] =>
        (globalThis as any).Zotero.DB.queryAsync.mock.calls.map((call: any[]) => [call[0], call[1]]);

    const callsMatching = (pattern: RegExp) => dbCalls().filter(([sql]) => pattern.test(sql));

    /** Seed an item row plus, optionally, the attachments hanging off it. */
    function seedItem(itemID: number, options: { key?: string; libraryID?: number; dateAdded?: string; attachments?: number[] } = {}) {
        itemRows.set(itemID, {
            itemID,
            key: options.key ?? `KEY${itemID}`,
            libraryID: options.libraryID ?? LIBRARY_ID,
            dateAdded: options.dateAdded ?? `2024-01-01 00:00:${String(itemID).padStart(2, '0')}`,
        });
        if (options.attachments) {
            attachmentsByParent.set(itemID, options.attachments);
            for (const attachmentID of options.attachments) {
                itemRows.set(attachmentID, {
                    itemID: attachmentID,
                    key: `ATT${attachmentID}`,
                    libraryID: LIBRARY_ID,
                    dateAdded: `2024-02-01 00:00:${String(attachmentID % 100).padStart(2, '0')}`,
                });
            }
        }
    }

    function makeRequest(overrides: Partial<WSResolvePopulationRequest> = {}): WSResolvePopulationRequest {
        return {
            event: 'resolve_population_request',
            request_id: 'req-1',
            recursive: true,
            unfiled: false,
            untagged: false,
            conditions: [],
            item_category: 'regular',
            max_items: 1000,
            ...overrides,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        itemRows.clear();
        attachmentsByParent.clear();
        collections.clear();
        searchResultIds = [];
        scopeSearchResultIds = null;
        groupResults = [];
        searches = [];
        libraryTags = ['to-read', 'reviewed'];

        vi.mocked(validateLibraryAccess).mockReturnValue({
            valid: true,
            library: { libraryID: LIBRARY_ID, name: 'My Library' },
        } as any);

        vi.mocked(resolveStoredTagName).mockImplementation(async (_libraryID, libraryName, tag) => {
            const stored = libraryTags.find((t) => t.toLowerCase() === tag.toLowerCase());
            return stored
                ? { found: true, name: stored }
                : { found: false, error: `Tag not found: "${tag}" in library "${libraryName}"` };
        });

        // modelObjectId() derives the portable "u-" prefix from this.
        (globalThis as any).Zotero.Libraries.userLibraryID = LIBRARY_ID;

        (globalThis as any).Zotero.Search = class MockSearch {
            libraryID = 0;
            addCondition = vi.fn();
            // searches[0] is the main search; anything later is a scope
            // search the handler built and may run on its own.
            search = vi.fn(async () => {
                if ((searches[0] as unknown) === this) return searchResultIds;
                const conditions = this.addCondition.mock.calls.map((call: any[]) => call.slice(0, 3));
                const override = groupResults.find(([matches]) => matches(conditions));
                if (override) return override[1];
                return scopeSearchResultIds === null ? searchResultIds : scopeSearchResultIds;
            });
            scope: MockSearchInstance | null = null;
            setScope = vi.fn((scope: MockSearchInstance) => {
                this.scope = scope;
            });
            constructor() {
                searches.push(this as unknown as MockSearchInstance);
            }
        };

        (globalThis as any).Zotero.Collections = {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) =>
                collections.get(`${libraryID}/${key}`) ?? false),
        };

        (globalThis as any).Zotero.Tags = {
            getAll: vi.fn(async () => libraryTags.map(tag => ({ tag }))),
        };

        // Spies only — the resolve path must never touch either of these.
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async () => null),
            loadDataTypes: vi.fn(async () => undefined),
        };

        // Stands in for the three SQL statements the handler issues: the
        // has_attachments predicate, the attachment-population derivation, and
        // the id/order read. Each is answered from the fixtures above.
        (globalThis as any).Zotero.DB = {
            queryAsync: vi.fn(async (sql: string, params: any[], options: { onRow: (row: any) => void }) => {
                const emit = (values: any[]) =>
                    options.onRow({ getResultByIndex: (index: number) => values[index] });

                if (/SELECT DISTINCT ia\.parentItemID/.test(sql)) {
                    for (const parentID of params) {
                        if ((attachmentsByParent.get(parentID) ?? []).length > 0) emit([parentID]);
                    }
                    return;
                }
                if (/SELECT ia\.itemID FROM itemAttachments/.test(sql)) {
                    for (const parentID of params) {
                        for (const attachmentID of attachmentsByParent.get(parentID) ?? []) {
                            emit([attachmentID]);
                        }
                    }
                    return;
                }
                if (/FROM items WHERE itemID IN/.test(sql)) {
                    // Mirror the statement's own ORDER BY: sorted within the
                    // chunk only, so a cross-chunk order bug stays visible.
                    const rows = (params as number[])
                        .map(id => itemRows.get(id))
                        .filter((row): row is ItemRow => Boolean(row))
                        .sort((a, b) => a.dateAdded < b.dateAdded ? -1
                            : a.dateAdded > b.dateAdded ? 1
                                : a.itemID - b.itemID);
                    for (const row of rows) emit([row.itemID, row.key, row.libraryID, row.dateAdded]);
                    return;
                }
                throw new Error(`Unexpected SQL: ${sql}`);
            }),
        };
    });

    describe('native predicates', () => {
        it('resolves unfiled through the native unfiled condition', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({ unfiled: true }));

            expect(response.error).toBeUndefined();
            expect(addedConditions()).toContainEqual(['unfiled', 'true', '']);
        });

        it("resolves untagged through tag doesNotContain ''", async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({ untagged: true }));

            expect(response.error).toBeUndefined();
            expect(addedConditions()).toContainEqual(['tag', 'doesNotContain', '']);
        });

        it('scopes the population to a tag and to a recursive collection', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            await handleResolvePopulationRequest(makeRequest({
                tags: ['to-read'],
                collection_keys: ['ABCD2345'],
                recursive: true,
            }));

            expect(orGroupValues('tag')).toEqual(['to-read']);
            expect(orGroupValues('collection')).toEqual(['ABCD2345']);
            expect(conditionsOn(scopeFor('collection'))).toContainEqual(['recursive', 'true', '']);
        });

        it('searches the casing the library stores, not the one the caller sent', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({ tags: ['TO-READ'] }));

            expect(response.error).toBeUndefined();
            expect(orGroupValues('tag')).toEqual(['to-read']);
        });

        it('omits the recursive condition when recursive is false', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345'],
                recursive: false,
            }));

            expect(orGroupValues('collection')).toEqual(['ABCD2345']);
            expect(conditionsOn(scopeFor('collection')).some(([field]) => field === 'recursive')).toBe(false);
            expect(addedConditions().some(([field]) => field === 'recursive')).toBe(false);
        });

        it('recurses a collection condition given through the condition grammar', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                conditions: [{ field: 'collection', operator: 'is', value: 'ABCD2345' }],
                recursive: true,
            }));

            // Without this the condition form would match direct membership
            // only while `collection_keys` recursed.
            expect(addedConditions()).toContainEqual(['recursive', 'true', '']);
        });

        it('never sets a join mode on the main search, so every filter group stays ANDed', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                unfiled: true,
                untagged: true,
                tags: ['to-read'],
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(addedConditions().some(([field]) => field === 'joinMode')).toBe(false);
        });
    });

    describe('OR-groups', () => {
        it('ORs several collections in a scope search rather than ANDing them', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });
            collections.set(`${LIBRARY_ID}/EFGH6789`, { id: 78, name: 'Theory' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345', 'EFGH6789'],
            }));

            expect(response.error).toBeUndefined();
            // ANDed collection conditions select their intersection, which for
            // two collections is almost always nothing.
            expect(addedConditions().some(([field]) => field === 'collection')).toBe(false);
            expect(orGroupValues('collection')).toEqual(['ABCD2345', 'EFGH6789']);
            expect(conditionsOn(scopeFor('collection'))).toContainEqual(['joinMode', 'any', '']);
        });

        it('ORs several tags in a scope search rather than ANDing them', async () => {
            searchResultIds = [1];
            seedItem(1);
            libraryTags = ['ml', 'machine-learning'];

            const response = await handleResolvePopulationRequest(makeRequest({
                tags: ['ml', 'machine-learning'],
            }));

            expect(response.error).toBeUndefined();
            expect(orGroupValues('tag')).toEqual(['ml', 'machine-learning']);
            expect(conditionsOn(scopeFor('tag'))).toContainEqual(['joinMode', 'any', '']);
        });

        it('never nests one group inside the other', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });
            collections.set(`${LIBRARY_ID}/EFGH6789`, { id: 78, name: 'Theory' });

            await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345', 'EFGH6789'],
                tags: ['to-read', 'reviewed'],
            }));

            // Zotero 7 materializes an outer scope from getSQL(), which ignores
            // that scope's own scope — a nested group is silently dropped, and
            // a dropped group widens the population to everything the outer one
            // matched. Only Zotero 10 runs a nested scope properly, so nesting
            // would make the population depend on the Zotero version.
            expect(scopeChain()).toHaveLength(1);
        });

        it('intersects the group that did not become the scope', async () => {
            searchResultIds = [1, 2, 3];
            scopeSearchResultIds = [2, 3, 4];
            seedItem(1);
            seedItem(2);
            seedItem(3);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });
            collections.set(`${LIBRARY_ID}/EFGH6789`, { id: 78, name: 'Theory' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345', 'EFGH6789'],
                tags: ['to-read', 'reviewed'],
            }));

            const tagScope = scopeFor('tag');
            expect(orGroupValues('collection')).toEqual(['ABCD2345', 'EFGH6789']);
            expect(orGroupValues('tag')).toEqual(['to-read', 'reviewed']);
            // The tag group is the one run separately, and its ids narrow the
            // scoped result rather than replacing it.
            expect(tagScope?.search).toHaveBeenCalled();
            expect(response.total_count).toBe(2);
            expect(response.item_ids).toEqual(['u-KEY2', 'u-KEY3']);
        });

        it('keeps a lone tag group as the scope, with nothing to intersect', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({ tags: ['to-read'] }));

            expect(scopeChain()).toHaveLength(1);
            expect(orGroupValues('tag')).toEqual(['to-read']);
            expect(scopeFor('tag')?.search).not.toHaveBeenCalled();
        });

        it('attaches no scope at all when neither group is given', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({ unfiled: true }));

            // An empty scope search matches the whole library, so attaching one
            // would widen the population instead of narrowing it.
            expect(mainSearch()?.setScope).not.toHaveBeenCalled();
        });

        it('scopes every group to the library the population resolves in', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345'],
                tags: ['to-read'],
            }));

            expect(orGroupSearches()).toHaveLength(2);
            for (const scope of orGroupSearches()) {
                expect(scope.libraryID).toBe(LIBRARY_ID);
            }
        });
    });

    describe('conditions join mode', () => {
        it('puts the conditions in their own OR-group under any, not on the main search', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                conditions: [
                    { field: 'DOI', operator: 'is', value: '' },
                    { field: 'publicationTitle', operator: 'is', value: '' },
                ],
            }));

            expect(response.error).toBeUndefined();
            const group = groupWith('DOI');
            expect(conditionsOn(group)).toContainEqual(['joinMode', 'any', '']);
            expect(conditionsOn(group)).toContainEqual(['DOI', 'doesNotContain', '']);
            expect(conditionsOn(group)).toContainEqual(['publicationTitle', 'doesNotContain', '']);
            // ANDed on the main search, these two would select only items
            // missing BOTH fields.
            expect(addedConditions().some(([field]) => field === 'DOI')).toBe(false);
            expect(addedConditions().some(([field]) => field === 'publicationTitle')).toBe(false);
        });

        it('never sets a join mode on the main search under any', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                tags: ['to-read'],
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            // 'any' on the main search would turn its itemType guards into
            // always-true disjuncts and select the whole library.
            expect(addedConditions().some(([field]) => field === 'joinMode')).toBe(false);
        });

        it('narrows the population to the conditions group, in both directions', async () => {
            // The tag group takes the scope slot, so the conditions group is
            // the one run on its own and intersected.
            searchResultIds = [1, 2, 3];
            groupResults = [[hasCondition('DOI'), [2, 3, 4]]];
            seedItem(1);
            seedItem(2);
            seedItem(3);

            const response = await handleResolvePopulationRequest(makeRequest({
                tags: ['to-read'],
                conditions_join_mode: 'any',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(scopeChain()).toHaveLength(1);
            expect(groupWith('DOI')?.search).toHaveBeenCalled();
            // 1 matched the main search but not the group; 4 the group but not
            // the main search. Neither belongs to the population.
            expect(response.item_ids).toEqual(['u-KEY2', 'u-KEY3']);
            expect(response.total_count).toBe(2);
        });

        it('keeps untagged on the main search under any, where it stays ANDed', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                untagged: true,
                conditions_join_mode: 'any',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            // untagged is a real primary condition, so as a disjunct it would
            // add every untagged item to the population.
            expect(addedConditions()).toContainEqual(['tag', 'doesNotContain', '']);
            expect(conditionsOn(groupWith('DOI')).some(([field]) => field === 'tag')).toBe(false);
        });

        it('keeps the item-type guards on the main search under any', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'attachment']);
            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'note']);
            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'annotation']);
            expect(addedConditions()).toContainEqual(['noChildren', 'true', '']);
            const groupFields = conditionsOn(groupWith('DOI')).map(([field]) => field);
            expect(groupFields).not.toContain('itemType');
            expect(groupFields).not.toContain('noChildren');
        });

        it('recurses a collection condition inside the conditions group', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                recursive: true,
                conditions: [
                    { field: 'collection', operator: 'is', value: 'ABCD2345' },
                    { field: 'DOI', operator: 'is', value: '' },
                ],
            }));

            // Without this the condition form would match direct membership
            // only while collection_keys recursed. recursive is a flag, not a
            // disjunct, so it stays ANDed inside the group.
            expect(conditionsOn(groupWith('collection'))).toContainEqual(['recursive', 'true', '']);
        });

        it('omits recursive from the conditions group when recursive is false', async () => {
            searchResultIds = [1];
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                recursive: false,
                conditions: [{ field: 'collection', operator: 'is', value: 'ABCD2345' }],
            }));

            expect(conditionsOn(groupWith('collection')).some(([field]) => field === 'recursive'))
                .toBe(false);
        });

        it('builds no group and runs no extra search when the mode is all', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'all',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.conditions_join_mode).toBe('all');
            expect(addedConditions()).toContainEqual(['DOI', 'doesNotContain', '']);
            expect(orGroupSearches()).toHaveLength(0);
            expect(mainSearch()?.setScope).not.toHaveBeenCalled();
        });

        it('treats an omitted mode as all', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.conditions_join_mode).toBe('all');
            expect(addedConditions()).toContainEqual(['DOI', 'doesNotContain', '']);
            expect(orGroupSearches()).toHaveLength(0);
        });

        it('treats an unrecognized mode as all rather than widening the population', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                // Off-wire value: a bogus mode must not resolve to 'any'.
                conditions_join_mode: 'ANY' as any,
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.conditions_join_mode).toBe('all');
            expect(addedConditions()).toContainEqual(['DOI', 'doesNotContain', '']);
            expect(orGroupSearches()).toHaveLength(0);
        });

        it.each(['unfiled', 'retracted', 'publications', 'feed'])(
            'rejects a %s condition under any, which Zotero would AND instead of OR',
            async (field) => {
                const response = await handleResolvePopulationRequest(makeRequest({
                    conditions_join_mode: 'any',
                    conditions: [
                        { field, operator: 'true', value: '' },
                        { field: 'DOI', operator: 'is', value: '' },
                    ],
                }));

                expect(response.error_code).toBe('invalid_request');
                expect(response.error).toContain(field);
                expect(response.item_ids).toEqual([]);
                expect(response.total_count).toBe(0);
                // A failed resolution carries no applied mode.
                expect(response.conditions_join_mode).toBeUndefined();
                expect(searches).toHaveLength(0);
            },
        );

        it('accepts those same conditions under all, where they only narrow', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [
                    { field: 'unfiled', operator: 'true', value: '' },
                    { field: 'retracted', operator: 'true', value: '' },
                ],
            }));

            expect(response.error).toBeUndefined();
            expect(addedConditions()).toContainEqual(['unfiled', 'true', '']);
            expect(addedConditions()).toContainEqual(['retracted', 'true', '']);
        });

        it('echoes the applied mode on a resolved population', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.conditions_join_mode).toBe('any');
            expect(response.item_ids).toEqual(['u-KEY1']);
        });

        it('echoes the applied mode on a count-only request', async () => {
            searchResultIds = [1, 2];
            seedItem(1);
            seedItem(2);

            const response = await handleResolvePopulationRequest(makeRequest({
                max_items: 0,
                conditions_join_mode: 'any',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.conditions_join_mode).toBe('any');
            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(2);
        });

        it('applies all three groups and returns their intersection', async () => {
            searchResultIds = [1, 2, 3, 4];
            groupResults = [
                [hasCondition('tag'), [2, 3, 4, 5]],
                [hasCondition('DOI'), [3, 4, 6]],
            ];
            for (const itemID of [1, 2, 3, 4]) seedItem(itemID);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });
            collections.set(`${LIBRARY_ID}/EFGH6789`, { id: 78, name: 'Theory' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345', 'EFGH6789'],
                tags: ['to-read', 'reviewed'],
                conditions_join_mode: 'any',
                conditions: [
                    { field: 'DOI', operator: 'is', value: '' },
                    { field: 'abstractNote', operator: 'is', value: '' },
                ],
            }));

            expect(response.error).toBeUndefined();
            expect(orGroupSearches()).toHaveLength(3);
            expect(orGroupValues('collection')).toEqual(['ABCD2345', 'EFGH6789']);
            expect(orGroupValues('tag')).toEqual(['to-read', 'reviewed']);
            expect(conditionsOn(groupWith('DOI'))).toContainEqual(['joinMode', 'any', '']);
            // Still exactly one scope: the collection group. The other two are
            // run on their own and intersected.
            expect(scopeChain()).toHaveLength(1);
            expect(response.item_ids).toEqual(['u-KEY3', 'u-KEY4']);
            expect(response.total_count).toBe(2);
        });

        it('builds no conditions group when every condition was dropped', async () => {
            searchResultIds = [1, 2];
            seedItem(1);
            seedItem(2);
            (globalThis as any).Zotero.Search = class RejectingSearch {
                libraryID = 0;
                addCondition = vi.fn((field: string) => {
                    if (field === 'bogusField') throw new Error('Invalid search condition');
                    return 1;
                });
                search = vi.fn(async () => searchResultIds);
                setScope = vi.fn();
                constructor() {
                    searches.push(this as unknown as MockSearchInstance);
                }
            };

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions_join_mode: 'any',
                conditions: [{ field: 'bogusField', operator: 'is', value: 'x' }],
            }));

            expect(response.warnings).toHaveLength(1);
            // A group left carrying nothing but its join mode matches the whole
            // library, so attaching or running it would widen the population.
            expect(mainSearch()?.setScope).not.toHaveBeenCalled();
            expect(orGroupSearches()[0]?.search).not.toHaveBeenCalled();
        });
    });

    describe('display names', () => {
        it('names the library and the collections the filters resolved against', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345'],
            }));

            expect(response.library_name).toBe('My Library');
            expect(response.collection_names).toEqual(['Methods']);
        });

        it('names every collection, in the order the request asked for them', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });
            collections.set(`${LIBRARY_ID}/EFGH6789`, { id: 78, name: 'Theory' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['EFGH6789', 'ABCD2345'],
            }));

            // The card pairs names with keys positionally; a reordered answer
            // would name a place the population does not cover.
            expect(response.collection_names).toEqual(['Theory', 'Methods']);
        });

        it('names the library alone when the population is not scoped to a collection', async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({ tags: ['to-read'] }));

            expect(response.library_name).toBe('My Library');
            expect(response.collection_names).toEqual([]);
        });

        it('names both on a count-only request, which returns no ids to name them from', async () => {
            searchResultIds = [1, 2];
            seedItem(1);
            seedItem(2);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345'],
                max_items: 0,
            }));

            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(2);
            expect(response.library_name).toBe('My Library');
            expect(response.collection_names).toEqual(['Methods']);
        });
    });

    describe('item selection', () => {
        it('restricts the search to regular items with no children for a regular population', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({ item_category: 'regular' }));

            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'attachment']);
            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'note']);
            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'annotation']);
            expect(addedConditions()).toContainEqual(['noChildren', 'true', '']);
        });

        it('still searches for regular items with no children for an attachment population', async () => {
            searchResultIds = [1];
            seedItem(1, { attachments: [101] });

            await handleResolvePopulationRequest(makeRequest({ item_category: 'attachment' }));

            expect(addedConditions()).toContainEqual(['noChildren', 'true', '']);
            expect(addedConditions()).toContainEqual(['itemType', 'isNot', 'attachment']);
            expect(addedConditions()).not.toContainEqual(['itemType', 'is', 'attachment']);
        });

        it('derives an attachment population from the matched items attachments in SQL', async () => {
            searchResultIds = [1, 2];
            seedItem(1, { attachments: [101, 102] });
            seedItem(2, { attachments: [] });

            const response = await handleResolvePopulationRequest(makeRequest({ item_category: 'attachment' }));

            expect(response.error).toBeUndefined();
            expect(response.item_ids).toEqual(['u-ATT101', 'u-ATT102']);
            expect(response.total_count).toBe(2);
            // Derived from itemAttachments, not from an `itemType is attachment` search.
            expect(callsMatching(/SELECT ia\.itemID FROM itemAttachments/)).toHaveLength(1);
            expect(callsMatching(/SELECT ia\.itemID FROM itemAttachments/)[0][1]).toEqual([1, 2]);
        });

        it('excludes trashed attachments from an attachment population', async () => {
            // Only non-trashed attachments are seeded, mirroring the LEFT JOIN
            // on deletedItems the statement carries.
            searchResultIds = [1];
            seedItem(1, { attachments: [101] });

            const response = await handleResolvePopulationRequest(makeRequest({ item_category: 'attachment' }));

            const [sql] = callsMatching(/SELECT ia\.itemID FROM itemAttachments/)[0];
            expect(sql).toContain('LEFT JOIN deletedItems');
            expect(sql).toContain('di.itemID IS NULL');
            expect(response.item_ids).toEqual(['u-ATT101']);
        });
    });

    describe('performance invariant', () => {
        it('never loads items or item data while resolving a population', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1, { attachments: [101] });
            seedItem(2, { attachments: [102] });
            seedItem(3);

            const response = await handleResolvePopulationRequest(makeRequest({
                item_category: 'attachment',
                unfiled: true,
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.error).toBeUndefined();
            expect((globalThis as any).Zotero.Items.getAsync).not.toHaveBeenCalled();
            expect((globalThis as any).Zotero.Items.loadDataTypes).not.toHaveBeenCalled();
        });

        it('never loads items when filtering on has_attachments', async () => {
            searchResultIds = [1, 2];
            seedItem(1, { attachments: [101] });
            seedItem(2);

            await handleResolvePopulationRequest(makeRequest({ has_attachments: true }));

            expect((globalThis as any).Zotero.Items.getAsync).not.toHaveBeenCalled();
            expect((globalThis as any).Zotero.Items.loadDataTypes).not.toHaveBeenCalled();
        });
    });

    describe('has_attachments', () => {
        it('keeps only items that have a non-trashed attachment', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1, { attachments: [101] });
            seedItem(2);
            seedItem(3, { attachments: [103] });

            const response = await handleResolvePopulationRequest(makeRequest({ has_attachments: true }));

            expect(response.item_ids).toEqual(['u-KEY1', 'u-KEY3']);
            expect(response.total_count).toBe(2);
        });

        it('keeps only items without attachments when has_attachments is false', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1, { attachments: [101] });
            seedItem(2);
            seedItem(3, { attachments: [103] });

            const response = await handleResolvePopulationRequest(makeRequest({ has_attachments: false }));

            expect(response.item_ids).toEqual(['u-KEY2']);
            expect(response.total_count).toBe(1);
        });

        it('answers the predicate with one parameterized query over the matched ids', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1, { attachments: [101] });
            seedItem(2);
            seedItem(3);

            await handleResolvePopulationRequest(makeRequest({ has_attachments: true }));

            const predicateCalls = callsMatching(/SELECT DISTINCT ia\.parentItemID/);
            expect(predicateCalls).toHaveLength(1);
            const [sql, params] = predicateCalls[0];
            expect(sql).toContain('FROM itemAttachments ia');
            expect(sql).toContain('LEFT JOIN deletedItems di ON di.itemID = ia.itemID');
            expect(sql).toContain('ia.parentItemID IN (?, ?, ?)');
            expect(sql).toContain('di.itemID IS NULL');
            expect(params).toEqual([1, 2, 3]);
        });

        it('chunks the predicate query at 500 ids', async () => {
            searchResultIds = Array.from({ length: 1200 }, (_, i) => i + 1);
            for (const id of searchResultIds) seedItem(id, { attachments: [] });

            await handleResolvePopulationRequest(makeRequest({ has_attachments: false, max_items: 2000 }));

            const predicateCalls = callsMatching(/SELECT DISTINCT ia\.parentItemID/);
            expect(predicateCalls.map(([, params]) => params.length)).toEqual([500, 500, 200]);
            for (const [sql, params] of predicateCalls) {
                expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
            }
        });

        it('rejects has_attachments combined with an attachment population', async () => {
            searchResultIds = [1];
            seedItem(1, { attachments: [101] });

            const response = await handleResolvePopulationRequest(makeRequest({
                item_category: 'attachment',
                has_attachments: true,
            }));

            expect(response.error_code).toBe('invalid_request');
            expect(response.error).toContain('has_attachments');
            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(0);
            expect(searches).toHaveLength(0);
        });
    });

    describe('ordering and truncation', () => {
        it('reports the pre-truncation total and returns only the first max_items ids', async () => {
            searchResultIds = [1, 2, 3, 4, 5];
            // dateAdded descends with the id, so id order is not the answer.
            seedItem(1, { dateAdded: '2024-05-01 00:00:00' });
            seedItem(2, { dateAdded: '2024-04-01 00:00:00' });
            seedItem(3, { dateAdded: '2024-03-01 00:00:00' });
            seedItem(4, { dateAdded: '2024-02-01 00:00:00' });
            seedItem(5, { dateAdded: '2024-01-01 00:00:00' });

            const response = await handleResolvePopulationRequest(makeRequest({ max_items: 2 }));

            expect(response.truncated).toBe(true);
            expect(response.total_count).toBe(5);
            expect(response.item_ids).toEqual(['u-KEY5', 'u-KEY4']);
        });

        it('is not truncated when the population fits within max_items', async () => {
            searchResultIds = [1, 2];
            seedItem(1, { dateAdded: '2024-02-01 00:00:00' });
            seedItem(2, { dateAdded: '2024-01-01 00:00:00' });

            const response = await handleResolvePopulationRequest(makeRequest({ max_items: 10 }));

            expect(response.truncated).toBe(false);
            expect(response.total_count).toBe(2);
            expect(response.item_ids).toEqual(['u-KEY2', 'u-KEY1']);
        });

        it('returns no ids and still reports the count when max_items is 0', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1);
            seedItem(2);
            seedItem(3);

            const response = await handleResolvePopulationRequest(makeRequest({ max_items: 0 }));

            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(3);
            expect(response.truncated).toBe(true);
            // Count-only: do not materialize keys or a sort order.
            expect((globalThis as any).Zotero.DB.queryAsync).not.toHaveBeenCalled();
        });

        it('emits group ids as g<groupID>-<key>, not library_id-key', async () => {
            const groupLibraryID = 3;
            vi.mocked(validateLibraryAccess).mockReturnValue({
                valid: true,
                library: { libraryID: groupLibraryID, name: 'Some Group' },
            } as any);
            (globalThis as any).Zotero.Groups = {
                getGroupIDFromLibraryID: vi.fn(() => 287629),
            };
            searchResultIds = [1];
            seedItem(1, { key: '4BXI95WE', libraryID: groupLibraryID });

            const response = await handleResolvePopulationRequest(makeRequest());

            expect(response.item_ids).toEqual(['g287629-4BXI95WE']);
        });

        it('breaks a dateAdded tie by itemID', async () => {
            searchResultIds = [7, 3, 5];
            seedItem(7, { dateAdded: '2024-01-01 00:00:00' });
            seedItem(3, { dateAdded: '2024-01-01 00:00:00' });
            seedItem(5, { dateAdded: '2024-01-01 00:00:00' });

            const response = await handleResolvePopulationRequest(makeRequest());

            expect(response.item_ids).toEqual(['u-KEY3', 'u-KEY5', 'u-KEY7']);
        });

        it('orders ids globally rather than per SQL chunk', async () => {
            searchResultIds = Array.from({ length: 1200 }, (_, i) => i + 1);
            // Newest id first: a per-chunk order would surface id 1 first.
            for (const id of searchResultIds) {
                seedItem(id, { dateAdded: `2024-01-01 ${String(1200 - id).padStart(5, '0')}` });
            }

            const response = await handleResolvePopulationRequest(makeRequest({ max_items: 3 }));

            expect(response.total_count).toBe(1200);
            expect(response.truncated).toBe(true);
            expect(response.item_ids).toEqual(['u-KEY1200', 'u-KEY1199', 'u-KEY1198']);
        });

        it('returns an empty population without error when nothing matched', async () => {
            searchResultIds = [];

            const response = await handleResolvePopulationRequest(makeRequest());

            expect(response.error).toBeUndefined();
            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(0);
            expect(response.truncated).toBe(false);
        });
    });

    describe('search conditions', () => {
        it("rewrites an `is` condition with an empty value into doesNotContain ''", async () => {
            searchResultIds = [1];
            seedItem(1);

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(response.error).toBeUndefined();
            expect(response.warnings).toBeUndefined();
            expect(addedConditions()).toContainEqual(['DOI', 'doesNotContain', '']);
        });

        it('passes a mapped operator through unchanged', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                conditions: [
                    { field: 'title', operator: 'contains', value: 'climate' },
                    { field: 'date', operator: 'isAfter', value: '2020' },
                    { field: 'publisher', operator: 'doesNotContain', value: 'Elsevier' },
                ],
            }));

            expect(addedConditions()).toContainEqual(['title', 'contains', 'climate']);
            expect(addedConditions()).toContainEqual(['date', 'isAfter', '2020']);
            expect(addedConditions()).toContainEqual(['publisher', 'doesNotContain', 'Elsevier']);
        });

        it('drops a condition Zotero rejects into warnings instead of failing the request', async () => {
            searchResultIds = [1, 2];
            seedItem(1);
            seedItem(2);
            (globalThis as any).Zotero.Search = class RejectingSearch {
                libraryID = 0;
                addCondition = vi.fn((field: string) => {
                    if (field === 'bogusField') throw new Error('Invalid search condition');
                    return 1;
                });
                search = vi.fn(async () => searchResultIds);
                constructor() {
                    searches.push(this as unknown as MockSearchInstance);
                }
            };

            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [
                    { field: 'bogusField', operator: 'is', value: 'x' },
                    { field: 'title', operator: 'contains', value: 'climate' },
                ],
            }));

            expect(response.error).toBeUndefined();
            expect(response.error_code).toBeUndefined();
            expect(response.item_ids).toEqual(['u-KEY1', 'u-KEY2']);
            expect(response.warnings).toHaveLength(1);
            expect(response.warnings![0]).toContain("field='bogusField'");
            expect(response.warnings![0]).toContain("operator='is'");
            expect(response.warnings![0]).toContain('Invalid search condition');
            // The valid condition still made it onto the search.
            expect(addedConditions()).toContainEqual(['title', 'contains', 'climate']);
        });
    });

    describe('library access', () => {
        it('returns the library error with available libraries and runs no search when the library is excluded', async () => {
            vi.mocked(validateLibraryAccess).mockReturnValue({
                valid: false,
                error: 'Library "Private" is excluded from Beaver',
                error_code: 'library_not_searchable',
                available_libraries: [{ library_id: 1, name: 'My Library', type: 'user' }],
            } as any);

            const response = await handleResolvePopulationRequest(makeRequest({ library_id: 5 }));

            expect(response.error_code).toBe('library_not_searchable');
            expect(response.error).toContain('Private');
            expect(response.available_libraries).toEqual([{ library_id: 1, name: 'My Library', type: 'user' }]);
            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(0);
            expect(response.truncated).toBe(false);
            expect(searches).toHaveLength(0);
            expect((globalThis as any).Zotero.DB.queryAsync).not.toHaveBeenCalled();
        });

        it('returns the not-found error with available libraries for an unknown library', async () => {
            vi.mocked(validateLibraryAccess).mockReturnValue({
                valid: false,
                error: 'Library not found: "Nope"',
                error_code: 'library_not_found',
                available_libraries: [{ library_id: 1, name: 'My Library', type: 'user' }],
            } as any);

            const response = await handleResolvePopulationRequest(makeRequest({ library_id: 'Nope' }));

            expect(response.error_code).toBe('library_not_found');
            expect(response.available_libraries).toHaveLength(1);
            expect(searches).toHaveLength(0);
        });
    });

    describe('invalid filters', () => {
        it('reports collection_not_found for a key the library does not have', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ collection_keys: ['ZZZZ9999'] }));

            expect(response.error_code).toBe('collection_not_found');
            expect(response.error).toContain('ZZZZ9999');
            expect(response.error).toContain('list_collections');
            expect(response.item_ids).toEqual([]);
            expect(searches).toHaveLength(0);
        });

        it('names the one bad key when the rest of the group resolves', async () => {
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77, name: 'Methods' });

            const response = await handleResolvePopulationRequest(makeRequest({
                collection_keys: ['ABCD2345', 'ZZZZ9999'],
            }));

            // Resolving the rest would drop a disjunct, and a dropped disjunct
            // NARROWS an OR-group — the batch would silently skip a collection
            // the user was told it covers.
            expect(response.error_code).toBe('collection_not_found');
            expect(response.error).toContain('ZZZZ9999');
            expect(response.error).not.toContain('ABCD2345');
            expect(searches).toHaveLength(0);
        });

        it('reports tag_not_found for a tag the library does not have', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ tags: ['To Read'] }));

            expect(response.error_code).toBe('tag_not_found');
            expect(response.error).toContain('To Read');
            expect(response.item_ids).toEqual([]);
            expect(searches.every(search =>
                !search.addCondition.mock.calls.some(
                    (call: any[]) => call[0] === 'tag' && call[2] === 'To Read'))).toBe(true);
        });

        it('reports tag_not_found for one bad tag among several', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({
                tags: ['to-read', 'nonexistent'],
            }));

            expect(response.error_code).toBe('tag_not_found');
            expect(response.error).toContain('nonexistent');
        });

        it('refuses a joinMode condition instead of letting it flip the search to OR', async () => {
            searchResultIds = [1];
            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [
                    { field: 'joinMode', operator: 'any', value: '' },
                    { field: 'DOI', operator: 'is', value: '' },
                ],
            }));

            expect(searches[0].addCondition).not.toHaveBeenCalledWith('joinMode', expect.anything(), expect.anything());
            expect(searches[0].addCondition).toHaveBeenCalledWith('DOI', 'doesNotContain', '');
            expect(response.warnings?.join(' ')).toContain('joinMode');
        });

        it('refuses conditions that would admit trashed or child items', async () => {
            searchResultIds = [1];
            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [
                    { field: 'includeDeleted', operator: 'true', value: '' },
                    { field: 'includeParentsAndChildren', operator: 'true', value: '' },
                    { field: 'noChildren', operator: 'false', value: '' },
                ],
            }));

            const added = searches[0].addCondition.mock.calls.map((call: any[]) => call[0]);
            expect(added).not.toContain('includeDeleted');
            expect(added).not.toContain('includeParentsAndChildren');
            // The handler adds noChildren itself; the caller's is dropped, so
            // exactly one call remains and it is the handler's own 'true'.
            expect(added.filter((field: string) => field === 'noChildren')).toHaveLength(1);
            expect(searches[0].addCondition).toHaveBeenCalledWith('noChildren', 'true', '');
            expect(response.warnings).toHaveLength(3);
        });

        it('keeps predicates that only narrow, however unfamiliar', async () => {
            // The guard is about widening, not about vocabulary: each of these
            // compiles to one more ANDed `itemID IN (...)`, so it can only
            // shrink the population and belongs to the caller.
            searchResultIds = [1];
            const response = await handleResolvePopulationRequest(makeRequest({
                conditions: [
                    { field: 'retracted', operator: 'true', value: '' },
                    { field: 'publications', operator: 'true', value: '' },
                    { field: 'quicksearch-titleCreatorYear', operator: 'contains', value: 'gene' },
                ],
            }));

            const added = searches[0].addCondition.mock.calls.map((call: any[]) => call[0]);
            expect(added).toContain('retracted');
            expect(added).toContain('publications');
            expect(added).toContain('quicksearch-titleCreatorYear');
            expect(response.warnings).toBeUndefined();
        });

        it('rejects an empty tag entry and points at untagged', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ tags: ['to-read', ''] }));

            expect(response.error_code).toBe('invalid_request');
            expect(response.error).toContain('untagged');
            expect(searches).toHaveLength(0);
        });

        it('rejects an empty collection key entry', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ collection_keys: [''] }));

            expect(response.error_code).toBe('invalid_request');
            expect(response.error).toContain('collection_keys');
            expect(searches).toHaveLength(0);
        });

        it('reports an internal error rather than an empty match when the search throws', async () => {
            (globalThis as any).Zotero.Search = class ThrowingSearch {
                libraryID = 0;
                addCondition = vi.fn();
                search = vi.fn(async () => { throw new Error('search blew up'); });
                setScope = vi.fn();
                constructor() {
                    searches.push(this as unknown as MockSearchInstance);
                }
            };

            const response = await handleResolvePopulationRequest(makeRequest());

            expect(response.error_code).toBe('internal_error');
            expect(response.error).toContain('search blew up');
            expect(response.item_ids).toEqual([]);
            expect(response.total_count).toBe(0);
        });
    });

    describe('matched_item_count', () => {
        it('equals total_count for a regular population', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1);
            seedItem(2);
            seedItem(3);

            const response = await handleResolvePopulationRequest(makeRequest({ item_category: 'regular' }));

            expect(response.matched_item_count).toBe(3);
            expect(response.total_count).toBe(3);
        });

        it('counts items while total_count counts their attachments', async () => {
            searchResultIds = [1, 2];
            seedItem(1, { attachments: [101, 102] });
            seedItem(2, { attachments: [103] });

            const response = await handleResolvePopulationRequest(makeRequest({ item_category: 'attachment' }));

            expect(response.matched_item_count).toBe(2);
            expect(response.total_count).toBe(3);
            expect(response.item_ids).toEqual(['u-ATT101', 'u-ATT102', 'u-ATT103']);
        });

        it('reports the items that matched when none of them has a file', async () => {
            // The case the field exists for: an empty population whose filters
            // were correct. Without this count the caller sees only
            // total_count 0 and reads it as "the filters matched nothing".
            searchResultIds = [1, 2, 3];
            seedItem(1, { attachments: [] });
            seedItem(2, { attachments: [] });
            seedItem(3, { attachments: [] });

            const response = await handleResolvePopulationRequest(makeRequest({ item_category: 'attachment' }));

            expect(response.error).toBeUndefined();
            expect(response.matched_item_count).toBe(3);
            expect(response.total_count).toBe(0);
            expect(response.item_ids).toEqual([]);
        });

        it('counts the items has_attachments kept, not the ones the search returned', async () => {
            searchResultIds = [1, 2, 3];
            seedItem(1, { attachments: [101] });
            seedItem(2);
            seedItem(3, { attachments: [103] });

            const response = await handleResolvePopulationRequest(makeRequest({ has_attachments: true }));

            expect(response.matched_item_count).toBe(2);
            expect(response.total_count).toBe(2);
        });

        it('is reported on the count-only path', async () => {
            searchResultIds = [1, 2];
            seedItem(1, { attachments: [101, 102] });
            seedItem(2, { attachments: [103] });

            const response = await handleResolvePopulationRequest(makeRequest({
                item_category: 'attachment',
                max_items: 0,
            }));

            expect(response.matched_item_count).toBe(2);
            expect(response.total_count).toBe(3);
            expect(response.item_ids).toEqual([]);
        });

        it('is absent from an error response', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ collection_keys: ['ZZZZ9999'] }));

            expect(response.error_code).toBe('collection_not_found');
            expect(response.matched_item_count).toBeUndefined();
        });
    });
});
