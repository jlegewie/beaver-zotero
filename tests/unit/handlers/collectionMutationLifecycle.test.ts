import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: () => 'always_ask',
    checkLibraryExcluded: () => null,
    isLibrarySearchable: (id: number) => Zotero.Beaver.searchableLibraryIds.includes(id),
    excludedLibraryMessage: () => 'Library unavailable',
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { validateCreateCollectionAction, executeCreateCollectionAction } from '../../../src/services/agentDataProvider/actions/createCollection';
import { validateManageCollectionsAction, executeManageCollectionsAction } from '../../../src/services/agentDataProvider/actions/manageCollections';
import { validateOrganizeItemsAction, executeOrganizeItemsAction } from '../../../src/services/agentDataProvider/actions/organizeItems';
import * as manualCreate from '../../../src/services/manualActions/createCollectionActions';
import * as manualManage from '../../../src/services/manualActions/manageCollectionsActions';
import * as manualOrganize from '../../../src/services/manualActions/organizeItemsActions';
import { toAgentAction } from '@beaver/agent-core/agents/agentActionTypes';

let collections: any[];
let items: any[];
let groupLibrary: number;
let libraries: any[];
const context = () => ({ signal: new AbortController().signal, timeoutSeconds: 60, startTime: Date.now() });
const request = (action_data: any) => ({ request_id: 'test', action_data } as any);
const action = (action_type: string, proposed_data: any, result_data?: any) => toAgentAction({ action_type, proposed_data, result_data });

function collection(libraryID: number, key: string, name: string) {
    const row: any = { libraryID, key, name, id: collections.length + 10, parentKey: null, deleted: false,
        saveTx: vi.fn(async () => row.id),
        eraseTx: vi.fn(async () => { collections = collections.filter(entry => entry !== row); }),
        hasChildCollections: () => collections.some(entry => entry.parentKey === key && !entry.deleted),
        getChildCollections: () => collections.filter(entry => entry.parentKey === key && !entry.deleted),
        getDescendents: () => collections.filter(entry => entry.parentKey === key),
        getChildItems: () => [], addItems: vi.fn(),
    };
    collections.push(row);
    return row;
}
function item(libraryID: number, key: string) {
    const memberships: number[] = [];
    const row = { id: items.length + 100, key, libraryID, memberships,
        isTopLevelItem: () => true, isRegularItem: () => true,
        isAttachment: () => false, isNote: () => false, isAnnotation: () => false,
        getTags: () => [], getCollections: () => [...memberships],
        addToCollection: (id: number) => { if (!memberships.includes(id)) memberships.push(id); },
        removeFromCollection: (id: number) => { const i = memberships.indexOf(id); if (i >= 0) memberships.splice(i, 1); },
        save: vi.fn(), saveTx: vi.fn(), loadDataType: vi.fn(), setTags: vi.fn(), setCollections: vi.fn(),
    };
    items.push(row);
    return row;
}
beforeEach(() => {
    collections = []; items = []; groupLibrary = 7;
    libraries = [1, 7].map(libraryID => ({ libraryID, editable: true, name: `Library ${libraryID}` }));
    vi.stubGlobal('Zotero', {
        Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
        Libraries: { userLibraryID: 1, get: (id: number) => libraries.find(l => l.libraryID === id), getAll: () => libraries },
        Groups: { getLibraryIDFromGroupID: () => groupLibrary, getGroupIDFromLibraryID: (id: number) => id === groupLibrary ? 12345 : false },
        Collections: {
            get: (id: number) => collections.find(c => c.id === id),
            getByLibrary: (id: number) => collections.filter(c => c.libraryID === id),
            getByLibraryAndKey: (id: number, key: string) => collections.find(c => c.libraryID === id && c.key === key),
            getByLibraryAndKeyAsync: async (id: number, key: string) => collections.find(c => c.libraryID === id && c.key === key),
        },
        Collection: function (params: any) { return Object.assign(collection(params.libraryID, 'NEWCOLL1', params.name), params); },
        Items: { getByLibraryAndKeyAsync: async (id: number, key: string) => items.find(i => i.libraryID === id && i.key === key), loadDataTypes: vi.fn() },
        DB: { executeTransaction: async (fn: () => unknown) => fn() },
    });
    collection(1, 'SAMEKEY1', 'Inbox');
    collection(7, 'SAMEKEY1', 'Inbox');
});

describe('collection mutation identity lifecycle', () => {
    it.each(['automatic', 'manual'])('pins a named parent before approval (%s)', async route => {
        const raw = { library_ref: 'g12345', parent_key: 'Inbox', name: 'New' };
        const validation = await validateCreateCollectionAction(request(raw));
        expect(validation.normalized_action_data).toMatchObject({ parent_key: 'SAMEKEY1', parent_collection_id: 'g12345-SAMEKEY1' });
        collections[1].name = 'Renamed';
        collection(7, 'OTHERKEY', 'Inbox');
        const data = { ...raw, ...validation.normalized_action_data };
        const result = route === 'manual'
            ? await manualCreate.executeCreateCollectionAction(action('create_collection', data))
            : (await executeCreateCollectionAction(request(data), context())).result_data;
        expect(result).toMatchObject({ collection_key: 'NEWCOLL1', collection_id: 'g12345-NEWCOLL1', library_ref: 'g12345' });
        expect(collections.find(c => c.key === 'NEWCOLL1').parentID).toBe(collections[1].id);
        await manualCreate.undoCreateCollectionAction(action('create_collection', data, result));
        expect(collections.some(c => c.key === 'NEWCOLL1')).toBe(false);
    });

    it('infers a create library only when its parent is unconstrained', async () => {
        const result = await validateCreateCollectionAction(request({ parent_key: 'g12345-SAMEKEY1', name: 'New' }));
        expect(result.normalized_action_data?.library_ref).toBe('g12345');
        await expect(validateCreateCollectionAction(request({ library_ref: 'u', parent_key: 'g12345-SAMEKEY1', name: 'New' })))
            .rejects.toMatchObject({ code: 'library_collection_mismatch' });
    });

    it('does not substitute a same-named parent deleted after approval', async () => {
        const validation = await validateCreateCollectionAction(request({ library_ref: 'g12345', parent_key: 'Inbox', name: 'New' }));
        collections[1].deleted = true;
        collection(7, 'OTHERKEY', 'Inbox');
        await expect(manualCreate.executeCreateCollectionAction(action('create_collection', { name: 'New', ...validation.normalized_action_data })))
            .rejects.toMatchObject({ code: 'collection_not_found' });
        expect(collections.some(c => c.key === 'NEWCOLL1')).toBe(false);
    });

    it.each(['automatic', 'manual'])('renames the approved target and snapshots each reapply (%s)', async route => {
        const raw = { library_ref: 'g12345', collection_key: 'Inbox', action: 'rename', new_name: 'Sorted' };
        const validation = await validateManageCollectionsAction(request(raw));
        const data = { ...raw, ...validation.normalized_action_data };
        collections[1].name = 'Manual edit';
        collection(7, 'OTHERKEY', 'Inbox');
        const result = route === 'manual'
            ? await manualManage.executeManageCollectionsAction(action('manage_collections', data))
            : (await executeManageCollectionsAction(request(data), context())).result_data;
        expect(collections[0].name).toBe('Inbox');
        expect(collections[1].name).toBe('Sorted');
        expect(result?.old_name).toBe('Manual edit');
        await manualManage.undoManageCollectionsAction(action('manage_collections', data, result));
        expect(collections[1].name).toBe('Manual edit');
        collections[1].name = 'Second edit';
        const reapplied = await manualManage.executeManageCollectionsAction(action('manage_collections', data));
        expect(reapplied.old_name).toBe('Second edit');
    });

    it('restores only the recorded trashed collection, with access rechecked', async () => {
        const data = { library_ref: 'g12345', library_id: 999, collection_id: 'g12345-SAMEKEY1', action: 'delete' };
        const result = await manualManage.executeManageCollectionsAction(action('manage_collections', data));
        expect(collections[1].deleted).toBe(true);
        await manualManage.undoManageCollectionsAction(action('manage_collections', data, result));
        expect(collections[1].deleted).toBe(false);
        Zotero.Beaver.searchableLibraryIds = [1];
        await expect(manualManage.executeManageCollectionsAction(action('manage_collections', data))).rejects.toMatchObject({ code: 'library_not_searchable' });
    });

    it('resolves the approved group identity on another device', async () => {
        const validation = await validateManageCollectionsAction(request({ library_ref: 'g12345', collection_key: 'Inbox', action: 'rename', new_name: 'Sorted' }));
        groupLibrary = 55;
        collections[1].libraryID = 55;
        libraries[1].libraryID = 55;
        Zotero.Beaver.searchableLibraryIds = [1, 55];
        const result = await manualManage.executeManageCollectionsAction(action('manage_collections', { ...validation.normalized_action_data, action: 'rename', new_name: 'Sorted' }));
        expect(result).toMatchObject({ library_id: 55, collection_id: 'g12345-SAMEKEY1' });
        expect(collections[0].name).toBe('Inbox');
    });

    it.each(['automatic', 'manual'])('files into the item library and undoes exact memberships (%s)', async route => {
        const target = item(7, 'ITEMKEY1');
        const raw = { item_ids: ['g12345-ITEMKEY1'], collections: { add: ['Inbox'] } };
        const validation = await validateOrganizeItemsAction(request(raw));
        expect(validation.valid).toBe(true);
        const data = { ...raw, ...validation.normalized_action_data, current_state: validation.current_value };
        collections[1].name = 'Renamed';
        collection(7, 'OTHERKEY', 'Inbox');
        const result = route === 'manual'
            ? await manualOrganize.executeOrganizeItemsAction(action('organize_items', data))
            : (await executeOrganizeItemsAction(request(data), context())).result_data;
        expect(target.memberships).toEqual([collections[1].id]);
        await manualOrganize.undoOrganizeItemsAction(action('organize_items', data, result));
        expect(target.memberships).toEqual([]);
    });

    it('rejects a cross-library membership before approving or writing', async () => {
        const target = item(7, 'ITEMKEY1');
        const raw = { item_ids: ['g12345-ITEMKEY1'], collections: { add: ['u-SAMEKEY1'] } };
        expect((await validateOrganizeItemsAction(request(raw))).error_code).toBe('library_collection_mismatch');
        await expect(manualOrganize.executeOrganizeItemsAction(action('organize_items', raw))).rejects.toMatchObject({ code: 'library_collection_mismatch' });
        expect(target.memberships).toEqual([]);
    });
});

it.each(['deleted', 'read-only', 'excluded'])('refuses an approved manual membership when the destination becomes %s', async change => {
    const target = item(7, 'ITEMKEY1');
    const prepared = await validateOrganizeItemsAction(request({ item_ids: ['g12345-ITEMKEY1'], collections: { add: ['Inbox'] } }));
    if (change === 'deleted') collections[1].deleted = true;
    if (change === 'read-only') libraries[1].editable = false;
    if (change === 'excluded') Zotero.Beaver.searchableLibraryIds = [1];
    await expect(manualOrganize.executeOrganizeItemsAction(action('organize_items', prepared.normalized_action_data))).rejects.toThrow();
    expect(target.saveTx).not.toHaveBeenCalled();
    expect(target.memberships).toEqual([]);
});

it('rechecks move cycles introduced after approval and refuses invalid restore parents', async () => {
    const parent = collection(7, 'PARENT12', 'Parent');
    const prepared = await validateManageCollectionsAction(request({ library_ref: 'g12345', collection_key: 'SAMEKEY1', action: 'move', new_parent_key: 'PARENT12' }));
    parent.parentKey = 'SAMEKEY1';
    const data = { ...prepared.normalized_action_data, action: 'move' };
    await expect(manualManage.executeManageCollectionsAction(action('manage_collections', data))).rejects.toThrow(/descendant/);
    expect(collections[1].saveTx).not.toHaveBeenCalled();
    parent.parentKey = null;
    const result = await manualManage.executeManageCollectionsAction(action('manage_collections', data));
    expect(result).toMatchObject({ new_parent_key: 'PARENT12', new_parent_collection_id: 'g12345-PARENT12' });
    await manualManage.undoManageCollectionsAction(action('manage_collections', data, result));
    expect(collections[1].parentKey).toBe(false);
});

it.each(['execution snapshot', 'proposed snapshot', 'legacy result'])('leaves cached tags and memberships untouched when undo membership validation fails (%s)', async source => {
    const row = item(7, 'ITEMKEY1');
    const tags = new Set(['added']);
    Object.assign(row, {
        getTags: () => [...tags].map(tag => ({ tag })),
        addTag: vi.fn((tag: string) => tags.add(tag)),
        removeTag: vi.fn((tag: string) => tags.delete(tag)),
    });
    row.memberships.push(collections[1].id);
    const removed = collection(7, 'REMOVED1', 'Removed');
    removed.deleted = true;
    const snapshot = { 'g12345-ITEMKEY1': { tags: ['removed'], collections: ['REMOVED1'] } };
    const data = {
        item_ids: ['g12345-ITEMKEY1'],
        tags: { add: ['added'], remove: ['removed'] },
        collections: { add: ['SAMEKEY1'], remove: ['REMOVED1'] },
        ...(source === 'proposed snapshot' ? { current_state: snapshot } : {}),
    };
    const result = source === 'execution snapshot' ? { current_state: snapshot } : source === 'legacy result'
        ? { tags_added: ['added'], tags_removed: ['removed'], collections_added: ['SAMEKEY1'], collections_removed: ['REMOVED1'] }
        : undefined;
    await expect(manualOrganize.undoOrganizeItemsAction(action('organize_items', data, result))).rejects.toThrow();
    expect([...tags]).toEqual(['added']);
    expect(row.memberships).toEqual([collections[1].id]);
    expect(row.saveTx).not.toHaveBeenCalled();
    expect((row as any).addTag).not.toHaveBeenCalled();
    expect((row as any).removeTag).not.toHaveBeenCalled();
});

it.each([[1, 'u'], [7, 'g12345']] as const)('restores tags and collections after organizing repeated item IDs in library %s', async (libraryID, libraryRef) => {
    const row = item(libraryID, 'ITEMKEY1');
    const tags = new Set(['removed', 'unchanged']);
    Object.assign(row, {
        getTags: () => [...tags].map(tag => ({ tag })),
        addTag: (tag: string) => tags.add(tag),
        removeTag: (tag: string) => tags.delete(tag),
    });
    const added = collections.find(c => c.libraryID === libraryID)!;
    const removed = collection(libraryID, 'REMOVED1', 'Removed');
    row.memberships.push(removed.id);
    const itemId = `${libraryRef}-ITEMKEY1`;
    const data = {
        item_ids: [itemId, itemId],
        tags: { add: ['added'], remove: ['removed'] },
        collections: { add: ['SAMEKEY1'], remove: ['REMOVED1'] },
    };
    const result = await manualOrganize.executeOrganizeItemsAction(action('organize_items', data));
    expect(tags).toEqual(new Set(['added', 'unchanged']));
    expect(row.memberships).toEqual([added.id]);
    expect(result.current_state?.[itemId]).toEqual({ tags: ['removed', 'unchanged'], collections: ['REMOVED1'] });
    expect(result.items_modified).toBe(1);
    expect(row.saveTx).toHaveBeenCalledTimes(1);

    await manualOrganize.undoOrganizeItemsAction(action('organize_items', data, result));
    expect(tags).toEqual(new Set(['removed', 'unchanged']));
    expect(row.memberships).toEqual([removed.id]);
    expect(row.saveTx).toHaveBeenCalledTimes(2);
});

it('uses null portable parent fields for manual move and undo despite stale native parents', async () => {
    const parent = collection(7, 'PARENT12', 'Parent');
    const target = collections[1];
    target.parentKey = parent.key;
    const data = { library_ref: 'g12345', collection_id: 'g12345-SAMEKEY1', action: 'move',
        new_parent_collection_id: null, new_parent_key: parent.key };
    await manualManage.executeManageCollectionsAction(action('manage_collections', data));
    expect(target.parentKey).toBe(false);
    target.parentKey = parent.key;
    await manualManage.undoManageCollectionsAction(action('manage_collections', data, {
        old_parent_collection_id: null, old_parent_key: parent.key,
    }));
    expect(target.parentKey).toBe(false);
});

it('applies and undoes manual tag-only edits in an unmapped library without collection preflight', async () => {
    groupLibrary = 99;
    const row = item(7, 'ITEMKEY1');
    const tags = new Set(['original']);
    Object.assign(row, {
        getTags: () => [...tags].map(tag => ({ tag })),
        addTag: (tag: string) => tags.add(tag),
        removeTag: (tag: string) => tags.delete(tag),
    });
    const lookup = vi.spyOn(Zotero.Items, 'getByLibraryAndKeyAsync');
    const collectionLookup = vi.spyOn(Zotero.Collections, 'getByLibraryAndKey');
    const data = { item_ids: ['7-ITEMKEY1'], tags: { add: ['added'], remove: ['original'] } };
    const result = await manualOrganize.executeOrganizeItemsAction(action('organize_items', data));
    expect(tags).toEqual(new Set(['added']));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(collectionLookup).not.toHaveBeenCalled();
    expect(result.collection_ids_added).toBeUndefined();
    expect(result.collection_ids_removed).toBeUndefined();

    await manualOrganize.undoOrganizeItemsAction(action('organize_items', data, result));
    expect(tags).toEqual(new Set(['original']));
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(row.saveTx).toHaveBeenCalledTimes(2);
});

it.each(['excluded', 'read-only'])('keeps manual tag-only apply and undo blocked for an %s library', async restriction => {
    groupLibrary = 99;
    const row = item(7, 'ITEMKEY1');
    Object.assign(row, { addTag: vi.fn(), removeTag: vi.fn() });
    if (restriction === 'excluded') Zotero.Beaver.searchableLibraryIds = [1];
    else libraries[1].editable = false;
    const data = { item_ids: ['7-ITEMKEY1'], tags: { add: ['added'] } };
    await expect(manualOrganize.executeOrganizeItemsAction(action('organize_items', data))).rejects.toThrow();
    await expect(manualOrganize.undoOrganizeItemsAction(action('organize_items', data, { tags_added: ['added'] })))
        .rejects.toThrow();
    expect((row as any).addTag).not.toHaveBeenCalled();
    expect((row as any).removeTag).not.toHaveBeenCalled();
    expect(row.saveTx).not.toHaveBeenCalled();
});

it('still requires portable identity for manual collection changes in an unmapped library', async () => {
    groupLibrary = 99;
    const row = item(7, 'ITEMKEY1');
    const data = { item_ids: ['7-ITEMKEY1'], collections: { add: ['SAMEKEY1'] } };
    await expect(manualOrganize.executeOrganizeItemsAction(action('organize_items', data)))
        .rejects.toMatchObject({ code: 'library_unavailable' });
    expect(row.memberships).toEqual([]);
    expect(row.saveTx).not.toHaveBeenCalled();
});

it.each([1, 7])('undoes legacy create-collection history with a numeric collection ID in library %s', async libraryID => {
    const target = collections.find(c => c.libraryID === libraryID)!;
    const other = collections.find(c => c.libraryID !== libraryID)!;
    const restored = action('create_collection', { library_id: libraryID, name: target.name }, {
        library_id: libraryID, collection_id: target.id, collection_key: target.key,
    });
    await manualCreate.undoCreateCollectionAction(restored);
    expect(target.eraseTx).toHaveBeenCalledOnce();
    expect(other.eraseTx).not.toHaveBeenCalled();
    expect(collections).not.toContain(target);
});
