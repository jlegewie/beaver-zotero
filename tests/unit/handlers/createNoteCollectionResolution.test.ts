/** Note validation resolves collections before applying a default library. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 100]) },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

vi.mock('../../../src/utils/noteCitationExpand', () => ({ preloadNotePageLabels: vi.fn() }));
vi.mock('../../../src/utils/noteEditorIO', () => ({ getLatestNoteHtml: vi.fn() }));
vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({ getOrSimplify: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/lookupZoteroReferences', () => ({ lookupZoteroReferences: vi.fn() }));

import { validateCreateNoteAction } from '../../../src/services/agentDataProvider/actions/createNote';
const personal = { id: 10, libraryID: 1, key: 'USER2345', name: 'Shared' };
const group = { id: 20, libraryID: 7, key: 'GROUP234', name: 'Group only' };
let previous: any;
let collections: any[];
beforeEach(() => {
    previous = (globalThis as any).Zotero;
    collections = [personal, group, { id: 21, libraryID: 7, key: 'OTHER234', name: 'Shared' }];
    const libraries = [{ libraryID: 1, name: 'Personal', editable: true }, { libraryID: 7, name: 'Group', editable: true }];
    (globalThis as any).Zotero = {
        Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
        Libraries: { userLibraryID: 1, userLibrary: libraries[0], getAll: () => libraries, get: (id: number) => libraries.find(l => l.libraryID === id) },
        Groups: { getLibraryIDFromGroupID: (id: number) => id === 12345 ? 7 : false, getGroupIDFromLibraryID: (id: number) => id === 7 ? 12345 : false },
        Collections: {
            get: (id: number) => collections.find(c => c.id === id),
            getByLibraryAndKey: (id: number, key: string) => collections.find(c => c.libraryID === id && c.key === key),
            getByLibrary: (id: number) => collections.filter(c => c.libraryID === id),
        },
        Utilities: { isValidObjectKey: (key: string) => /^[A-Z0-9]{8}$/.test(key) },
    };
});
afterEach(() => { (globalThis as any).Zotero = previous; });
const validate = (data: any) => validateCreateNoteAction({
    event: 'agent_action_validate', request_id: 'r', action_type: 'create_note',
    action_data: { title: 'Note', content: 'Body', ...data },
    operation: { preference: () => 'always_ask' },
} as any);

it.each(['g12345-GROUP234', 'GROUP234', 'Group only'])('infers a group target from %s without an explicit library', async collection => {
    const result = await validate({ collections: [collection] });
    expect(result.valid).toBe(true);
    expect(result.normalized_action_data).toMatchObject({ library_id: 7, library_ref: 'g12345', collection_keys: ['GROUP234'] });
});
it('rejects an ambiguous name instead of using the default library to settle it', async () => {
    await expect(validate({ collections: ['Shared'] })).rejects.toMatchObject({ code: 'ambiguous_collection' });
    expect((await validate({ library_id: 1, collections: ['Shared'] })).normalized_action_data).toMatchObject({ library_id: 1, collection_keys: ['USER2345'] });
});
it('requires memberships in one library and respects an explicit library', async () => {
    await expect(validate({ collections: ['USER2345', 'GROUP234'] })).rejects.toMatchObject({ code: 'library_collection_mismatch' });
    await expect(validate({ library_id: 1, collections: ['g12345-GROUP234'] })).rejects.toMatchObject({ code: 'library_collection_mismatch' });
});
it('uses the default only when no parent or collection determines the library', async () => {
    expect((await validate({})).normalized_action_data).toMatchObject({ library_id: 1, collection_keys: [] });
});
it('checks exclusions and editability on the inferred target', async () => {
    (globalThis as any).Zotero.Libraries.get(7).editable = false;
    expect(await validate({ collections: ['GROUP234'] })).toMatchObject({ valid: false, error_code: 'library_not_editable' });
    (globalThis as any).Zotero.Beaver.searchableLibraryIds = [1];
    await expect(validate({ collections: ['g12345-GROUP234'] })).rejects.toMatchObject({ code: 'library_not_searchable' });
});
it('can infer an allowed group even when the personal default is excluded', async () => {
    (globalThis as any).Zotero.Beaver.searchableLibraryIds = [7];
    expect((await validate({ collections: ['GROUP234'] })).normalized_action_data?.library_id).toBe(7);
});

it('retains the parent library and ignores direct memberships for child notes', async () => {
    (globalThis as any).Zotero.Items = { getByLibraryAndKeyAsync: async () => ({
        libraryID: 7, key: 'PARENT23', isRegularItem: () => true,
    }) };
    const result = await validate({ parent_item_id: 'g12345-PARENT23', collections: ['Missing'] });
    expect(result.normalized_action_data).toMatchObject({ library_id: 7, parent_key: 'PARENT23', collection_keys: [] });
    expect(await validate({ parent_item_id: 'g12345-PARENT23', library_id: 1 })).toMatchObject({ valid: false, error_code: 'library_collection_mismatch' });
});

import { executeCreateNoteAction } from '../../../src/services/agentDataProvider/actions/createNote';
import * as manualNote from '../../../src/services/manualActions/createNoteActions';

it.each(['automatic', 'manual'])('keeps note memberships fixed from approval through %s execution and undo', async route => {
    const created: any[] = [];
    (Zotero as any).Item = function () {
        const note: any = { key: 'NOTEKEY1', setNote: vi.fn(), addTag: vi.fn(),
            addToCollection: vi.fn(), saveTx: vi.fn(async () => 100), eraseTx: vi.fn() };
        created.push(note);
        return note;
    };
    (Zotero as any).Items = { getByLibraryAndKeyAsync: async () => created[0] };
    const prepared = await validate({ library_ref: 'g12345', collections: ['Group only'] });
    const target = collections.find(c => c.key === 'GROUP234');
    const oldName = target.name;
    target.name = 'Renamed';
    collections.push({ id: 22, libraryID: 7, key: 'NEWKEY12', name: 'Group only' });
    const data = prepared.normalized_action_data!;
    const context = { renderMarkdown: async (html: string) => html };
    try {
        const result = route === 'manual'
            ? await manualNote.executeCreateNoteAction({ proposed_data: data } as any, undefined, context)
            : (await executeCreateNoteAction({ request_id: 'r', action_data: data, operation: context } as any,
                { signal: new AbortController().signal, timeoutSeconds: 60, startTime: Date.now() })).result_data;
        expect(created[0].addToCollection).toHaveBeenCalledExactlyOnceWith(target.id);
        expect(result).toMatchObject({ collection_keys: ['GROUP234'], collection_ids: ['g12345-GROUP234'] });
        await manualNote.undoCreateNoteAction({ result_data: result } as any);
        expect(created[0].eraseTx).toHaveBeenCalledOnce();
    } finally { target.name = oldName; }
});

it('saves the note unfiled when an approved membership was deleted', async () => {
    const prepared = await validate({ library_ref: 'g12345', collections: ['Group only'] });
    collections = collections.filter(c => c.key !== 'GROUP234');
    const save = vi.fn();
    const addToCollection = vi.fn();
    (Zotero as any).Item = function () { return { setNote: vi.fn(), saveTx: save, addToCollection, libraryID: 7, key: 'NOTEKEY1' }; };
    const result = await executeCreateNoteAction({ request_id: 'r', action_data: prepared.normalized_action_data,
        operation: { renderMarkdown: async (html: string) => html } } as any,
        { signal: new AbortController().signal, timeoutSeconds: 60, startTime: Date.now() });
    expect(result).toMatchObject({ success: true });
    expect(save).toHaveBeenCalledOnce();
    expect(addToCollection).not.toHaveBeenCalled();
});
