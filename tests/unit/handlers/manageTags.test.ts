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
    checkLibraryExcluded: vi.fn(() => null),
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
    Libraries: {
        ...((globalThis as any).Zotero?.Libraries ?? {}),
        userLibraryID: 1,
    },
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
    canonicalTagForm,
    suggestionTagForm,
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
        // Unified across manage_tags and manage_collections (frontend + backend).
        expect(resp.error).toBe('new_name must be different from the current name');
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

    it('scopes the near-match probe to the target library', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation(() => false);
        queryAsyncMock.mockImplementationOnce(async (sql: string, params: unknown[], opts?: { onRow?: (row: any) => void }) => {
            // Verify SQL scopes to libraryID via itemTags join; matching is
            // done in JS, so the only param is the library.
            expect(sql).toContain('itemTags');
            expect(sql).toContain('libraryID');
            expect(params).toEqual([1]);
            opts?.onRow?.({ getResultByIndex: (i: number) => ['important'][i] });
        });

        // getID stays false even for the probed name, so auto-resolution
        // degrades to a suggestion instead of resolving.
        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-scope',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'IMPORTANT' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error).toContain("Did you mean: 'important'?");
    });

    it('auto-resolves a unique case-insensitive match and reports it in normalized_action_data', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation((n: string) => (n === 'academic identity' ? 42 : false));
        Zot.Tags.getTagItems.mockResolvedValue([10]);
        queueDbRow(['academic identity']);
        queueDbRow(['unrelated tag']);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-resolve',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'Academic identity' },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.current_value?.name).toBe('academic identity');
        expect(resp.normalized_action_data?.name).toBe('academic identity');
        expect(resp.current_value?.item_count).toBe(1);
    });

    it('auto-resolves apostrophe and Unicode-form variants', async () => {
        okLibrary();
        const stored = 'séjour d’études à l’étranger'; // curly apostrophes
        Zot.Tags.getID.mockImplementation((n: string) => (n === stored ? 55 : false));
        queueDbRow([stored]);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-apostrophe',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: "Séjour d'études à l'étranger" }, // straight
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.normalized_action_data?.name).toBe(stored);
    });

    it('does not auto-resolve when multiple case variants coexist (lists them as suggestions)', async () => {
        okLibrary();
        Zot.Tags.getID.mockReturnValue(false);
        queueDbRow(['Academic identity']);
        queueDbRow(['academic identity']);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-ambiguous',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'ACADEMIC IDENTITY' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('tag_not_found');
        expect(resp.error).toContain("'Academic identity'");
        expect(resp.error).toContain("'academic identity'");
    });

    it('suggests but does not auto-resolve a diacritic-only match', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation((n: string) => (n === 'séance' ? 9 : false));
        queueDbRow(['séance']);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-diacritic',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'seance' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('tag_not_found');
        expect(resp.error).toContain("Did you mean: 'séance'?");
    });

    it('returns rename_noop when resolution collapses name onto new_name', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation((n: string) => (n === 'academic identity' ? 42 : false));
        queueDbRow(['academic identity']);

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-noop',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'Academic identity', new_name: 'academic identity' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('rename_noop');
        expect(resp.error).toContain("already named 'academic identity'");
    });

    it('returns validation_failed when the resolver throws (e.g. DB lock in init)', async () => {
        okLibrary();
        Zot.Tags.getID.mockImplementation(() => false);
        Zot.Tags.init.mockRejectedValueOnce(new Error('database is locked'));

        const resp = await validateManageTagsAction({
            event: 'agent_action_validate',
            request_id: 'r-throw',
            action_type: 'manage_tags',
            action_data: { action: 'delete', name: 'whatever' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('validation_failed');
        expect(resp.error).toContain('database is locked');
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
        expect(resp.result_data?.affected_item_ids).toEqual(['u-KEY10', 'u-KEY20']);
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
        expect(resp.result_data?.affected_item_ids).toEqual(['u-KEY42']);
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

    it('renames via the auto-resolved source tag when the exact name is missing', async () => {
        Zot.Tags.getID.mockImplementation((n: string) => (n === 'old tag' ? 7 : false));
        Zot.Tags.getTagItems.mockResolvedValue([10]);
        queueDbRow(['old tag']);

        const resp = await executeManageTagsAction({
            event: 'agent_action_execute',
            request_id: 'e-resolve',
            action_type: 'manage_tags',
            action_data: { action: 'rename', name: 'Old Tag', new_name: 'renamed', library_id: 1 },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(Zot.Tags.rename).toHaveBeenCalledWith(1, 'old tag', 'renamed');
        // result_data reports the tag actually operated on
        expect(resp.result_data?.name).toBe('old tag');
    });
});


describe('canonicalTagForm', () => {
    it('folds case, trims, and collapses whitespace runs', () => {
        expect(canonicalTagForm('  Academic   Identity ')).toBe('academic identity');
    });

    it('unifies curly and straight apostrophes and quotes', () => {
        expect(canonicalTagForm('l’université')).toBe(canonicalTagForm("l'université"));
        expect(canonicalTagForm('“quoted”')).toBe(canonicalTagForm('"quoted"'));
    });

    it('normalizes Unicode composition (NFC vs NFD)', () => {
        // composed é (U+00E9) vs decomposed e + combining acute (U+0301)
        expect(canonicalTagForm('s\u00e9ance')).toBe(canonicalTagForm('se\u0301ance'));
    });

    it('preserves diacritics (accented names stay distinct)', () => {
        expect(canonicalTagForm('séance')).not.toBe(canonicalTagForm('seance'));
    });
});


describe('suggestionTagForm', () => {
    it('additionally strips diacritics', () => {
        expect(suggestionTagForm('Séjour d’Études')).toBe("sejour d'etudes");
    });
});
