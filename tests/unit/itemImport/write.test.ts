import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    // zoteroApis
    isApiAvailable: vi.fn(),
    loadWebTranslationModules: vi.fn(),
    looksLikeApiDrift: vi.fn((error: unknown) => error instanceof TypeError),
    markApiUnavailable: vi.fn(),
    withTimeout: vi.fn(async (work: Promise<unknown>) => work),
    // legacy
    filterPdfAttachments: vi.fn(),
    schedulePdfFetchTask: vi.fn(),
    stampBeaverProvenanceExtra: vi.fn(),
    // siblings
    locateImportFile: vi.fn(),
    resolveImportItems: vi.fn(),
    checkUrlAllowed: vi.fn(),
    // utils / services
    cancelTasksForItem: vi.fn(),
    generateTaskId: vi.fn((...parts: unknown[]) => parts.join(':')),
    scheduleBackgroundTask: vi.fn(),
    resolveItemReference: vi.fn(),
    resolveLibraryRef: vi.fn(),
    resolveWriteTargetLibrary: vi.fn(),
    createProvenanceNote: vi.fn(),
    getPref: vi.fn(),
    assertLibraryWritable: vi.fn(),
    recheckExistingCollections: vi.fn(),
    coordinateLibraryMutation: vi.fn(async (work: () => Promise<unknown>) => work()),
    isPdfDocument: vi.fn(),
}));

vi.mock('../../../src/services/itemImport/zoteroApis', () => ({
    isApiAvailable: mocks.isApiAvailable,
    loadWebTranslationModules: mocks.loadWebTranslationModules,
    looksLikeApiDrift: mocks.looksLikeApiDrift,
    markApiUnavailable: mocks.markApiUnavailable,
    withTimeout: mocks.withTimeout,
}));
vi.mock('../../../src/services/itemImport/pdfFetch', () => ({
    filterPdfAttachments: mocks.filterPdfAttachments,
    schedulePdfFetchTask: mocks.schedulePdfFetchTask,
}));
vi.mock('../../../src/services/itemImport/provenance', () => ({
    BEAVER_PROVENANCE_MARKER: 'Added by Beaver',
    stampBeaverProvenanceExtra: mocks.stampBeaverProvenanceExtra,
}));
vi.mock('../../../src/services/itemImport/recognizeFile', () => ({ locateImportFile: mocks.locateImportFile }));
vi.mock('../../../src/services/itemImport/resolve', () => ({ resolveImportItems: mocks.resolveImportItems }));
vi.mock('../../../src/services/itemImport/resolveUrl', () => ({ checkUrlAllowed: mocks.checkUrlAllowed }));
vi.mock('../../../src/services/itemImport/duplicates', () => ({
    WEB_CONTENT_ITEM_TYPES: new Set(['webpage', 'blogPost', 'forumPost', 'newspaperArticle', 'magazineArticle', 'encyclopediaArticle', 'presentation']),
}));
vi.mock('../../../src/utils/backgroundTasks', () => ({
    cancelTasksForItem: mocks.cancelTasksForItem,
    generateTaskId: mocks.generateTaskId,
    scheduleBackgroundTask: mocks.scheduleBackgroundTask,
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : `g${id}`),
    resolveItemReference: mocks.resolveItemReference,
    resolveLibraryRef: mocks.resolveLibraryRef,
    resolveWriteTargetLibrary: mocks.resolveWriteTargetLibrary,
}));
vi.mock('../../../src/utils/noteProvenance', () => ({ createProvenanceNote: mocks.createProvenanceNote }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: mocks.getPref }));
vi.mock('../../../src/services/collections/collectionMutations', () => ({
    assertLibraryWritable: mocks.assertLibraryWritable,
    recheckExistingCollections: mocks.recheckExistingCollections,
}));
vi.mock('../../../src/services/libraryMutations', () => ({ coordinateLibraryMutation: mocks.coordinateLibraryMutation }));
vi.mock('../../../src/utils/attachmentFiles', () => ({ isPdfDocument: mocks.isPdfDocument }));

import type { ImportItemProposedData } from '@beaver/agent-core/types/itemImport';
import { ImportItemError, undoImportItem, writeImportItem } from '../../../src/services/itemImport/write';

const Z = Zotero as any;

/** The JSON the new item was built from. */
const savedJson = () => saved.fromJSON.mock.calls[0][0];

function makeSavedItem(overrides: Record<string, any> = {}) {
    const fields: Record<string, string> = { extra: '' };
    const item: any = {
        id: 500,
        key: 'ITEM0001',
        libraryID: 1,
        deleted: false,
        isNote: () => false,
        isAttachment: () => false,
        getField: vi.fn((name: string) => fields[name] ?? ''),
        setField: vi.fn((name: string, value: string) => { fields[name] = value; }),
        addTag: vi.fn(),
        saveTx: vi.fn(async () => {}),
        save: vi.fn(async () => {}),
        fromJSON: vi.fn(),
        setCollections: vi.fn(),
        eraseTx: vi.fn(async () => {}),
        getAttachments: vi.fn(() => []),
        getNotes: vi.fn(() => []),
        loadDataType: vi.fn(async () => {}),
        numNonHTMLFileAttachments: vi.fn(() => 0),
        ...overrides,
    };
    return item;
}

let saved: any;
let itemCtor: ReturnType<typeof vi.fn>;
let childNotes: any[];
let libraryInfo: { editable: boolean; filesEditable: boolean };
let prefs: Record<string, unknown>;
let apiAvailable: Record<string, boolean>;

const journal = (extra: Partial<ImportItemProposedData> = {}): ImportItemProposedData => ({
    library_id: 1,
    source: { kind: 'identifier', input: 'doi:10.1/x' },
    item: { itemType: 'journalArticle', title: 'Paper', creators: [{ creatorType: 'author', lastName: 'Smith' }] },
    resolution: { method: 'translator', translator: 'CrossRef' },
    ...extra,
});

const file = (mode: 'import' | 'link' = 'import') => ({
    ok: true,
    file: {
        path: '/home/u/papers/a.pdf',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        size: 10,
        ref: { path: '/home/u/papers/a.pdf', mode },
    },
});

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; reset the ones individual tests override.
    mocks.assertLibraryWritable.mockReset();
    mocks.resolveItemReference.mockReset();
    mocks.resolveLibraryRef.mockReset();
    mocks.resolveImportItems.mockReset();
    mocks.locateImportFile.mockReset();
    saved = makeSavedItem();
    itemCtor = vi.fn();
    childNotes = [];
    libraryInfo = { editable: true, filesEditable: true };
    prefs = {};
    apiAvailable = { importFromDocument: true, remoteTranslate: true, attachmentRename: false };

    mocks.isApiAvailable.mockImplementation((name: string) => apiAvailable[name] ?? false);
    mocks.getPref.mockImplementation((name: string) => prefs[name]);
    mocks.resolveWriteTargetLibrary.mockReturnValue({ ok: true, libraryID: 1 });
    mocks.recheckExistingCollections.mockReturnValue([]);
    mocks.filterPdfAttachments.mockResolvedValue([]);
    mocks.stampBeaverProvenanceExtra.mockReturnValue(false);
    mocks.withTimeout.mockImplementation(async (work: Promise<unknown>) => work);
    mocks.coordinateLibraryMutation.mockImplementation(async (work: () => Promise<unknown>) => work());
    mocks.isPdfDocument.mockReturnValue(false);

    Z.Beaver = {
        libraryScopeInitialized: true,
        searchableLibraryIds: [1],
        account: { getGeneration: () => 1 },
    };
    Z.Libraries.get = vi.fn((id: number) => (id === 99 ? undefined : { libraryID: id, ...libraryInfo }));
    Z.Prefs.get = vi.fn((name: string) => prefs[name]);
    Z.Date.dateToISO = vi.fn(() => '2026-10-01T00:00:00Z');
    Z.DB = { executeTransaction: vi.fn(async (work: () => Promise<unknown>) => work()) };
    Z.Collections = { get: vi.fn((id: number) => (id === 20 ? { id: 20, libraryID: 1 } : id === 21 ? { id: 21, libraryID: 7 } : undefined)) };
    // `new Zotero.Item(type)`: the parent is `saved`; child notes are recorded.
    Z.Item = function (type: string) {
        itemCtor(type);
        if (type !== 'note') return saved;
        const note = { setNote: vi.fn(), setTags: vi.fn(), save: vi.fn(async () => {}) } as any;
        childNotes.push(note);
        return note;
    };
    Z.Attachments = {
        importFromFile: vi.fn(async () => makeSavedItem({ id: 600, key: 'FILEKEY1' })),
        linkFromFile: vi.fn(async () => makeSavedItem({ id: 601, key: 'LINKKEY1' })),
        shouldAutoRenameFile: vi.fn(() => true),
        getRenamedFileBaseNameIfAllowedType: vi.fn(async () => 'Smith - Paper'),
    };
    Z.Items = { getAsync: vi.fn(async () => saved) };
});

describe('writeImportItem target checks', () => {
    it('rejects data without a source', async () => {
        await expect(writeImportItem({ item: { itemType: 'book' } } as any)).rejects.toMatchObject({ code: 'missing_item_data' });
    });

    it('fails when the target library cannot be resolved', async () => {
        mocks.resolveWriteTargetLibrary.mockReturnValue({ ok: false, code: 'invalid_library_ref', message: 'bad ref' });
        await expect(writeImportItem(journal())).rejects.toMatchObject({ code: 'invalid_library_ref', message: 'bad ref' });
    });

    it('refuses a library excluded after approval, before any write', async () => {
        Z.Beaver.searchableLibraryIds = [2];
        await expect(writeImportItem(journal())).rejects.toMatchObject({ code: 'library_not_searchable' });
        expect(itemCtor).not.toHaveBeenCalled();
    });

    it('refuses when the library scope is not initialized', async () => {
        Z.Beaver.libraryScopeInitialized = false;
        await expect(writeImportItem(journal())).rejects.toMatchObject({ code: 'library_not_searchable' });
    });

    it('refuses a read-only library', async () => {
        libraryInfo.editable = false;
        await expect(writeImportItem(journal())).rejects.toMatchObject({ code: 'library_not_editable' });
        expect(itemCtor).not.toHaveBeenCalled();
    });

    it('prefers the explicit target library over the action data', async () => {
        Z.Beaver.searchableLibraryIds = [1, 7];
        await writeImportItem(journal({ library_id: 1 }), { libraryId: 7 });
        expect(mocks.resolveWriteTargetLibrary).not.toHaveBeenCalled();
        expect(saved.libraryID).toBe(7);
    });

    it('lets collection and library write guards run before saving', async () => {
        mocks.assertLibraryWritable.mockImplementation(() => { throw Object.assign(new Error('not accessible'), { code: 'library_not_searchable' }); });
        await expect(writeImportItem(journal())).rejects.toMatchObject({ code: 'library_not_searchable' });
        expect(itemCtor).not.toHaveBeenCalled();
    });

    it('runs the caller checkpoint before saving', async () => {
        const assertCurrent = vi.fn(() => { throw new Error('deadline'); });
        await expect(writeImportItem(journal(), { assertCurrent })).rejects.toThrow('deadline');
        expect(itemCtor).not.toHaveBeenCalled();
    });
});

describe('writeImportItem saving', () => {
    it('builds the item from its JSON in one transaction, ignoring attachments', async () => {
        mocks.recheckExistingCollections.mockReturnValue([{ collection: { id: 10 }, collectionId: 'u-COLL0001', key: 'COLL0001' }]);
        const result = await writeImportItem(journal({
            collection_ids: ['u-COLL0001'],
            item: {
                itemType: 'journalArticle',
                title: 'Paper',
                creators: [{ lastName: 'Smith' } as any],
                attachments: [{ url: 'https://x.org/a.pdf' }],
                dateAdded: '2020-01-01',
                key: 'TRANSLAT',
            },
        }));
        expect(itemCtor).toHaveBeenCalledWith('journalArticle');
        expect(saved.libraryID).toBe(1);
        expect(savedJson()).toMatchObject({ itemType: 'journalArticle', title: 'Paper', creators: [{ creatorType: 'author', lastName: 'Smith' }] });
        expect(savedJson()).not.toHaveProperty('attachments');
        expect(savedJson()).not.toHaveProperty('dateAdded');
        expect(savedJson()).not.toHaveProperty('key');
        expect(saved.setCollections).toHaveBeenCalledWith([10]);
        expect(saved.save).toHaveBeenCalledTimes(1);
        expect(Z.DB.executeTransaction).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            library_id: 1,
            library_ref: 'u',
            zotero_key: 'ITEM0001',
            collection_ids: ['u-COLL0001'],
            collection_keys: ['COLL0001'],
        });
    });

    it('saves translator notes as child notes in the same transaction', async () => {
        prefs.automaticTags = true;
        await writeImportItem(journal({
            item: { itemType: 'journalArticle', title: 'Paper', notes: [{ note: '<p>Abstract</p>', tags: [{ tag: 'n' }] } as any] },
        }));
        expect(savedJson()).not.toHaveProperty('notes');
        expect(childNotes).toHaveLength(1);
        expect(childNotes[0]).toMatchObject({ libraryID: 1, parentID: 500 });
        expect(childNotes[0].setNote).toHaveBeenCalledWith('<p>Abstract</p>');
        expect(childNotes[0].setTags).toHaveBeenCalledWith([{ tag: 'n', type: 1 }]);
        expect(childNotes[0].save).toHaveBeenCalledTimes(1);
        expect(Z.DB.executeTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns the created item once the save commits, without waiting for slow observers', async () => {
        vi.useFakeTimers();
        try {
            let observersDone = false;
            // Zotero shape: the transaction runs the work, commits, runs onCommit, then
            // delivers Notifier events.
            Z.DB = {
                executeTransaction: vi.fn(async (work: () => Promise<unknown>, options?: { onCommit?: () => void }) => {
                    const result = await work();
                    options?.onCommit?.();
                    await new Promise((resolve) => setTimeout(resolve, 21_000));
                    observersDone = true;
                    return result;
                }),
            };
            const pending = writeImportItem(journal());
            await vi.advanceTimersByTimeAsync(3000);
            await expect(pending).resolves.toMatchObject({ zotero_key: 'ITEM0001' });
            expect(observersDone).toBe(false);
            await vi.advanceTimersByTimeAsync(18_000);
            expect(observersDone).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('creates the item without a collection deleted after approval and reports it', async () => {
        mocks.recheckExistingCollections.mockReturnValue([{ collection: { id: 10 }, collectionId: 'u-KEPT0001', key: 'KEPT0001' }]);
        const result = await writeImportItem(journal({ collection_ids: ['u-KEPT0001', 'u-GONE0001'] }));
        expect(saved.setCollections).toHaveBeenCalledWith([10]);
        expect(result).toMatchObject({ collection_ids: ['u-KEPT0001'], skipped_collections: ['u-GONE0001'] });
    });

    it('omits skipped collections when every collection still exists', async () => {
        mocks.recheckExistingCollections.mockReturnValue([{ collection: { id: 10 }, collectionId: 'u-COLL0001', key: 'COLL0001' }]);
        const result = await writeImportItem(journal({ collection_ids: ['u-COLL0001'] }));
        expect(result).not.toHaveProperty('skipped_collections');
    });

    it('sets no collections when there are none', async () => {
        await writeImportItem(journal());
        expect(saved.setCollections).not.toHaveBeenCalled();
    });

    it('does not mutate the approved item JSON', async () => {
        const data = journal({ item: { itemType: 'webpage', title: 'Page' }, snapshot_url: 'https://x.org' });
        const before = JSON.stringify(data.item);
        await writeImportItem(data);
        expect(JSON.stringify(data.item)).toBe(before);
    });

    it('adds the context collection only when it belongs to the target library', async () => {
        await writeImportItem(journal(), { collectionId: 20 });
        expect(saved.setCollections).toHaveBeenLastCalledWith([20]);

        saved.setCollections.mockClear();
        await writeImportItem(journal(), { collectionId: 21 });
        expect(saved.setCollections).not.toHaveBeenCalled();
    });

    it('does not duplicate a collection already in the approved memberships', async () => {
        mocks.recheckExistingCollections.mockReturnValue([{ collection: { id: 20 }, collectionId: 'u-C', key: 'C' }]);
        await writeImportItem(journal({ collection_ids: ['u-C'] }), { collectionId: 20 });
        expect(saved.setCollections).toHaveBeenCalledWith([20]);
    });

    it('refuses a standalone note or attachment without writing', async () => {
        await expect(writeImportItem(journal({ item: { itemType: 'note', note: 'x' } })))
            .rejects.toMatchObject({ code: 'invalid_item_type' });
        await expect(writeImportItem(journal({ item: { itemType: 'attachment' } })))
            .rejects.toMatchObject({ code: 'invalid_item_type' });
        expect(itemCtor).not.toHaveBeenCalled();
        expect(Z.DB.executeTransaction).not.toHaveBeenCalled();
    });

    it('propagates a save failure', async () => {
        saved.save.mockRejectedValue(new Error('database locked'));
        await expect(writeImportItem(journal())).rejects.toThrow('database locked');
    });

    it('fills in a translator CURRENT_TIMESTAMP access date', async () => {
        await writeImportItem(journal({ item: { itemType: 'journalArticle', title: 'Paper', accessDate: 'CURRENT_TIMESTAMP' } }));
        expect(savedJson().accessDate).toBe('2026-10-01T00:00:00Z');
    });

    it('sets an access date for web content only', async () => {
        await writeImportItem(journal({ item: { itemType: 'webpage', title: 'Page' } }));
        expect(savedJson().accessDate).toBe('2026-10-01T00:00:00Z');

        saved.fromJSON.mockClear();
        await writeImportItem(journal());
        expect(savedJson()).not.toHaveProperty('accessDate');

        saved.fromJSON.mockClear();
        await writeImportItem(journal({ snapshot_url: 'https://x.org/r', item: { itemType: 'report', title: 'R' } }));
        expect(savedJson().accessDate).toBe('2026-10-01T00:00:00Z');
    });

    it('keeps an access date the item already has', async () => {
        await writeImportItem(journal({ item: { itemType: 'webpage', title: 'Page', accessDate: '2026-09-29' } }));
        expect(savedJson().accessDate).toBe('2026-09-29');
    });
});

describe('writeImportItem finishing touches', () => {
    it('saves the action\'s tags as manual tags in the first save', async () => {
        await writeImportItem(journal({ tags: ['reading', '  ', 'to-cite '] }));
        expect(savedJson().tags).toEqual([
            { tag: 'reading', type: 0 },
            { tag: 'to-cite', type: 0 },
        ]);
        expect(saved.addTag).not.toHaveBeenCalled();
        expect(saved.save).toHaveBeenCalledTimes(1);
        expect(saved.saveTx).not.toHaveBeenCalled();
    });

    it('keeps resolved tags as automatic tags when automatic tags are on', async () => {
        prefs.automaticTags = true;
        await writeImportItem(journal({
            item: { itemType: 'journalArticle', title: 'Paper', tags: [{ tag: 'Sociology' }, { tag: 'reading', type: 0 }, { tag: ' ' }] },
            tags: ['reading'],
        }));
        expect(savedJson().tags).toEqual([
            { tag: 'Sociology', type: 1 },
            { tag: 'reading', type: 0 },
        ]);
    });

    it('lets a manual tag replace an automatic tag that differs only by whitespace or Unicode form', async () => {
        prefs.automaticTags = true;
        await writeImportItem(journal({
            item: {
                itemType: 'journalArticle',
                title: 'Paper',
                // 'Cafe\u0301' is the decomposed form of 'Caf\u00e9'.
                tags: [{ tag: 'reading ' }, { tag: ' Cafe\u0301' }],
            },
            tags: ['reading', 'Caf\u00e9'],
        }));
        expect(savedJson().tags).toEqual([
            { tag: 'reading', type: 0 },
            { tag: 'Caf\u00e9', type: 0 },
        ]);
    });

    it('drops resolved tags when automatic tags are off, as Zotero does', async () => {
        prefs.automaticTags = false;
        await writeImportItem(journal({ item: { itemType: 'journalArticle', title: 'Paper', tags: [{ tag: 'Sociology' }] } }));
        expect(savedJson()).not.toHaveProperty('tags');
    });

    it('does not save again when nothing needs stamping', async () => {
        await writeImportItem(journal());
        expect(saved.save).toHaveBeenCalledTimes(1);
        expect(saved.saveTx).not.toHaveBeenCalled();
    });

    it('stamps Beaver provenance and saves it in its own transaction', async () => {
        mocks.stampBeaverProvenanceExtra.mockReturnValue(true);
        await writeImportItem(journal());
        expect(mocks.stampBeaverProvenanceExtra).toHaveBeenCalledWith(saved);
        expect(Z.DB.executeTransaction).toHaveBeenCalledTimes(2);
        expect(saved.save).toHaveBeenCalledTimes(2);
        expect(saved.saveTx).not.toHaveBeenCalled();
    });

    it.each([
        ['model_metadata', 'Beaver Metadata: written by Beaver from the conversation'],
        ['fallback_metadata', 'Beaver Metadata: search-result metadata (identifier lookup failed)'],
    ])('records %s in Extra', async (method, line) => {
        await writeImportItem(journal({ resolution: { method } }));
        expect(saved.setField).toHaveBeenCalledWith('extra', line);
        expect(saved.save).toHaveBeenCalled();
    });

    it('appends the metadata line to existing Extra without duplicating it', async () => {
        saved.getField.mockImplementation((name: string) => (name === 'extra' ? 'PMID: 1' : ''));
        await writeImportItem(journal({ resolution: { method: 'model_metadata' } }));
        expect(saved.setField).toHaveBeenCalledWith('extra', 'PMID: 1\nBeaver Metadata: written by Beaver from the conversation');

        saved.setField.mockClear();
        saved.getField.mockImplementation((name: string) =>
            (name === 'extra' ? 'Beaver Metadata: written by Beaver from the conversation' : ''));
        await writeImportItem(journal({ resolution: { method: 'model_metadata' } }));
        expect(saved.setField).not.toHaveBeenCalled();
    });

    it('adds no metadata line for translator-resolved items', async () => {
        await writeImportItem(journal({ resolution: { method: 'translator' } }));
        expect(saved.setField).not.toHaveBeenCalled();
    });

    it('creates a provenance note when the preference is on', async () => {
        prefs.addBeaverProvenanceNote = true;
        await writeImportItem(journal(), { threadId: 't1', runId: 'r1' });
        expect(mocks.createProvenanceNote).toHaveBeenCalledWith(
            { library_id: 1, zotero_key: 'ITEM0001', library_ref: 'u' },
            { threadId: 't1', runId: 'r1' },
            expect.any(Function),
        );
        // The note is saved inside a Beaver-owned transaction.
        const note = { save: vi.fn(async () => {}) };
        await mocks.createProvenanceNote.mock.calls[0][2](note);
        expect(note.save).toHaveBeenCalledTimes(1);
        expect(Z.DB.executeTransaction).toHaveBeenCalledTimes(2);
    });

    it('creates no provenance note by default', async () => {
        await writeImportItem(journal());
        expect(mocks.createProvenanceNote).not.toHaveBeenCalled();
    });
});

describe('writeImportItem attachments', () => {
    it('schedules a PDF fetch for scholarly items and reports a pending attachment', async () => {
        const onAttachmentResolved = vi.fn();
        const result = await writeImportItem(
            journal({ pdf_candidates: [{ url: 'https://x.org/p.pdf' } as any] }),
            { actionId: 'a1', runId: 'r1', threadId: 't1', onAttachmentResolved },
        );
        expect(mocks.schedulePdfFetchTask).toHaveBeenCalledWith(1, 'ITEM0001', {
            pdfCandidates: [{ url: 'https://x.org/p.pdf' }],
            actionId: 'a1',
            runId: 'r1',
            threadId: 't1',
            onAttachmentResolved,
        });
        expect(result.attachment_status).toBe('pending');
    });

    it('does not fetch a PDF for an item with no DOI, URL or candidates to look up', async () => {
        const result = await writeImportItem({
            library_id: 1,
            source: { kind: 'metadata', input: 'metadata[0]' },
            item: { itemType: 'report', title: 'Grey report' },
            resolution: { method: 'model_metadata' },
        });
        expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
        expect(result.attachment_status).toBe('none');
    });

    it('fetches a PDF for an item that has a DOI even without candidates', async () => {
        const result = await writeImportItem(journal({ item: { itemType: 'journalArticle', title: 'Paper', DOI: '10.1/x' } }));
        expect(mocks.schedulePdfFetchTask).toHaveBeenCalled();
        expect(result.attachment_status).toBe('pending');
    });

    it('does not fetch a PDF when files are not editable in the library', async () => {
        libraryInfo.filesEditable = false;
        const result = await writeImportItem(journal());
        expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
        expect(result.attachment_status).toBe('none');
    });

    it('reports an existing PDF child as available without fetching', async () => {
        mocks.filterPdfAttachments.mockResolvedValue([makeSavedItem({ key: 'PDFKEY01' })]);
        const result = await writeImportItem(journal());
        expect(result).toMatchObject({ attachment_status: 'available', attachment_key: '1-PDFKEY01' });
        expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
    });

    it('schedules a page snapshot for web content when automatic snapshots are on', async () => {
        const result = await writeImportItem(journal({
            item: { itemType: 'webpage', title: 'Page' },
            snapshot_url: 'https://x.org/page',
        }));
        expect(mocks.scheduleBackgroundTask).toHaveBeenCalledWith(
            expect.stringContaining('snapshot'),
            'snapshot',
            expect.any(Function),
            expect.objectContaining({ itemKey: 'ITEM0001', libraryId: 1 }),
        );
        expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
        expect(result.attachment_status).toBe('pending');
    });

    it('treats an unset automaticSnapshots preference as on and false as off', async () => {
        const data = () => journal({ item: { itemType: 'webpage', title: 'Page' }, snapshot_url: 'https://x.org/page' });
        prefs.automaticSnapshots = undefined;
        await writeImportItem(data());
        expect(mocks.scheduleBackgroundTask).toHaveBeenCalledTimes(1);

        mocks.scheduleBackgroundTask.mockClear();
        prefs.automaticSnapshots = false;
        const result = await writeImportItem(data());
        expect(mocks.scheduleBackgroundTask).not.toHaveBeenCalled();
        expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
        expect(result.attachment_status).toBe('none');
    });

    it('takes no snapshot when the hidden-browser APIs are unavailable', async () => {
        apiAvailable.remoteTranslate = false;
        const result = await writeImportItem(journal({ item: { itemType: 'webpage', title: 'Page' }, snapshot_url: 'https://x.org/p' }));
        expect(mocks.scheduleBackgroundTask).not.toHaveBeenCalled();
        expect(result.attachment_status).toBe('none');
    });

    it('does not fetch a PDF for web content without a snapshot url', async () => {
        const result = await writeImportItem(journal({ item: { itemType: 'blogPost', title: 'Post' } }));
        expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
        expect(result.attachment_status).toBe('none');
    });

    describe('with an input file', () => {
        it('rechecks the file and imports it as a child of the new item', async () => {
            mocks.locateImportFile.mockResolvedValue(file());
            const result = await writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf', size: 10 } }), { threadId: 't1' });
            expect(mocks.locateImportFile).toHaveBeenCalledWith({ path: '/home/u/papers/a.pdf', size: 10 }, { threadId: 't1', recheck: true });
            expect(Z.Attachments.importFromFile).toHaveBeenCalledWith({
                file: '/home/u/papers/a.pdf',
                libraryID: 1,
                parentItemID: 500,
            });
            expect(result).toMatchObject({ attachment_status: 'available', attachment_key: '1-FILEKEY1', file_attachment_key: '1-FILEKEY1' });
            expect(mocks.schedulePdfFetchTask).not.toHaveBeenCalled();
        });

        it('renames the imported file the way Zotero does when auto-rename applies', async () => {
            apiAvailable.attachmentRename = true;
            mocks.locateImportFile.mockResolvedValue(file());
            await writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf' } }));
            expect(Z.Attachments.importFromFile).toHaveBeenCalledWith(expect.objectContaining({ fileBaseName: 'Smith - Paper' }));
        });

        it('refuses a linked file outside My Library before writing anything', async () => {
            (Zotero as any).Libraries.userLibraryID = 99;
            mocks.locateImportFile.mockResolvedValue(file('link'));
            await expect(writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf', mode: 'link' } })))
                .rejects.toMatchObject({ code: 'link_not_supported' });
            expect(Z.Attachments.linkFromFile).not.toHaveBeenCalled();
        });

        it('links the file without renaming it in link mode', async () => {
            (Zotero as any).Libraries.userLibraryID = 1;
            apiAvailable.attachmentRename = true;
            mocks.locateImportFile.mockResolvedValue(file('link'));
            const result = await writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf', mode: 'link' } }));
            expect(Z.Attachments.linkFromFile).toHaveBeenCalledWith({ file: '/home/u/papers/a.pdf', parentItemID: 500 });
            expect(Z.Attachments.importFromFile).not.toHaveBeenCalled();
            expect(Z.Attachments.getRenamedFileBaseNameIfAllowedType).not.toHaveBeenCalled();
            expect(result.file_attachment_key).toBe('1-LINKKEY1');
        });

        it('prefers a PDF child as the primary attachment when one exists', async () => {
            mocks.locateImportFile.mockResolvedValue(file());
            mocks.filterPdfAttachments.mockResolvedValue([makeSavedItem({ key: 'PDFKEY01' })]);
            const result = await writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf' } }));
            expect(result).toMatchObject({ attachment_key: '1-PDFKEY01', file_attachment_key: '1-FILEKEY1' });
        });

        it('fails with the location error before saving anything', async () => {
            mocks.locateImportFile.mockResolvedValue({ ok: false, code: 'file_changed', message: 'changed' });
            await expect(writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf' } })))
                .rejects.toMatchObject({ code: 'file_changed', message: 'changed' });
            expect(itemCtor).not.toHaveBeenCalled();
        });

        it('erases the new item when attaching the file fails', async () => {
            mocks.locateImportFile.mockResolvedValue(file());
            Z.Attachments.importFromFile.mockRejectedValue(new Error('disk full'));
            await expect(writeImportItem(journal({ file: { path: '/home/u/papers/a.pdf' } }))).rejects.toThrow('disk full');
            expect(saved.eraseTx).toHaveBeenCalledTimes(1);
        });
    });

    it('erases the new item when a step after saving throws', async () => {
        mocks.stampBeaverProvenanceExtra.mockReturnValue(true);
        saved.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stamp save failed'));
        await expect(writeImportItem(journal())).rejects.toThrow('stamp save failed');
        expect(saved.eraseTx).toHaveBeenCalledTimes(1);
    });

    it('still reports the original error when cleanup itself fails', async () => {
        mocks.stampBeaverProvenanceExtra.mockReturnValue(true);
        saved.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stamp save failed'));
        saved.eraseTx.mockRejectedValue(new Error('erase failed'));
        await expect(writeImportItem(journal())).rejects.toThrow('stamp save failed');
    });

    it('does not erase anything when saving itself fails', async () => {
        saved.save.mockRejectedValue(new Error('database locked'));
        await expect(writeImportItem(journal())).rejects.toThrow('database locked');
        expect(saved.eraseTx).not.toHaveBeenCalled();
    });
});

describe('writeImportItem without item data', () => {
    it('fails with missing_item_data and writes nothing', async () => {
        await expect(writeImportItem({ library_id: 1, source: { kind: 'identifier', input: 'x' } }))
            .rejects.toMatchObject({ code: 'missing_item_data' });
        mocks.locateImportFile.mockResolvedValue(file());
        await expect(writeImportItem({ library_id: 1, source: { kind: 'file', input: 'a.pdf' }, file: { path: '/home/u/papers/a.pdf' } }))
            .rejects.toMatchObject({ code: 'missing_item_data' });
        expect(Z.Attachments.importFromFile).not.toHaveBeenCalled();
    });
});

describe('writeImportItem pending resolution (citation-derived actions)', () => {
    const pending = (): ImportItemProposedData => ({
        library_id: 1,
        source: { kind: 'external', input: 'W123', external_id: 'W123' },
        pending_resolution: {
            identifier: { type: 'doi', value: '10.1/x' },
            fallback_item: { itemType: 'journalArticle', title: 'Fallback' },
        },
    });

    it('resolves at apply time and writes the resolved item with its method', async () => {
        mocks.resolveImportItems.mockResolvedValue([
            { key: 'W123', status: 'resolved', method: 'fallback_metadata', item: { itemType: 'journalArticle', title: 'Resolved' } },
        ]);
        await writeImportItem(pending(), { threadId: 't1' });
        expect(mocks.resolveImportItems).toHaveBeenCalledWith(
            [expect.objectContaining({
                key: 'W123',
                identifier: { type: 'doi', value: '10.1/x' },
                fallback_item: { itemType: 'journalArticle', title: 'Fallback' },
            })],
            { libraryID: 1, deadlineMs: 20_000, threadId: 't1' },
        );
        expect(savedJson()).toMatchObject({ title: 'Resolved' });
        expect(saved.setField).toHaveBeenCalledWith('extra', expect.stringContaining('search-result metadata'));
    });

    it('throws already_in_library with the existing item and writes nothing', async () => {
        const existing = { library_id: 1, zotero_key: 'EXIST123' };
        mocks.resolveImportItems.mockResolvedValue([{ key: 'W123', status: 'already_in_library', existing_item: existing }]);
        const error = await writeImportItem(pending()).catch((caught) => caught);
        expect(error).toBeInstanceOf(ImportItemError);
        expect(error).toMatchObject({ code: 'already_in_library', details: { existing_item: existing } });
        expect(itemCtor).not.toHaveBeenCalled();
        expect(saved.eraseTx).not.toHaveBeenCalled();
    });

    it('reports no duplicate from a library excluded during resolution', async () => {
        mocks.resolveImportItems.mockImplementation(async () => {
            Z.Beaver.searchableLibraryIds = [];
            return [{ key: 'W123', status: 'already_in_library', existing_item: { library_id: 1, zotero_key: 'EXIST123' } }];
        });
        const error = await writeImportItem(pending()).catch((caught) => caught);
        expect(error).toMatchObject({ code: 'library_not_searchable' });
        expect(error.details).toBeUndefined();
    });

    it('propagates the resolution failure code', async () => {
        mocks.resolveImportItems.mockResolvedValue([{ key: 'W123', status: 'failed', error: { code: 'not_found', message: 'gone' } }]);
        await expect(writeImportItem(pending())).rejects.toMatchObject({ code: 'not_found', message: 'gone' });
    });

    it('fails with resolution_failed when resolution returns nothing', async () => {
        mocks.resolveImportItems.mockResolvedValue([]);
        await expect(writeImportItem(pending())).rejects.toMatchObject({ code: 'resolution_failed' });
    });
});

describe('undoImportItem', () => {
    it('refuses a result without a key', async () => {
        await expect(undoImportItem(undefined)).rejects.toMatchObject({ code: 'not_applied' });
        await expect(undoImportItem({ library_id: 1, zotero_key: '' })).rejects.toMatchObject({ code: 'not_applied' });
    });

    it('cancels background work and erases the created item', async () => {
        const item = makeSavedItem();
        mocks.resolveLibraryRef.mockReturnValue(1);
        mocks.resolveItemReference.mockResolvedValue({ status: 'found', item });
        await undoImportItem({ library_id: 1, zotero_key: 'ITEM0001' });
        expect(mocks.cancelTasksForItem).toHaveBeenCalledWith(1, 'ITEM0001');
        expect(mocks.assertLibraryWritable).toHaveBeenCalledWith(1);
        expect(item.eraseTx).toHaveBeenCalledTimes(1);
    });

    it('erases only the attachment it reported, never the item it was moved under', async () => {
        const attachment = makeSavedItem({ id: 620, key: 'FILEKEY1', parentItemID: 820, isAttachment: () => true });
        mocks.resolveLibraryRef.mockReturnValue(1);
        mocks.resolveItemReference.mockResolvedValue({ status: 'found', item: attachment });
        await undoImportItem({ library_id: 1, zotero_key: 'FILEKEY1' });
        expect(attachment.eraseTx).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the item no longer exists', async () => {
        mocks.resolveLibraryRef.mockReturnValue(1);
        mocks.resolveItemReference.mockResolvedValue({ status: 'not_found' });
        await expect(undoImportItem({ library_id: 1, zotero_key: 'ITEM0001' })).resolves.toBeUndefined();
    });

    it('refuses to erase from a library that is no longer writable', async () => {
        const item = makeSavedItem();
        mocks.resolveLibraryRef.mockReturnValue(1);
        mocks.resolveItemReference.mockResolvedValue({ status: 'found', item });
        mocks.assertLibraryWritable.mockImplementation(() => { throw Object.assign(new Error('read-only'), { code: 'library_not_editable' }); });
        await expect(undoImportItem({ library_id: 1, zotero_key: 'ITEM0001' })).rejects.toMatchObject({ code: 'library_not_editable' });
        expect(item.eraseTx).not.toHaveBeenCalled();
    });
});
