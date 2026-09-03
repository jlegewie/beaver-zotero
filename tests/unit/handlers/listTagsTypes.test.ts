/**
 * `handleListTagsRequest` — manual vs automatic tags.
 *
 * Type is per (item, tag) pair, so one name can be both. A single manual use
 * makes the whole tag manual, and filtering drops tags, never occurrences.
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
function tagRow(name: string, itemCount: number, hasManual: number) {
    const values = [name, itemCount, 0, 0, 0, hasManual];
    return { getResultByIndex: (i: number) => values[i] };
}

const queryAsync = vi.fn();

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

/** `rows` as the grouping query would emit them. */
function serveRows(rows: ReturnType<typeof tagRow>[]) {
    queryAsync.mockImplementation(async (_sql: string, _params: any[], opts: any) => {
        rows.forEach((row) => opts.onRow(row));
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateLibraryAccess.mockReturnValue({
        valid: true,
        library: { libraryID: 1, name: 'My Library' },
    });
    mocks.isLibrarySearchable.mockReturnValue(true);
    serveRows([tagRow('methods', 4, 1), tagRow('Humans', 412, 0)]);

    const zotero = (globalThis as any).Zotero;
    zotero.DB = { queryAsync };
    zotero.Tags = { getColors: vi.fn(() => new Map()) };
});

describe('handleListTagsRequest tag types', () => {
    it('reads the manual flag out of itemTags.type', async () => {
        const res = await handleListTagsRequest(request());

        const [sql] = queryAsync.mock.calls[0];
        expect(sql).toContain('MAX(CASE WHEN IT.type = 0 THEN 1 ELSE 0 END)');
        expect(res.tags.map((t) => [t.name, t.tag_type])).toEqual([
            ['Humans', 'automatic'],
            ['methods', 'manual'],
        ]);
    });

    it('keeps every tag when the request says nothing about types', async () => {
        // A caller that predates tag types expects the whole vocabulary.
        const res = await handleListTagsRequest(request());

        expect(res.tags).toHaveLength(2);
        expect(res.total_count).toBe(2);
        expect(res.manual_count).toBe(1);
        expect(res.automatic_count).toBe(1);
    });

    it('lists only manual tags for tag_type manual, and still counts both kinds', async () => {
        const res = await handleListTagsRequest(request({ tag_type: 'manual' }));

        expect(res.tags.map((t) => t.name)).toEqual(['methods']);
        expect(res.total_count).toBe(1);
        expect(res.manual_count).toBe(1);
        expect(res.automatic_count).toBe(1);
    });

    it('lists only automatic tags for tag_type automatic, and still counts both kinds', async () => {
        const res = await handleListTagsRequest(request({ tag_type: 'automatic' }));

        expect(res.tags.map((t) => t.name)).toEqual(['Humans']);
        expect(res.total_count).toBe(1);
        expect(res.manual_count).toBe(1);
        expect(res.automatic_count).toBe(1);
    });

    it('lists both for tag_type all', async () => {
        const res = await handleListTagsRequest(request({ tag_type: 'all' }));

        expect(res.tags).toHaveLength(2);
        expect(res.total_count).toBe(2);
    });

    it('calls a tag manual as soon as one item carries it manually', async () => {
        // Same name twice: the merge must OR the flag, not take the last row.
        serveRows([tagRow('mixed', 40, 0), tagRow('mixed', 3, 1)]);

        const res = await handleListTagsRequest(request({ tag_type: 'manual' }));

        expect(res.tags.map((t) => [t.name, t.tag_type, t.item_count])).toEqual([
            ['mixed', 'manual', 43],
        ]);
        expect(res.manual_count).toBe(1);
        expect(res.automatic_count).toBe(0);
    });

    it('does not count a tag that the min_item_count filter already removed', async () => {
        serveRows([tagRow('methods', 4, 1), tagRow('rare-import', 1, 0)]);

        const res = await handleListTagsRequest(
            request({ min_item_count: 2, tag_type: 'manual' })
        );

        expect(res.tags.map((t) => t.name)).toEqual(['methods']);
        expect(res.automatic_count).toBe(0);
    });
});
