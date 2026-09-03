/**
 * `handleListTagsRequest` — the `name_query` filter.
 *
 * The handler groups over the whole library regardless of `limit`, so asking
 * for 50 tags costs what asking for all of them costs. What makes `name_query`
 * worth having is therefore that it runs in SQL: these tests pin that it lands
 * in the query rather than trimming the finished array, and that a name
 * containing SQL wildcards is still matched literally.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    validateLibraryAccess: vi.fn(),
    getCollectionByIdOrName: vi.fn(),
    isLibrarySearchable: vi.fn(() => true),
    getSearchableLibraries: vi.fn(() => []),
    excludedLibraryMessage: vi.fn(() => 'excluded'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => mocks);

vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(() => 'u'),
}));

import { handleListTagsRequest } from '../../../src/services/agentDataProvider/handleListTagsRequest';

/** One grouped row: name, the four per-type counts, and the manual flag. */
function tagRow(name: string, itemCount = 1, hasManual = 1) {
    const values = [name, itemCount, 0, 0, 0, hasManual];
    return { getResultByIndex: (i: number) => values[i] };
}

const queryAsync = vi.fn();

/** The SQL and params of the single grouping query the handler ran. */
function lastQuery(): { sql: string; params: any[] } {
    const [sql, params] = queryAsync.mock.calls[0];
    return { sql, params };
}

function request(overrides: Record<string, any> = {}) {
    return {
        event: 'list_tags_request',
        request_id: 'r1',
        library_id: 1,
        min_item_count: 0,
        limit: 50,
        offset: 0,
        ...overrides,
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateLibraryAccess.mockReturnValue({
        valid: true,
        library: { libraryID: 1, name: 'My Library' },
    });
    mocks.isLibrarySearchable.mockReturnValue(true);
    queryAsync.mockImplementation(async (_sql: string, _params: any[], opts: any) => {
        opts.onRow(tagRow('methods'));
    });

    const zotero = (globalThis as any).Zotero;
    zotero.DB = { queryAsync };
    zotero.Tags = { getColors: vi.fn(() => new Map()) };
});

describe('handleListTagsRequest name_query', () => {
    it('filters tag names in SQL rather than after grouping', async () => {
        const res = await handleListTagsRequest(request({ name_query: 'meth' }));

        const { sql, params } = lastQuery();
        expect(sql).toContain('T.name LIKE ?');
        expect(sql).toContain("ESCAPE '\\'");
        expect(params).toEqual([1, '%meth%']);
        expect(res.tags.map((t) => t.name)).toEqual(['methods']);
    });

    it('matches a query containing LIKE wildcards literally', async () => {
        await handleListTagsRequest(request({ name_query: '100%_done\\' }));

        expect(lastQuery().params[1]).toBe('%100\\%\\_done\\\\%');
    });

    it('leaves the query unfiltered when no name_query is given', async () => {
        await handleListTagsRequest(request());

        const { sql, params } = lastQuery();
        expect(sql).not.toContain('LIKE');
        expect(params).toEqual([1]);
    });

    it('ignores a whitespace-only name_query rather than matching nothing', async () => {
        await handleListTagsRequest(request({ name_query: '   ' }));

        expect(lastQuery().sql).not.toContain('LIKE');
    });

    it('serves a page big enough to fetch a library once, and no bigger', async () => {
        // Fetch-all-and-filter-locally is the primary path for tags;
        // `name_query` is the fallback when a library is too big for it.
        queryAsync.mockImplementation(async (_sql: string, _params: any[], opts: any) => {
            for (let i = 0; i < 1500; i++) opts.onRow(tagRow(`tag${i}`));
        });

        const generous = await handleListTagsRequest(request({ limit: 1000 }));
        expect(generous.tags).toHaveLength(1000);

        const absurd = await handleListTagsRequest(request({ limit: 100000 }));
        expect(absurd.tags).toHaveLength(1000);
        expect(absurd.total_count).toBe(1500);
    });

    it('treats limit 0 as an empty page rather than one row', async () => {
        const res = await handleListTagsRequest(request({ limit: 0 }));

        expect(res.tags).toEqual([]);
        expect(res.total_count).toBe(1);
    });

    it('appends the filter after the collection scope so the parameters stay aligned', async () => {
        mocks.getCollectionByIdOrName.mockReturnValue({
            libraryID: 1,
            collection: { id: 7, getDescendents: () => [{ id: 8 }] },
        });

        await handleListTagsRequest(request({ collection_key: 'COLLKEY1', name_query: 'meth' }));

        // Collection ids first (they fill the IN placeholders), then the
        // library, then the LIKE pattern.
        expect(lastQuery().params).toEqual([7, 8, 1, '%meth%']);
    });
});
