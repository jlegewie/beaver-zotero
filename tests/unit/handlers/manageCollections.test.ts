/**
 * Unit tests for manage_collections validate + execute handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    isLibrarySearchable: vi.fn(() => true),
    getCollectionByIdOrName: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// Mutable fixtures for the mocked Zotero globals
const mockCollection: any = {
    id: 10,
    libraryID: 1,
    name: 'Original',
    key: 'ABCD2345',
    parentKey: null,
    saveTx: vi.fn(async () => undefined),
    eraseTx: vi.fn(async () => undefined),
    getChildItems: vi.fn(() => [] as number[]),
    hasChildCollections: vi.fn(() => false),
    getChildCollections: vi.fn(() => [] as any[]),
    getDescendents: vi.fn(() => [] as Array<{ id: number }>),
};

(globalThis as any).Zotero = {
    ...((globalThis as any).Zotero ?? {}),
    Libraries: {
        get: vi.fn(() => ({ libraryID: 1, name: 'My Library', editable: true })),
        userLibraryID: 1,
    },
    Collections: {
        getByLibraryAndKeyAsync: vi.fn(async (_libraryID: number, key: string) => {
            return key === mockCollection.key ? mockCollection : null;
        }),
    },
    Items: {
        getAsync: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, key: `KEY${id}` }))),
        loadDataTypes: vi.fn(async () => undefined),
    },
};

import {
    validateManageCollectionsAction,
    executeManageCollectionsAction,
} from '../../../src/services/agentDataProvider/actions/manageCollections';
import { getCollectionByIdOrName } from '../../../src/services/agentDataProvider/utils';

const Zot = (globalThis as any).Zotero;


beforeEach(() => {
    vi.clearAllMocks();
    // Reset collection state
    mockCollection.name = 'Original';
    mockCollection.parentKey = null;
    mockCollection.getChildItems.mockReturnValue([]);
    mockCollection.hasChildCollections.mockReturnValue(false);
    mockCollection.getChildCollections.mockReturnValue([]);
    mockCollection.getDescendents.mockReturnValue([]);
    mockCollection.saveTx.mockReset();
    mockCollection.eraseTx.mockReset();
    // Re-install default getByLibraryAndKeyAsync (individual tests may override
    // it with .mockImplementation(), which persists across tests otherwise).
    Zot.Collections.getByLibraryAndKeyAsync.mockImplementation(async (_libraryID: number, key: string) => {
        return key === mockCollection.key ? mockCollection : null;
    });
    // Default: getCollectionByIdOrName resolves the plain key or the matching
    // compound '<lib>-<key>' form. Compound form with a wrong library returns
    // null, mirroring the real utils function's strict compound lookup.
    (getCollectionByIdOrName as any).mockImplementation((input: string | number, _libId?: number) => {
        if (typeof input !== 'string') return null;
        if (input === mockCollection.key) {
            return { collection: mockCollection, libraryID: mockCollection.libraryID };
        }
        const m = input.match(/^(\d+)-(.+)$/);
        if (m && parseInt(m[1], 10) === mockCollection.libraryID && m[2] === mockCollection.key) {
            return { collection: mockCollection, libraryID: mockCollection.libraryID };
        }
        return null;
    });
});


describe('validateManageCollectionsAction', () => {
    it('rejects empty collection_key', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r1',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: '  ', new_name: 'x' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_collection_key');
    });

    it('rejects when collection not found in any searchable library', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r2',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: 'ZZZZ9999' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('collection_not_found');
    });

    it('rejects rename with empty new_name', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r3',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: mockCollection.key, new_name: '' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_new_name');
    });

    it('rejects rename to same name', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r4',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: mockCollection.key, new_name: 'Original' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_new_name');
    });

    it('rejects move into self', async () => {
        // new_parent_key exists; we simulate it by having getByLibraryAndKeyAsync return the same collection
        Zot.Collections.getByLibraryAndKeyAsync.mockImplementation(async (_lib: number, _key: string) => mockCollection);
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r5',
            action_type: 'manage_collections',
            action_data: { action: 'move', collection_key: mockCollection.key, new_parent_key: mockCollection.key },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_parent');
    });

    it('rejects move into own descendant (cycle)', async () => {
        const descendant = { id: 99, key: 'WXYZ5678' };
        // Return the collection for its own key; return a different descendant for the parent key
        Zot.Collections.getByLibraryAndKeyAsync.mockImplementation(async (_lib: number, key: string) => {
            if (key === mockCollection.key) return mockCollection;
            if (key === descendant.key) return descendant;
            return null;
        });
        mockCollection.getDescendents.mockReturnValue([{ id: descendant.id }]);
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r6',
            action_type: 'manage_collections',
            action_data: { action: 'move', collection_key: mockCollection.key, new_parent_key: descendant.key },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_parent');
    });

    it('accepts move to top-level (new_parent_key=null) and emits normalized plain keys', async () => {
        mockCollection.parentKey = 'SOMEPRNT';
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7',
            action_type: 'manage_collections',
            action_data: { action: 'move', collection_key: mockCollection.key, new_parent_key: null },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.normalized_action_data?.library_id).toBe(1);
        // collection_key is normalized to the resolved 8-char key (same as input here)
        expect(resp.normalized_action_data?.collection_key).toBe(mockCollection.key);
        // move emits new_parent_key explicitly so the backend can persist it
        expect(resp.normalized_action_data?.new_parent_key).toBeNull();
    });

    it('accepts compound <lib>-<key> collection_key and normalizes to plain key', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7b',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: `1-${mockCollection.key}`, new_name: 'Updated' },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.normalized_action_data?.library_id).toBe(1);
        expect(resp.normalized_action_data?.collection_key).toBe(mockCollection.key);
        // getCollectionByIdOrName receives the raw compound + the embedded
        // libraryId as the scope — compound lookup is strict inside utils.
        expect((getCollectionByIdOrName as any)).toHaveBeenCalledWith(`1-${mockCollection.key}`, 1);
    });

    it('rejects when compound collection_key library disagrees with separate library_id', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7b2',
            action_type: 'manage_collections',
            action_data: {
                action: 'rename',
                // Compound points to library 2, but library_id says 1 — conflict.
                collection_key: `2-${mockCollection.key}`,
                new_name: 'Updated',
                library_id: 1,
            },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_library_id');
        // The resolver must not be invoked when the consistency check fails.
        expect((getCollectionByIdOrName as any)).not.toHaveBeenCalled();
    });

    it('accepts compound collection_key when separate library_id matches', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7b3',
            action_type: 'manage_collections',
            action_data: {
                action: 'rename',
                collection_key: `1-${mockCollection.key}`,
                new_name: 'Updated',
                library_id: 1,
            },
        } as any);
        expect(resp.valid).toBe(true);
    });

    it('rejects compound new_parent_key from a different library', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7c',
            action_type: 'manage_collections',
            action_data: {
                action: 'move',
                collection_key: mockCollection.key,
                // mockCollection is in library 1; passing a compound pointing to lib 2 must fail
                new_parent_key: `2-${mockCollection.key}`,
            },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_parent');
    });

    it('accepts compound new_parent_key from the same library and normalizes to plain key', async () => {
        const parentKey = 'PRNT0000';
        const parentCollection = { id: 42, key: parentKey, libraryID: 1 };
        // getCollectionByIdOrName resolves the child; parent is looked up via getByLibraryAndKeyAsync
        Zot.Collections.getByLibraryAndKeyAsync.mockImplementation(async (_lib: number, key: string) => {
            if (key === parentKey) return parentCollection;
            return null;
        });
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7d',
            action_type: 'manage_collections',
            action_data: {
                action: 'move',
                collection_key: mockCollection.key,
                new_parent_key: `1-${parentKey}`,
            },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.normalized_action_data?.new_parent_key).toBe(parentKey);
    });

    it('passes explicit library_id through as a scope hint to getCollectionByIdOrName', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7e',
            action_type: 'manage_collections',
            action_data: {
                action: 'rename',
                collection_key: mockCollection.key,
                new_name: 'Updated',
                library_id: 1,
            },
        } as any);
        expect(resp.valid).toBe(true);
        expect((getCollectionByIdOrName as any)).toHaveBeenCalledWith(mockCollection.key, 1);
    });

    it('rejects no-op move (same parent)', async () => {
        mockCollection.parentKey = null;
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r8',
            action_type: 'manage_collections',
            action_data: { action: 'move', collection_key: mockCollection.key, new_parent_key: null },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('no_change');
    });

    it('reports delete preview info in current_value but does NOT emit snapshot via normalized_action_data', async () => {
        mockCollection.getChildItems.mockReturnValue([101, 102, 103]);
        mockCollection.hasChildCollections.mockReturnValue(false);
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r9',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: mockCollection.key },
        } as any);
        expect(resp.valid).toBe(true);
        // Preview in current_value (for the approval card)
        expect(resp.current_value?.old_item_count).toBe(3);
        // Snapshots are captured at execute time; not sent via normalized_action_data.
        expect(resp.normalized_action_data?.old_item_ids).toBeUndefined();
        expect(resp.normalized_action_data?.old_name).toBeUndefined();
        expect(resp.normalized_action_data?.library_id).toBe(1);
    });

    it('rejects delete when the collection has subcollections, listing each child with name/key/item_count', async () => {
        const child1 = {
            id: 21,
            key: 'CHILD001',
            name: 'Methods',
            getChildItems: vi.fn(() => [201, 202, 203] as number[]),
        };
        const child2 = {
            id: 22,
            key: 'CHILD002',
            name: 'Results',
            getChildItems: vi.fn(() => [] as number[]),
        };
        mockCollection.hasChildCollections.mockReturnValue(true);
        mockCollection.getChildCollections.mockReturnValue([child1, child2]);

        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r10',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: mockCollection.key },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('has_subcollections');
        // Error must include child name + key + item count so the agent can act.
        expect(resp.error).toContain("'Methods'");
        expect(resp.error).toContain('CHILD001');
        expect(resp.error).toContain('3 items');
        expect(resp.error).toContain("'Results'");
        expect(resp.error).toContain('CHILD002');
        expect(resp.error).toContain('0 items');
        // eraseTx must NOT have been called from validation.
        expect(mockCollection.eraseTx).not.toHaveBeenCalled();
    });
});


describe('executeManageCollectionsAction', () => {
    const ctx: any = { signal: { aborted: false }, timeoutSeconds: 25, startTime: Date.now() };

    it('rename calls saveTx, returns old_name snapshot in result_data', async () => {
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e1',
            action_type: 'manage_collections',
            action_data: {
                action: 'rename',
                collection_key: mockCollection.key,
                new_name: 'Final',
                library_id: 1,
            },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(mockCollection.name).toBe('Final');
        expect(mockCollection.saveTx).toHaveBeenCalled();
        // Snapshot returned in result_data (captured at execute time)
        expect(resp.result_data?.old_name).toBe('Original');
    });

    it('move sets parentKey=false for top-level, captures old_parent_key in result_data', async () => {
        mockCollection.parentKey = 'SOMEPRNT';
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e2',
            action_type: 'manage_collections',
            action_data: {
                action: 'move',
                collection_key: mockCollection.key,
                new_parent_key: null,
                library_id: 1,
            },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(mockCollection.parentKey).toBe(false);
        expect(resp.result_data?.old_parent_key).toBe('SOMEPRNT');
    });

    it('delete re-snapshots items at execute time and returns them in result_data', async () => {
        mockCollection.getChildItems.mockReturnValue([42, 43]);
        mockCollection.hasChildCollections.mockReturnValue(false);
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e3',
            action_type: 'manage_collections',
            action_data: {
                action: 'delete',
                collection_key: mockCollection.key,
                library_id: 1,
            },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(mockCollection.eraseTx).toHaveBeenCalled();
        expect(resp.result_data?.items_affected).toBe(2);
        expect(resp.result_data?.old_item_ids).toHaveLength(2);
    });

    it('refuses delete at execute time if subcollections appeared between validate and execute', async () => {
        // Subcollections weren't there at validate but show up now (race / manual edit).
        const child = {
            id: 31,
            key: 'CHILD777',
            name: 'AddedLater',
            getChildItems: vi.fn(() => [] as number[]),
        };
        mockCollection.hasChildCollections.mockReturnValue(true);
        mockCollection.getChildCollections.mockReturnValue([child]);
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e3b',
            action_type: 'manage_collections',
            action_data: {
                action: 'delete',
                collection_key: mockCollection.key,
                library_id: 1,
            },
        } as any, ctx);
        expect(resp.success).toBe(false);
        expect(resp.error_code).toBe('has_subcollections');
        expect(mockCollection.eraseTx).not.toHaveBeenCalled();
    });

    it('fails when library_id is missing', async () => {
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e4',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: mockCollection.key, new_name: 'x' },
        } as any, ctx);
        expect(resp.success).toBe(false);
        expect(resp.error_code).toBe('invalid_library_id');
    });

    it('fails when collection not found at execute time', async () => {
        Zot.Collections.getByLibraryAndKeyAsync.mockImplementation(async () => null);
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e5',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: mockCollection.key, library_id: 1 },
        } as any, ctx);
        expect(resp.success).toBe(false);
        expect(resp.error_code).toBe('collection_not_found');
    });
});
