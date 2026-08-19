import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    validateLibraryAccess: vi.fn(),
}));

import type { WSResolvePopulationRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { handleResolvePopulationRequest } from '../../../src/services/agentDataProvider/handleResolvePopulationRequest';
import { validateLibraryAccess } from '../../../src/services/agentDataProvider/utils';

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
};

const LIBRARY_ID = 1;

describe('handleResolvePopulationRequest', () => {
    /** Fake `items` table, keyed by itemID. */
    const itemRows = new Map<number, ItemRow>();
    /** Fake `itemAttachments`: parent itemID -> non-trashed attachment itemIDs. */
    const attachmentsByParent = new Map<number, number[]>();
    /** What the native search resolves to. */
    let searchResultIds: number[] = [];
    /** Every Zotero.Search the handler constructed, in construction order. */
    let searches: MockSearchInstance[] = [];
    /** Collections the handler can resolve, keyed by "<libraryID>/<key>". */
    const collections = new Map<string, { id: number }>();

    const mainSearch = () => searches[0] ?? null;

    /** Conditions handed to the primary search, as [field, operator, value]. */
    const addedConditions = () =>
        (mainSearch()?.addCondition.mock.calls ?? []).map(call => call.slice(0, 3));

    /** All Zotero.DB.queryAsync calls as [sql, params] pairs. */
    const dbCalls = (): [string, any[]][] =>
        (globalThis as any).Zotero.DB.queryAsync.mock.calls.map((call: any[]) => [call[0], call[1]]);

    const callsMatching = (pattern: RegExp) => dbCalls().filter(([sql]) => pattern.test(sql));

    /** Seed an item row plus, optionally, the attachments hanging off it. */
    function seedItem(itemID: number, options: { key?: string; dateAdded?: string; attachments?: number[] } = {}) {
        itemRows.set(itemID, {
            itemID,
            key: options.key ?? `KEY${itemID}`,
            libraryID: LIBRARY_ID,
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
        searches = [];

        vi.mocked(validateLibraryAccess).mockReturnValue({
            valid: true,
            library: { libraryID: LIBRARY_ID, name: 'My Library' },
        } as any);

        // modelObjectId() derives the portable "u-" prefix from this.
        (globalThis as any).Zotero.Libraries.userLibraryID = LIBRARY_ID;

        (globalThis as any).Zotero.Search = class MockSearch {
            libraryID = 0;
            addCondition = vi.fn();
            search = vi.fn(async () => searchResultIds);
            constructor() {
                searches.push(this as unknown as MockSearchInstance);
            }
        };

        (globalThis as any).Zotero.Collections = {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) =>
                collections.get(`${libraryID}/${key}`) ?? false),
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

        it('adds an exact tag condition and a recursive collection scope', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77 });

            await handleResolvePopulationRequest(makeRequest({
                tag: 'to-read',
                collection_key: 'ABCD2345',
                recursive: true,
            }));

            expect(addedConditions()).toContainEqual(['tag', 'is', 'to-read']);
            expect(addedConditions()).toContainEqual(['collectionID', 'is', '77']);
            expect(addedConditions()).toContainEqual(['recursive', 'true', '']);
        });

        it('omits the recursive condition when recursive is false', async () => {
            searchResultIds = [1];
            seedItem(1);
            collections.set(`${LIBRARY_ID}/ABCD2345`, { id: 77 });

            await handleResolvePopulationRequest(makeRequest({
                collection_key: 'ABCD2345',
                recursive: false,
            }));

            expect(addedConditions()).toContainEqual(['collectionID', 'is', '77']);
            expect(addedConditions().some(([field]) => field === 'recursive')).toBe(false);
        });

        it('never sets a join mode, so every filter stays ANDed', async () => {
            searchResultIds = [1];
            seedItem(1);

            await handleResolvePopulationRequest(makeRequest({
                unfiled: true,
                untagged: true,
                tag: 'to-read',
                conditions: [{ field: 'DOI', operator: 'is', value: '' }],
            }));

            expect(addedConditions().some(([field]) => field === 'joinMode')).toBe(false);
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
            const response = await handleResolvePopulationRequest(makeRequest({ collection_key: 'ZZZZ9999' }));

            expect(response.error_code).toBe('collection_not_found');
            expect(response.error).toContain('ZZZZ9999');
            expect(response.error).toContain('list_collections');
            expect(response.item_ids).toEqual([]);
            expect(searches).toHaveLength(0);
        });

        it('rejects an empty tag and points at untagged', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ tag: '' }));

            expect(response.error_code).toBe('invalid_request');
            expect(response.error).toContain('untagged');
            expect(searches).toHaveLength(0);
        });

        it('rejects an empty collection_key', async () => {
            const response = await handleResolvePopulationRequest(makeRequest({ collection_key: '' }));

            expect(response.error_code).toBe('invalid_request');
            expect(response.error).toContain('collection_key');
            expect(searches).toHaveLength(0);
        });

        it('reports an internal error rather than an empty match when the search throws', async () => {
            (globalThis as any).Zotero.Search = class ThrowingSearch {
                libraryID = 0;
                addCondition = vi.fn();
                search = vi.fn(async () => { throw new Error('search blew up'); });
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
});
