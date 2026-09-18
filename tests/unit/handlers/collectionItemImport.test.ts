import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => false }));
vi.mock('../../../src/utils/backgroundTasks', () => ({ isPdfFetchInProgress: () => true, cancelTasksForItem: vi.fn() }));
vi.mock('../../../src/utils/pdfResolvers', () => ({ buildPdfResolvers: vi.fn() }));
vi.mock('../../../src/services/pdfAttachmentFetch', () => ({ fetchPdfAttachment: vi.fn() }));
vi.mock('../../../src/utils/batchFindExistingReferences', () => ({ batchFindExistingReferences: async () => ({ results: [], timing: { total_ms: 0 } }) }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({ getDeferredToolPreference: () => 'always_ask', checkLibraryExcluded: () => null, excludedLibraryMessage: () => 'Unavailable' }));
import { applyCreateItemData, createZoteroItem } from '../../../src/services/itemImport';
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

it('fails an absent approved membership before creating an item', async () => {
    collections.pop();
    await expect(applyCreateItemData({ item: { title: 'Paper' }, collection_ids: ['g12345-SAMEKEY1'] } as any, { libraryId: 7 }))
        .rejects.toMatchObject({ code: 'collection_not_found' });
    expect(created).toEqual([]);
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

it.each(['identifier', 'url', 'manual'])('removes a %s import if a proposed membership disappears during creation', async route => {
    mockImportWithDeletedCollection(route);
    await expect(applyCreateItemData({ item: importReference(route), collection_ids: ['g12345-SAMEKEY1'] } as any, { libraryId: 7 }))
        .rejects.toMatchObject({ code: 'collection_not_found' });
    expect(created).toHaveLength(1);
    expect(created[0].eraseTx).toHaveBeenCalledOnce();
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
