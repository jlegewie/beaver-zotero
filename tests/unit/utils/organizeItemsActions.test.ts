/**
 * Unit tests for the manual apply + undo path of organize_items
 * (react/utils/organizeItemsActions.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fixture state the faked collection resolver reads.
const harness = vi.hoisted(() => ({
    collections: [] as any[],
    libraryRefs: { 1: 'u' } as Record<number, string>,
    libraryNames: { 1: 'My Library' } as Record<number, string>,
    searchableLibraryIds: [1] as number[],
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const { createCollectionResolverFake } = await import('../../helpers/collectionResolverFake');
    const fake = createCollectionResolverFake(harness);
    return { resolveCollectionForWrite: vi.fn(fake.resolveCollectionForWrite) };
});

import { executeOrganizeItemsAction, undoOrganizeItemsAction } from '../../../react/utils/organizeItemsActions';
import { resolveCollectionForWrite } from '../../../src/services/agentDataProvider/utils';

const READING = { id: 11, key: 'RLKEY234', libraryID: 1, name: 'Reading List' };
const INBOX = { id: 12, key: 'INBXKEY2', libraryID: 1, name: 'Inbox' };

function makeItem(key: string, collectionIds: number[] = []) {
    return {
        libraryID: 1,
        key,
        collectionIds: [...collectionIds],
        isTopLevelItem: () => true,
        getTags: () => [],
        getCollections() { return this.collectionIds; },
        addTag: vi.fn(),
        removeTag: vi.fn(),
        addToCollection: vi.fn(),
        removeFromCollection: vi.fn(),
        saveTx: vi.fn().mockResolvedValue(undefined),
    };
}

let items: Record<string, ReturnType<typeof makeItem>>;

beforeEach(() => {
    vi.clearAllMocks();
    harness.collections = [READING, INBOX];
    items = {};
    (globalThis as any).Zotero = {
        Libraries: { userLibraryID: 1 },
        Collections: { get: vi.fn((id: number) => harness.collections.find((c) => c.id === id) ?? null) },
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async (_libraryID: number, key: string) => items[key] ?? null),
        },
    };
});

describe('executeOrganizeItemsAction', () => {
    it('accepts a scoped collection identifier and records the bare key', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2');

        const result = await executeOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                collections: { add: ['u-RLKEY234'] },
            },
        } as any);

        expect(items.ITEMKEY2.addToCollection).toHaveBeenCalledWith(READING.id);
        // result_data feeds undo, which compares against bare snapshot keys.
        expect(result.collections_added).toEqual(['RLKEY234']);
    });

    it('resolves each distinct collection reference once across the batch', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2');
        items.ITEMKEY3 = makeItem('ITEMKEY3');
        items.ITEMKEY4 = makeItem('ITEMKEY4');

        await executeOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2', 'u-ITEMKEY3', 'u-ITEMKEY4'],
                collections: { add: ['RLKEY234', 'INBXKEY2'] },
            },
        } as any);

        expect(vi.mocked(resolveCollectionForWrite)).toHaveBeenCalledTimes(2);
    });

    // A bare string has a `length`, so iterating one writes a single-letter tag or
    // collection key per character to every item in the batch. This path applies
    // persisted proposed_data without re-validating, so it must not iterate one.
    it('surfaces a bare-string tags container without writing one tag per character', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2');

        await expect(executeOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                tags: { add: 'urgent' },
            },
        } as any)).rejects.toThrow(/"tags\.add" must be a list/);

        expect(items.ITEMKEY2.addTag).not.toHaveBeenCalled();
    });

    it('surfaces a bare-string collections container without resolving each character', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2');

        await expect(executeOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                collections: { add: 'RLKEY234' },
            },
        } as any)).rejects.toThrow(/"collections\.add" must be a list/);

        expect(items.ITEMKEY2.addToCollection).not.toHaveBeenCalled();
    });

    // A malformed persisted list must surface as a failure; reporting an applied
    // action with nothing done would tell the user the change went through.
    it.each([
        ['a bare string', 'u-ITEMKEY2'],
        ['null', null],
        ['an empty list', []],
    ])('surfaces %s item_ids instead of reporting an applied action', async (_label, item_ids) => {
        await expect(executeOrganizeItemsAction({
            proposed_data: { item_ids, tags: { add: ['urgent'] } },
        } as any)).rejects.toThrow(/"item_ids" must be a non-empty list/);
    });

    it('processes the usable item ids and reports the rest as failures', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2');

        const result = await executeOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2', 12345],
                tags: { add: ['urgent'] },
            },
        } as any);

        expect(items.ITEMKEY2.addTag).toHaveBeenCalledWith('urgent');
        expect(result.failed_items).toMatchObject({ '12345': 'Invalid item id' });
    });

    it('skips a collection reference that only matches a collection name', async () => {
        // A stored reference is a key or identifier. If the key is gone and a
        // different collection happens to carry it as its name, the write must
        // not land there.
        harness.collections = [{ id: 13, key: 'OTHRKEY2', libraryID: 1, name: 'RLKEY234' }];
        items.ITEMKEY2 = makeItem('ITEMKEY2');

        const result = await executeOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                collections: { add: ['RLKEY234'] },
            },
        } as any);

        expect(items.ITEMKEY2.addToCollection).not.toHaveBeenCalled();
        expect(result.collections_added).toBeUndefined();
    });
});

describe('undoOrganizeItemsAction', () => {
    it('compares the action\'s collection references against the bare snapshot keys', async () => {
        // The item was already in Reading List before the action ran, so undo
        // must leave it there — even though the action names it by identifier.
        items.ITEMKEY2 = makeItem('ITEMKEY2', [READING.id, INBOX.id]);
        const currentState = { 'u-ITEMKEY2': { tags: [], collections: ['RLKEY234'] } };

        await undoOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                collections: { add: ['u-RLKEY234', 'u-INBXKEY2'] },
                current_state: currentState,
            },
        } as any);

        expect(items.ITEMKEY2.removeFromCollection).toHaveBeenCalledExactlyOnceWith(INBOX.id);
        // Undo is a no-change surface for the snapshot itself.
        expect(currentState).toEqual({ 'u-ITEMKEY2': { tags: [], collections: ['RLKEY234'] } });
    });

    it('re-adds a removed collection named by identifier when the snapshot held it', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2');

        await undoOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                collections: { remove: ['u-RLKEY234'] },
                current_state: { 'u-ITEMKEY2': { tags: [], collections: ['RLKEY234'] } },
            },
        } as any);

        expect(items.ITEMKEY2.addToCollection).toHaveBeenCalledExactlyOnceWith(READING.id);
    });

    it('reverses the bare keys in result_data when no snapshot is available', async () => {
        items.ITEMKEY2 = makeItem('ITEMKEY2', [READING.id]);

        await undoOrganizeItemsAction({
            proposed_data: {
                item_ids: ['u-ITEMKEY2'],
                collections: { add: ['u-RLKEY234'] },
            },
            result_data: { items_modified: 1, collections_added: ['RLKEY234'] },
        } as any);

        expect(items.ITEMKEY2.removeFromCollection).toHaveBeenCalledExactlyOnceWith(READING.id);
    });
});
