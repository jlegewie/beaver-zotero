/**
 * Unit tests for manage_collections validate + execute handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    isLibrarySearchable: vi.fn(() => true),
    getSearchableLibraries: vi.fn(() => [{ library_id: 1, name: 'My Library' }]),
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

const Zot = (globalThis as any).Zotero;


beforeEach(() => {
    vi.clearAllMocks();
    // Reset collection state
    mockCollection.name = 'Original';
    mockCollection.parentKey = null;
    mockCollection.getChildItems.mockReturnValue([]);
    mockCollection.hasChildCollections.mockReturnValue(false);
    mockCollection.getDescendents.mockReturnValue([]);
    mockCollection.saveTx.mockReset();
    mockCollection.eraseTx.mockReset();
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

    it('accepts move to top-level (new_parent_key=null)', async () => {
        mockCollection.parentKey = 'SOMEPRNT';
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7',
            action_type: 'manage_collections',
            action_data: { action: 'move', collection_key: mockCollection.key, new_parent_key: null },
        } as any);
        expect(resp.valid).toBe(true);
        // normalized_action_data only carries resolved library_id; move target
        // flows through the original action_data unchanged.
        expect(resp.normalized_action_data?.library_id).toBe(1);
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
        mockCollection.hasChildCollections.mockReturnValue(true);
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r9',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: mockCollection.key },
        } as any);
        expect(resp.valid).toBe(true);
        // Preview in current_value (for the approval card)
        expect(resp.current_value?.old_item_count).toBe(3);
        expect(resp.current_value?.had_subcollections).toBe(true);
        // Snapshots are captured at execute time; not sent via normalized_action_data.
        expect(resp.normalized_action_data?.old_item_ids).toBeUndefined();
        expect(resp.normalized_action_data?.old_name).toBeUndefined();
        expect(resp.normalized_action_data?.library_id).toBe(1);
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
        expect(resp.result_data?.had_subcollections).toBe(false);
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
