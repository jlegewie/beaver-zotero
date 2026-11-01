import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => false }));
vi.mock('../../../src/utils/backgroundTasks', () => ({ isPdfFetchInProgress: () => true, cancelTasksForItem: vi.fn() }));
vi.mock('../../../src/utils/pdfResolvers', () => ({ buildPdfResolvers: vi.fn() }));
vi.mock('../../../src/services/pdfAttachmentFetch', () => ({ fetchPdfAttachment: vi.fn() }));
vi.mock('../../../src/utils/batchFindExistingReferences', () => ({ batchFindExistingReferences: async () => ({ results: [], timing: { total_ms: 0 } }) }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({ getDeferredToolPreference: () => 'always_ask', checkLibraryExcluded: () => null, excludedLibraryMessage: () => 'Unavailable' }));
import { applyCreateItemData, createZoteroItem } from '../../../src/services/itemImport/legacy';
import { validateCreateItemAction, executeCreateItemAction } from '../../../src/services/agentDataProvider/actions/createItems';
import { executeCreateItemAction as manualExecute, undoCreateItemAction } from '../../../src/services/manualActions/createItemActions';

let collections: any[];
let created: any[];
beforeEach(() => {
    collections = [{ id: 10, libraryID: 1, key: 'SAMEKEY1', name: 'Inbox' }, { id: 20, libraryID: 7, key: 'SAMEKEY1', name: 'Inbox' }];
    created = [];
    vi.stubGlobal('Zotero', {
        Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
        Libraries: { userLibraryID: 1, get: (libraryID: number) => ({ libraryID, editable: true }) },
        Groups: { getLibraryIDFromGroupID: () => 7, getGroupIDFromLibraryID: () => 12345 },
        Collections: {
            get: (id: number) => collections.find(c => c.id === id),
            getByLibrary: (id: number) => collections.filter(c => c.libraryID === id),
            getByLibraryAndKey: (id: number, key: string) => collections.find(c => c.libraryID === id && c.key === key),
        },
        Items: { getByLibraryAndKeyAsync: async () => created[0] },
        ItemTypes: { getID: () => 1, getName: () => 'document' },
        Item: function () {
            const row = { key: 'ITEMKEY1', libraryID: 7, getField: () => '', setField: vi.fn(), getAttachments: () => [],
                getCollections: () => [], setCollections: vi.fn(), saveTx: vi.fn(), eraseTx: vi.fn() };
            created.push(row); return row;
        },
    });
});

it.each(['automatic', 'manual'])('resolves memberships before approval and preserves them through %s import and undo', async route => {
    const validation = await validateCreateItemAction({ request_id: 'r', action_data: {
        library_ref: 'g12345', collections: ['Inbox'], items: [{ source_id: 'source' }],
    } } as any);
    expect(validation.normalized_action_data).toMatchObject({ collection_keys: ['SAMEKEY1'], collection_ids: ['g12345-SAMEKEY1'] });
    collections[1].name = 'Renamed';
    collections.push({ id: 21, libraryID: 7, key: 'OTHERKEY', name: 'Inbox' });
    const data = { ...validation.normalized_action_data, item: { title: 'Paper' } };
    const result = route === 'manual' ? await manualExecute({ proposed_data: data } as any)
        : (await executeCreateItemAction({ request_id: 'r', action_data: data } as any,
            { signal: new AbortController().signal, timeoutSeconds: 60, startTime: Date.now() })).result_data;
    expect(created[0].setCollections).toHaveBeenCalledWith([20]);
    expect(result).toMatchObject({ collection_ids: ['g12345-SAMEKEY1'], collection_keys: ['SAMEKEY1'] });
    await undoCreateItemAction({ result_data: result } as any);
    expect(created[0].eraseTx).toHaveBeenCalledOnce();
});

it('creates the item without an approved membership that no longer exists', async () => {
    collections.pop();
    const result = await applyCreateItemData({ item: { title: 'Paper' }, collection_ids: ['g12345-SAMEKEY1'] } as any, { libraryId: 7 });
    expect(result).toMatchObject({ collection_ids: [], collection_keys: [] });
    expect(created).toHaveLength(1);
    expect(created[0].eraseTx).not.toHaveBeenCalled();
    expect(created[0].setCollections).not.toHaveBeenCalled();
});
it('rejects native context collections belonging to another library before import', async () => {
    await expect(createZoteroItem({ title: 'Paper' } as any, { libraryId: 7, collectionId: 10 }))
        .rejects.toMatchObject({ code: 'library_collection_mismatch' });
    expect(created).toEqual([]);
});
it('rejects cross-library memberships at validation', async () => {
    await expect(validateCreateItemAction({ request_id: 'r', action_data: {
        library_ref: 'g12345', collections: ['u-SAMEKEY1'], items: [{ source_id: 'source' }],
    } } as any)).rejects.toMatchObject({ code: 'library_collection_mismatch' });
});

it.each(['identifier', 'url', 'manual'])('removes a %s import if its context collection disappears during creation', async route => {
    mockImportWithDeletedCollection(route);
    await expect(createZoteroItem(importReference(route), { libraryId: 7, collectionId: 20 }))
        .rejects.toMatchObject({ code: 'collection_not_found' });
    expect(created).toHaveLength(1);
    expect(created[0].eraseTx).toHaveBeenCalledOnce();
});

it.each(['identifier', 'url', 'manual'])('keeps a %s import unfiled if a proposed membership disappears during creation', async route => {
    mockImportWithDeletedCollection(route);
    await applyCreateItemData({ item: importReference(route), collection_ids: ['g12345-SAMEKEY1'] } as any, { libraryId: 7 });
    expect(created).toHaveLength(1);
    expect(created[0].eraseTx).not.toHaveBeenCalled();
    expect(created[0].setCollections).not.toHaveBeenCalled();
});

it('removes the new item when saving post-processing fails', async () => {
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row = new Item('document');
        vi.mocked(row.saveTx).mockResolvedValueOnce(100).mockRejectedValueOnce(new Error('Save failed'));
        return row;
    } as any;
    await expect(applyCreateItemData({ item: { title: 'Paper' } } as any, { libraryId: 7 }))
        .rejects.toThrow('Save failed');
    expect(created[0].eraseTx).toHaveBeenCalledOnce();
});

/** Tags the item has in the database, as read back after a post-processing save. */
function storedTags(...reads: string[][]) {
    const queue = [...reads];
    return vi.fn(async (_sql: string, _params: unknown[], opts?: { onRow?: (row: any) => void }) => {
        for (const name of queue.shift() ?? []) opts?.onRow?.({ getResultByIndex: () => name });
    });
}

it('repairs a stale tag cache and saves the post-processing again', async () => {
    const init = vi.fn(async () => {});
    Object.assign(Zotero, {
        Tags: { init },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()), queryAsync: storedTags(['ethnobotany']) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.addTag = vi.fn();
        vi.mocked(row.saveTx)
            .mockResolvedValueOnce(100)
            .mockRejectedValueOnce(new Error('Error(s) encountered during statement execution: FOREIGN KEY constraint failed '
                + '[QUERY: INSERT OR REPLACE INTO itemTags (itemID, tagID, type) VALUES (?, ?, ?)] [PARAMS: 417, 210, 0]'))
            .mockResolvedValueOnce(100);
        return row;
    } as any;
    await applyCreateItemData({ item: { title: 'Paper' }, suggested_tags: ['ethnobotany'] } as any, { libraryId: 7 });
    expect(init).toHaveBeenCalledOnce();
    // Zotero reloads an item whose save failed, so the tag is applied again.
    expect(created[0].addTag).toHaveBeenCalledTimes(2);
    expect(created[0].saveTx).toHaveBeenCalledTimes(3);
    expect(created[0].eraseTx).not.toHaveBeenCalled();
});

it('does not retry post-processing into a library excluded while the tag cache was rebuilt', async () => {
    Object.assign(Zotero, {
        Tags: { init: vi.fn(async () => { (Zotero as any).Beaver.searchableLibraryIds = [1]; }) },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.addTag = vi.fn();
        vi.mocked(row.saveTx)
            .mockResolvedValueOnce(100)
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed: tags.name [QUERY: INSERT INTO tags (tagID, name) VALUES (?, ?)]'));
        return row;
    } as any;
    await expect(applyCreateItemData({ item: { title: 'Paper' }, suggested_tags: ['ethnobotany'] } as any, { libraryId: 7 }))
        .rejects.toThrow('Library is excluded or unavailable');
    expect(created[0].saveTx).toHaveBeenCalledTimes(2);
    // The item this import created is removed, as for any failed post-processing.
    expect(created[0].eraseTx).toHaveBeenCalledOnce();
});

it('does not retry post-processing once the caller cancelled', async () => {
    Object.assign(Zotero, {
        Tags: { init: vi.fn(async () => {}) },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.addTag = vi.fn();
        vi.mocked(row.saveTx)
            .mockResolvedValueOnce(100)
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed: tags.name [QUERY: INSERT INTO tags (tagID, name) VALUES (?, ?)]'));
        return row;
    } as any;
    const assertCurrent = vi.fn(() => { throw new Error('Operation cancelled'); });
    await expect(applyCreateItemData({ item: { title: 'Paper' }, suggested_tags: ['ethnobotany'] } as any, { libraryId: 7, assertCurrent }))
        .rejects.toThrow('Operation cancelled');
    expect(created[0].saveTx).toHaveBeenCalledTimes(2);
});

it('does not retry a manually applied item once the account changed during the tag cache rebuild', async () => {
    let generation = 1;
    (Zotero as any).Beaver.account = { getGeneration: () => generation };
    Object.assign(Zotero, {
        Tags: { init: vi.fn(async () => { generation = 2; }) },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.addTag = vi.fn();
        vi.mocked(row.saveTx)
            .mockResolvedValueOnce(100)
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed: tags.name [QUERY: INSERT INTO tags (tagID, name) VALUES (?, ?)]'));
        return row;
    } as any;
    await expect(manualExecute({ id: 'a', proposed_data: { library_ref: 'g12345', item: { title: 'Paper' }, suggested_tags: ['ethnobotany'] } } as any))
        .rejects.toThrow('Account changed');
    expect(created[0].saveTx).toHaveBeenCalledTimes(2);
});

it('retries when another save discarded the tags without raising an error', async () => {
    // Another plugin saved this item object first, failed on the stale tag, and
    // Zotero reloaded it: our own save then succeeds with nothing to write.
    const init = vi.fn(async () => {});
    Object.assign(Zotero, {
        Tags: { init },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()), queryAsync: storedTags([], ['ethnobotany']) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.id = 42;
        row.addTag = vi.fn();
        return row;
    } as any;
    await applyCreateItemData({ item: { title: 'Paper' }, suggested_tags: [' ethnobotany '] } as any, { libraryId: 7 });
    expect(init).toHaveBeenCalledOnce();
    expect(created[0].addTag).toHaveBeenCalledTimes(2);
    expect(created[0].eraseTx).not.toHaveBeenCalled();
});

it('fails instead of reporting success when the tags are still missing after the retry', async () => {
    Object.assign(Zotero, {
        Tags: { init: vi.fn(async () => {}) },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()), queryAsync: storedTags([], []) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.id = 42;
        row.addTag = vi.fn();
        return row;
    } as any;
    await expect(applyCreateItemData({ item: { title: 'Paper' }, suggested_tags: ['ethnobotany'] } as any, { libraryId: 7 }))
        .rejects.toThrow('Requested tags were not saved on item 42: ethnobotany');
    expect(created[0].eraseTx).toHaveBeenCalledOnce();
});

it('does not retry a card-applied item once the account changed during the tag cache rebuild', async () => {
    // The create_item card calls applyCreateItemData directly, with no checkpoint of its own.
    let generation = 1;
    (Zotero as any).Beaver.account = { getGeneration: () => generation };
    Object.assign(Zotero, {
        Tags: { init: vi.fn(async () => { generation = 2; }) },
        DB: { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()) },
    });
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row: any = new Item('document');
        row.addTag = vi.fn();
        vi.mocked(row.saveTx)
            .mockResolvedValueOnce(100)
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed: tags.name [QUERY: INSERT INTO tags (tagID, name) VALUES (?, ?)]'));
        return row;
    } as any;
    await expect(applyCreateItemData({ item: { title: 'Paper' }, suggested_tags: ['ethnobotany'] } as any, { libraryId: 7 }))
        .rejects.toThrow('Account changed');
    expect(created[0].saveTx).toHaveBeenCalledTimes(2);
});

function importReference(route: string): any {
    return { title: 'Paper', ...(route === 'identifier' ? { identifiers: { doi: '10.1234/example' } }
        : route === 'url' ? { url: 'https://example.org/paper' } : {}) };
}

function mockImportWithDeletedCollection(route: string): void {
    const Item = Zotero.Item;
    Zotero.Item = function () {
        const row = new Item('document');
        vi.mocked(row.saveTx).mockImplementation(async () => {
            collections = collections.filter(c => c.id !== 20);
            return 100;
        });
        return row;
    } as any;
    const translate = async () => {
        const row = new Zotero.Item('document');
        await row.saveTx();
        return [row];
    };
    if (route === 'identifier') {
        (Zotero as any).Translate = { Search: function () {
            return { setIdentifier: vi.fn(), getTranslators: async () => [{}], setTranslator: vi.fn(), translate };
        } };
    } else if (route === 'url') {
        vi.stubGlobal('ChromeUtils', { importESModule: () => ({
            HiddenBrowser: function () { return { load: vi.fn(), destroy: vi.fn() }; },
            RemoteTranslate: function () { return { setBrowser: vi.fn(), detect: async () => [{}], translate }; },
        }) });
    }
}
