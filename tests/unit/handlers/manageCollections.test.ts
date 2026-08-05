/**
 * Unit tests for manage_collections validate + execute handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fixture state the faked collection resolver reads. Library 1 is the personal
// library; library 200 ("g67890") is local but excluded from Beaver.
const harness = vi.hoisted(() => ({
    collections: [] as any[],
    libraryRefs: { 1: 'u', 100: 'g12345', 200: 'g67890' } as Record<number, string>,
    libraryNames: { 1: 'My Library', 100: 'Group A', 200: 'Group B' } as Record<number, string>,
    searchableLibraryIds: [1, 100] as number[],
}));

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const { createCollectionResolverFake } = await import('../../helpers/collectionResolverFake');
    const fake = createCollectionResolverFake(harness);
    return {
        getDeferredToolPreference: vi.fn(() => 'always_ask'),
        isLibrarySearchable: vi.fn(fake.isLibrarySearchable),
        checkLibraryExcluded: vi.fn(() => null),
        excludedLibraryMessage: vi.fn((id: number) => `Library ${id} is excluded from Beaver.`),
        getSearchableLibraryIds: vi.fn(fake.getSearchableLibraryIds),
        parseScopedCollectionId: vi.fn(fake.parseScopedCollectionId),
        resolveSingleCollection: vi.fn(fake.resolveSingleCollection),
        resolveCollectionForWrite: vi.fn(fake.resolveCollectionForWrite),
    };
});

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

// Mutable fixtures for the mocked Zotero globals
const mockCollection: any = {
    id: 10,
    libraryID: 1,
    name: 'Original',
    key: 'ABCD2345',
    parentKey: null,
    deleted: false,
    saveTx: vi.fn(async () => undefined),
    eraseTx: vi.fn(async () => undefined),
    getChildItems: vi.fn(() => [] as number[]),
    hasChildCollections: vi.fn(() => false),
    getChildCollections: vi.fn(() => [] as any[]),
    getDescendents: vi.fn(() => [] as Array<{ id: number }>),
};

/** Lives in the excluded library, so only a scoped identifier can name it. */
const excludedCollection: any = { id: 90, libraryID: 200, name: 'Excluded', key: 'EXCL2345' };

(globalThis as any).Zotero = {
    ...((globalThis as any).Zotero ?? {}),
    Libraries: {
        get: vi.fn(() => ({ libraryID: 1, name: 'My Library', editable: true })),
        getAll: vi.fn(() => [{ libraryID: 1, name: 'My Library', editable: true }]),
        userLibraryID: 1,
    },
    Groups: {
        getGroupIDFromLibraryID: vi.fn((libraryID: number) => (libraryID === 100 ? 12345 : libraryID === 200 ? 67890 : false)),
        getLibraryIDFromGroupID: vi.fn((groupID: number) => (groupID === 12345 ? 100 : groupID === 67890 ? 200 : false)),
    },
    Collections: {
        getByLibraryAndKeyAsync: vi.fn(async (_libraryID: number, key: string) => {
            return key === mockCollection.key ? mockCollection : null;
        }),
    },
    Items: {
        getAsync: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, key: `KEY${id}` }))),
        loadDataTypes: vi.fn(async () => undefined),
        // Default: a key resolves to no item. The not-a-collection path
        // overrides this per-test with .mockImplementation().
        getByLibraryAndKeyAsync: vi.fn(async () => null),
    },
    Utilities: {
        isValidObjectKey: vi.fn((key: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)),
    },
};

import {
    validateManageCollectionsAction,
    executeManageCollectionsAction,
} from '../../../src/services/agentDataProvider/actions/manageCollections';
import { resolveCollectionForWrite } from '../../../src/services/agentDataProvider/utils';

const Zot = (globalThis as any).Zotero;


beforeEach(() => {
    vi.clearAllMocks();
    // Reset collection state
    mockCollection.name = 'Original';
    mockCollection.parentKey = null;
    mockCollection.deleted = false;
    mockCollection.getChildItems.mockReturnValue([]);
    mockCollection.hasChildCollections.mockReturnValue(false);
    mockCollection.getChildCollections.mockReturnValue([]);
    mockCollection.getDescendents.mockReturnValue([]);
    mockCollection.saveTx.mockReset();
    mockCollection.eraseTx.mockReset();
    harness.collections = [mockCollection, excludedCollection];
    harness.searchableLibraryIds = [1, 100];
    // Re-install default getByLibraryAndKeyAsync (individual tests may override
    // it with .mockImplementation(), which persists across tests otherwise).
    Zot.Collections.getByLibraryAndKeyAsync.mockImplementation(async (_libraryID: number, key: string) => {
        return key === mockCollection.key ? mockCollection : null;
    });
    // Default: a missed collection key is not an item either (.mockImplementation
    // on this persists across tests, so re-install the default each time).
    Zot.Items.getByLibraryAndKeyAsync.mockImplementation(async () => null);
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

    it('reports not_a_collection when the key belongs to a library item', async () => {
        // A frequent agent error: passing a note/item key to this
        // collection-only tool. The collection lookup misses, but the key
        // resolves to an item, so the response names the object type.
        Zot.Items.getByLibraryAndKeyAsync.mockImplementation(async () => ({
            isAnnotation: () => false,
            isAttachment: () => false,
            isNote: () => true,
            isRegularItem: () => false,
        }));
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r2b',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: '1-KYBU83VK' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('not_a_collection');
        expect(resp.error).toContain('note');
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
        const descendant = { id: 99, key: 'WXYZ5678', libraryID: 1, name: 'Descendant' };
        harness.collections.push(descendant);
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
        // The raw identifier reaches the resolver, which is authoritative for
        // the library it embeds; with no library parameter the request does not
        // constrain the scope.
        expect((resolveCollectionForWrite as any)).toHaveBeenCalledWith(`1-${mockCollection.key}`, {
            eligibleLibraryIds: [1, 100],
            explicitLibrary: false,
        });
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
        expect((resolveCollectionForWrite as any)).not.toHaveBeenCalled();
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

    it('accepts portable "u-<key>" collection_key and normalizes to plain key', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7f',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: `u-${mockCollection.key}`, new_name: 'Updated' },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.normalized_action_data?.library_id).toBe(1);
        expect(resp.normalized_action_data?.collection_key).toBe(mockCollection.key);
        expect((resolveCollectionForWrite as any)).toHaveBeenCalledWith(`u-${mockCollection.key}`, {
            eligibleLibraryIds: [1, 100],
            explicitLibrary: false,
        });
    });

    it('rejects when portable collection_key library disagrees with separate library_id', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7f2',
            action_type: 'manage_collections',
            action_data: {
                action: 'rename',
                // "u" resolves to library 1, but library_id says 2 — conflict.
                collection_key: `u-${mockCollection.key}`,
                new_name: 'Updated',
                library_id: 2,
            },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_library_id');
    });

    it('accepts portable new_parent_key from the same library and normalizes to plain key', async () => {
        const parentKey = 'PRNT2345';
        harness.collections.push({ id: 43, key: parentKey, libraryID: 1, name: 'Parent' });
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7g',
            action_type: 'manage_collections',
            action_data: {
                action: 'move',
                collection_key: mockCollection.key,
                new_parent_key: `u-${parentKey}`,
            },
        } as any);
        expect(resp.valid).toBe(true);
        expect(resp.normalized_action_data?.new_parent_key).toBe(parentKey);
    });

    it('rejects a new_parent_key naming an unresolvable portable group ref instead of silently treating the whole string as a key', async () => {
        // Group 5 isn't on this device, so the identifier names no local
        // library — a cross-library/unavailable reference, not a literal key.
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7h',
            action_type: 'manage_collections',
            action_data: {
                action: 'move',
                collection_key: mockCollection.key,
                new_parent_key: 'g5-PRNT2345',
            },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_parent');
        expect(resp.error).toContain('not available on this computer');
        // The malformed-whole-string lookup must never have been attempted.
        expect((resolveCollectionForWrite as any)).not.toHaveBeenCalledWith('g5-PRNT2345', expect.anything());
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
        const parentKey = 'PRNT2346';
        harness.collections.push({ id: 42, key: parentKey, libraryID: 1, name: 'Parent' });
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

    it('treats an explicit library_id as a hard scope for the collection reference', async () => {
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
        expect((resolveCollectionForWrite as any)).toHaveBeenCalledWith(mockCollection.key, {
            eligibleLibraryIds: [1],
            explicitLibrary: true,
        });
    });

    it('rejects a collection name that resolves cleanly, and names the identifier to use instead', async () => {
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7i',
            action_type: 'manage_collections',
            action_data: { action: 'rename', collection_key: 'Original', new_name: 'Updated' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error).toContain('u-ABCD2345');
        expect(resp.error).toContain('list_collections');
        expect(mockCollection.saveTx).not.toHaveBeenCalled();
    });

    it('rejects a new_parent_key given as a collection name', async () => {
        harness.collections.push({ id: 44, key: 'PRNT2347', libraryID: 1, name: 'Parent By Name' });
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7j',
            action_type: 'manage_collections',
            action_data: { action: 'move', collection_key: mockCollection.key, new_parent_key: 'Parent By Name' },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('invalid_parent');
        expect(resp.error).toContain('u-PRNT2347');
    });

    it('reports a scoped identifier from an excluded library as not searchable, not as missing', async () => {
        // The identifier names its library explicitly, so acknowledging the
        // exclusion leaks nothing — and "not found" would send the model
        // looking for a collection that exists.
        const resp = await validateManageCollectionsAction({
            event: 'agent_action_validate',
            request_id: 'r7k',
            action_type: 'manage_collections',
            action_data: { action: 'delete', collection_key: `g67890-${excludedCollection.key}` },
        } as any);
        expect(resp.valid).toBe(false);
        expect(resp.error_code).toBe('library_not_searchable');
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
        // Validate must be side-effect-free.
        expect(mockCollection.saveTx).not.toHaveBeenCalled();
        expect(mockCollection.deleted).toBe(false);
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

    it('delete soft-deletes via collection.deleted=true + saveTx, and never calls eraseTx', async () => {
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
        expect(mockCollection.deleted).toBe(true);
        expect(mockCollection.saveTx).toHaveBeenCalled();
        expect(mockCollection.eraseTx).not.toHaveBeenCalled();
        expect(resp.result_data?.items_affected).toBe(2);
        // old_item_ids has been removed from the result shape; confirm absence.
        expect((resp.result_data as any)?.old_item_ids).toBeUndefined();
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
        expect(mockCollection.saveTx).not.toHaveBeenCalled();
        expect(mockCollection.deleted).toBe(false);
        expect(mockCollection.eraseTx).not.toHaveBeenCalled();
    });

    it('resolves a scoped collection identifier and parent at execute time', async () => {
        // An action can reach execute without the validation that normalizes
        // these to bare keys, so both must still resolve here.
        const parent: any = { id: 11, libraryID: 1, name: 'Parent', key: 'PRNT2345' };
        harness.collections.push(parent);
        const resp = await executeManageCollectionsAction({
            event: 'agent_action_execute',
            request_id: 'e6',
            action_type: 'manage_collections',
            action_data: {
                action: 'move',
                collection_key: `u-${mockCollection.key}`,
                new_parent_key: `u-${parent.key}`,
                library_id: 1,
            },
        } as any, ctx);
        expect(resp.success).toBe(true);
        expect(mockCollection.parentKey).toBe(parent.key);
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
        // The collection disappeared between validation and execution.
        harness.collections = harness.collections.filter(c => c.key !== mockCollection.key);
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
