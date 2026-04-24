/**
 * Unit tests for manage_tags validate + execute handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must come before any imports from source under test)
// ---------------------------------------------------------------------------

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    validateLibraryAccess: vi.fn(),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// Provide Zotero.Tags + Zotero.Items + Zotero.DB on the global stub.
// Zotero.DB.queryAsync is driven by `dbRows` below: tests push shape-specific
// row objects (each exposing `getResultByIndex(i)`) and the mock invokes
// `onRow` for each once per call, then clears the queue.
const dbRows: { getResultByIndex: (i: number) => unknown }[] = [];
const queryAsyncMock = vi.fn(async (_sql: string, _params: unknown[], opts?: { onRow?: (row: any) => void }) => {
    if (opts && typeof opts.onRow === 'function') {
        for (const row of dbRows) opts.onRow(row);
    }
    dbRows.length = 0;
});

function queueDbRow(values: unknown[]) {
    dbRows.push({ getResultByIndex: (i: number) => values[i] });
}

(globalThis as any).Zotero = {
    ...((globalThis as any).Zotero ?? {}),
    Tags: {
        getID: vi.fn(),
        getColor: vi.fn(() => null),
        getTagItems: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        removeFromLibrary: vi.fn(async () => undefined),
        setColor: vi.fn(async () => undefined),
        init: vi.fn(async () => undefined),
    },
    Items: {
        getAsync: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, key: `KEY${id}` }))),
        loadDataTypes: vi.fn(async () => undefined),
    },
    DB: {
        queryAsync: queryAsyncMock,
    },
};

import {
    validateManageTagsAction,
    executeManageTagsAction,
} from '../../../src/services/agentDataProvider/actions/manageTags';
import { validateLibraryAccess, getDeferredToolPreference } from '../../../src/services/agentDataProvider/utils';

const Zot = (globalThis as any).Zotero;


function okLibrary() {
    (validateLibraryAccess as any).mockReturnValue({
        valid: true,
        library: { libraryID: 1, name: 'My Library', editable: true },
    });
}


beforeEach(() => {
    vi.clearAllMocks();
    Zot.Tags.getID.mockReset();
    Zot.Tags.getColor.mockReset();
    Zot.Tags.getTagItems.mockReset();
    Zot.Tags.rename.mockReset();
    Zot.Tags.removeFromLibrary.mockReset();
    Zot.Tags.setColor.mockReset();
    Zot.Tags.init.mockReset();
    Zot.Tags.init.mockResolvedValue(undefined);
    queryAsyncMock.mockClear();
    queryAsyncMock.mockImplementation(async (_sql: string, _params: unknown[], opts?: { onRow?: (row: any) => void }) => {
        if (opts && typeof opts.onRow === 'function') {
            for (const row of dbRows) opts.onRow(row);
        }
        dbRows.length = 0;
    });
    dbRows.length = 0;
    (getDeferredToolPreference as any).mockReturnValue('always_ask');
    Zot.Tags.getColor.mockReturnValue(null);
    Zot.Tags.getTagItems.mockResolvedValue([]);
});


describe('validateManageTagsAction', () => {
    it('rejects empty tag name', async () => {
        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r1',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: '  ', new_name: 'x' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_name');
    });

    it('rejects when library lookup fails', async () => {
        (validateLibraryAccess as any).mockReturnValue({
            valid: false,
            error: 'not found',
            error_code: 'library_not_found',
        });
        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r2',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'x', library_id: 999 },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('library_not_found');
    });

    it('rejects when tag does not exist in the library', async () => {
        okLibrary();
        Zot.Tags.getID.mockReturnValue(false);
        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r3',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'missing' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('tag_not_found');
    });

    it('detects merge (preview) when rename target already exists', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation((name: string) => (name === 'old' ? 7 : name === 'new' ? 8 : false));
        Zot.Tags.getTagItems.mockResolvedValue([10, 20]);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r4',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'old', new_name: 'new' },
        } as any);
        expect(resp.valid).toBe(true);
        // Preview info in current_value (for the approval card)
        expect(resp.current_value?.is_merge).toBe(true);
        expect(resp.current_value?.item_count).toBe(2);
        // Snapshots are NOT in normalized_action_data; they come from execute.
        expect(resp.normalized_action_data?.affected_item_ids).toBeUndefined();
        expect(resp.normalized_action_data?.old_color).toBeUndefined();
        expect(resp.normalized_action_data?.library_id).toBe(1);
        expect(resp.preference).toBe('always_ask');
    });

    it('reports item_count in current_value (preview) for delete', async () => {
        okLibrary();
        Zot.Tags.getID.mockReturnValue(42);
        Zot.Tags.getColor.mockReturnValue({ color: '#ff0000', position: 3 });
        Zot.Tags.getTagItems.mockResolvedValue([100]);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r5',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'foo' },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.current_value?.item_count).toBe(1);
        // Snapshots are captured at execute time, not validation.
        expect(resp.normalized_action_data?.affected_item_ids).toBeUndefined();
        expect(resp.normalized_action_data?.old_color).toBeUndefined();
    });

    it('rejects rename with empty new_name', async () => {
        okLibrary();
        Zot.Tags.getID.mockReturnValue(42);
        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r6',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'foo', new_name: '' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_new_name');
    });

    it('rejects rename with new_name equal to name', async () => {
        okLibrary();
        Zot.Tags.getID.mockReturnValue(42);
        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r7',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'foo', new_name: 'foo' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_new_name');
    });

    it('rebuilds the tag cache and retries on miss (cache desync)', async () => {
        okLibrary();
        // First getID call misses, second (after init) hits. Target (new_name)
        // getID calls also return false so this isn't a merge.
        let callCount = 0;
        Zot.Tags.getID.mockImplementation((n: string) => {
            if (n === 'Arts') {
                callCount++;
                return callCount === 1 ? false : 77;
            }
            return false;
        });
        Zot.Tags.getTagItems.mockResolvedValue([10]);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-desync',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'Arts', new_name: 'arts' },
        } as any);
        expect(resp.valid).toBe(true);
        expect(Zot.Tags.init).toHaveBeenCalledTimes(1);
        // Cache rebuild produced a hit — no DB probe needed.
        expect(queryAsyncMock).not.toHaveBeenCalled();
    });

    it('returns "Did you mean" hint when cache rebuild does not recover the tag', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation(() => false);
        queryAsyncMock.mockImplementationOnce(async (_sql: string, _params: unknown[], opts?: { onRow?: (row: any) => void }) => {
            opts?.onRow?.({ getResultByIndex: (i: number) => ['scientific writing'][i] });
        });

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-hint',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'Scientific writing', new_name: 'scientific-writing' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('tag_not_found');
        expect(resp.error).toContain("Did you mean: 'scientific writing'?");
        expect(Zot.Tags.init).toHaveBeenCalledTimes(1);
    });

    it('preserves plain "Tag not found" error when there is no DB match at all', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation(() => false);
        // Case-insensitive DB probe returns no rows (default empty queue).

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-nomatch',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'totally-missing' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('tag_not_found');
        expect(resp.error).not.toContain('Did you mean');
    });

    it('shares a single cache rebuild across concurrent cache misses', async () => {
        okLibrary();
        // All source getID lookups miss initially; once init runs they all hit.
        let initDone = false;
        Zot.Tags.init.mockImplementation(async () => {
            // Simulate some async work so the promise doesn't resolve synchronously.
            await Promise.resolve();
            initDone = true;
        });
        Zot.Tags.getID.mockImplementation((n: string) => {
            // new_name lookups (merge detection) — always miss
            if (!n.startsWith('Tag')) return false;
            return initDone ? 100 + parseInt(n.slice(3), 10) : false;
        });
        Zot.Tags.getTagItems.mockResolvedValue([]);

        const calls = [0, 1, 2, 3, 4].map((i) =>
            validateManageTagsAction({
                event: 'agent_action_validate',
                request_id: `r-concurrent-${i}`,
                action_type: 'manage_tags',
                action_data: { action: 'rename', name: `Tag${i}`, new_name: `tag-${i}` },
            } as any),
        );
        const results = await Promise.all(calls);

        for (const r of results) expect(r.valid).toBe(true);
        // The rebuild promise is shared, so init fires exactly once even
        // though 5 concurrent calls all hit the miss path.
        expect(Zot.Tags.init).toHaveBeenCalledTimes(1);
    });
});


describe('executeManageTagsAction', () => {
    const ctx: any = { signal: { aborted: false }, timeoutSeconds: 25, startTime: Date.now() };

    it('re-snapshots and returns affected_item_ids + old_color + is_merge in result_data (rename, no merge)', async () => {
        // tagID for source, no existing target → no merge
        Zot.Tags.getID.mockImplementation((n: string) => (n === 'old' ? 7 : false));
        Zot.Tags.getTagItems.mockResolvedValue([10, 20]);
        Zot.Tags.getColor.mockReturnValue({ color: '#00ff00', position: 1 });

        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e1',
            action_type: 'manage_tags',
            action_data: {
                action: 'rename',
                name: 'old',
                new_name: 'new',
                library_id: 1,
            },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(Zot.Tags.rename).toHaveBeenCalledWith(1, 'old', 'new');
        expect(resp.result_data?.items_affected).toBe(2);
        expect(resp.result_data?.affected_item_ids).toHaveLength(2);
        expect(resp.result_data?.old_color).toEqual({ color: '#00ff00', position: 1 });
        expect(resp.result_data?.is_merge).toBe(false);
    });

    it('re-checks is_merge at execute time (target already exists)', async () => {
        Zot.Tags.getID.mockImplementation((n: string) => (n === 'old' ? 7 : n === 'new' ? 8 : false));
        Zot.Tags.getTagItems.mockResolvedValue([10]);

        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e1b',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'old', new_name: 'new', library_id: 1 },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(resp.result_data?.is_merge).toBe(true);
    });

    it('calls Zotero.Tags.removeFromLibrary for delete and returns snapshot', async () => {
        Zot.Tags.getID.mockReturnValue(11);
        Zot.Tags.getTagItems.mockResolvedValue([42]);

        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e2',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'foo', library_id: 1 },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(Zot.Tags.removeFromLibrary).toHaveBeenCalledWith(1, [11]);
        expect(resp.result_data?.items_affected).toBe(1);
        expect(resp.result_data?.affected_item_ids).toHaveLength(1);
    });

    it('succeeds when tag already deleted (getID returns false)', async () => {
        Zot.Tags.getID.mockReturnValue(false);
        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e3',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'gone', library_id: 1 },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(Zot.Tags.removeFromLibrary).not.toHaveBeenCalled();
        expect(resp.result_data?.items_affected).toBe(0);
    });

    it('fails with invalid_library_id when library_id missing', async () => {
        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e4',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'x', new_name: 'y' },
        } as any, ctx);
        expect(resp.success).toBe(false);
        expect(resp.error_code).toBe('invalid_library_id');
    });

    it('rebuilds the cache when stale at execute time and proceeds with rename', async () => {
        // First getID for source misses; after init it resolves. new_name
        // lookups (merge check) always miss.
        let sourceCalls = 0;
        Zot.Tags.getID.mockImplementation((n: string) => {
            if (n === 'Arts') {
                sourceCalls++;
                return sourceCalls === 1 ? false : 88;
            }
            return false;
        });
        Zot.Tags.getTagItems.mockResolvedValue([10, 20]);

        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e-desync',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'Arts', new_name: 'arts', library_id: 1 },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(Zot.Tags.init).toHaveBeenCalledTimes(1);
        expect(Zot.Tags.rename).toHaveBeenCalledWith(1, 'Arts', 'arts');
        expect(resp.result_data?.items_affected).toBe(2);
    });
});
