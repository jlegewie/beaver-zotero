/**
 * Unit tests for the manual-apply (UI approval) manage_collections path.
 *
 * This path is the twin of the agent-side execute handler and must resolve
 * collection references the same way: Zotero's `parentKey` setter runs its
 * value through `checkKey`, which throws a bare "key is not valid" for anything
 * that isn't an 8-character key, so a scoped identifier has to be resolved
 * before it is assigned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    collections: [] as any[],
    libraryRefs: { 1: 'u', 100: 'g12345' } as Record<number, string>,
    libraryNames: { 1: 'My Library', 100: 'Group A' } as Record<number, string>,
    searchableLibraryIds: [1, 100] as number[],
}));

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const { createCollectionResolverFake } = await import('../../helpers/collectionResolverFake');
    const fake = createCollectionResolverFake(harness);
    return {
        resolveCollectionForWrite: vi.fn(fake.resolveCollectionForWrite),
        resolveSingleCollection: vi.fn(fake.resolveSingleCollection),
        getSearchableLibraryIds: vi.fn(fake.getSearchableLibraryIds),
        isLibrarySearchable: vi.fn(fake.isLibrarySearchable),
    };
});

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

/** The collection being moved. */
const target: any = {
    id: 10,
    libraryID: 1,
    name: 'Target',
    key: 'ABCD2345',
    parentKey: null,
    deleted: false,
    saveTx: vi.fn(async () => undefined),
    getChildItems: vi.fn(() => [] as number[]),
    hasChildCollections: vi.fn(() => false),
    getChildCollections: vi.fn(() => [] as any[]),
};

/** The move destination, named by the agent as a scoped identifier. */
const newParent: any = { id: 11, libraryID: 1, name: 'New Parent', key: 'PRNT2345' };

(globalThis as any).Zotero = {
    ...((globalThis as any).Zotero ?? {}),
    Libraries: {
        get: vi.fn(() => ({ libraryID: 1, name: 'My Library', editable: true })),
        getAll: vi.fn(() => [{ libraryID: 1, name: 'My Library', editable: true }]),
        userLibraryID: 1,
    },
    Groups: {
        getGroupIDFromLibraryID: vi.fn((libraryID: number) => (libraryID === 100 ? 12345 : false)),
        getLibraryIDFromGroupID: vi.fn((groupID: number) => (groupID === 12345 ? 100 : false)),
    },
    Utilities: {
        isValidObjectKey: vi.fn((key: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)),
    },
};

import { executeManageCollectionsAction } from '../../../react/utils/manageCollectionsActions';

const moveAction = (newParentKey: string | null) => ({
    proposed_data: {
        library_id: 1,
        action: 'move',
        collection_key: 'ABCD2345',
        new_parent_key: newParentKey,
    },
} as any);

beforeEach(() => {
    harness.collections = [target, newParent];
    target.parentKey = null;
    target.saveTx.mockClear();
});

describe('executeManageCollectionsAction (manual apply) — move', () => {
    it('resolves a scoped identifier before assigning parentKey', async () => {
        const result = await executeManageCollectionsAction(moveAction('u-PRNT2345'));

        // A raw "u-PRNT2345" here would reach Zotero's checkKey and throw.
        expect(target.parentKey).toBe('PRNT2345');
        // result_data must hold the bare key, which is what undo and the
        // backend expect to read back.
        expect(result).toMatchObject({ new_parent_key: 'PRNT2345' });
    });

    it('accepts a bare key unchanged', async () => {
        const result = await executeManageCollectionsAction(moveAction('PRNT2345'));

        expect(target.parentKey).toBe('PRNT2345');
        expect(result).toMatchObject({ new_parent_key: 'PRNT2345' });
    });

    it('promotes to top level when no parent is given', async () => {
        const result = await executeManageCollectionsAction(moveAction(null));

        // Zotero uses `false` to signal top-level.
        expect(target.parentKey).toBe(false);
        expect(result).toMatchObject({ new_parent_key: null });
    });

    it('reports a typed failure instead of letting Zotero throw "key is not valid"', async () => {
        await expect(executeManageCollectionsAction(moveAction('u-NOSUCH23')))
            .rejects.toThrow(/NOSUCH23/);
        expect(target.saveTx).not.toHaveBeenCalled();
    });

    it('rejects a collection name, which cannot identify a single move target', async () => {
        await expect(executeManageCollectionsAction(moveAction('New Parent')))
            .rejects.toThrow(/collection name/);
        expect(target.saveTx).not.toHaveBeenCalled();
    });
});
