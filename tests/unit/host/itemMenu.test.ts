import { beforeEach, describe, expect, it, vi } from 'vitest';

declare const Zotero: any;

const resolveLibraryRef = vi.hoisted(() => vi.fn());
const revealSource = vi.hoisted(() => vi.fn());
const selectItemById = vi.hoisted(() => vi.fn());
const viewAttachment = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef }));
vi.mock('../../../react/runtime/navigation', () => ({
    openNote: vi.fn(),
    openNoteWindow: vi.fn(),
    showAttachmentInFilesystem: vi.fn(),
    viewAttachment,
}));
vi.mock('../../../react/utils/sourceUtils', () => ({ revealSource }));
vi.mock('../../../react/utils/selectItem', () => ({ selectItemById }));
vi.mock('../../../react/utils/readerUtils', () => ({ navigateToAnnotation: vi.fn() }));
vi.mock('../../../react/components/icons/icons', () => ({
    ExternalLinkIcon: () => null,
    FileViewIcon: () => null,
    FolderDetailIcon: () => null,
    LibraryIcon: () => null,
    NoteIcon: () => null,
}));

import { itemMenuItems } from '../../../react/host/zotero/itemMenu';

const LINKED_URL = 3;

function pdfAttachment(id: number) {
    return {
        id,
        libraryID: 7,
        key: `ATT${id}`,
        attachmentReaderType: 'pdf',
        attachmentLinkMode: 0,
        isFileAttachment: () => true,
    };
}

/** A file with no built-in reader: Zotero hands it to the system application. */
function docxAttachment(id: number) {
    return {
        id,
        libraryID: 7,
        key: `ATT${id}`,
        attachmentReaderType: undefined,
        attachmentLinkMode: 0,
        isAnnotation: () => false,
        isNote: () => false,
        isAttachment: () => true,
        isRegularItem: () => false,
        isFileAttachment: () => true,
    };
}

/**
 * A regular item as `getByLibraryAndKeyAsync` returns it: primary data only.
 * Like Zotero, `getBestAttachments()` throws until `itemData` and `childItems`
 * are loaded.
 */
function lazyRegularItem(bestAttachments: unknown[]) {
    const loaded = new Set<string>();
    return {
        id: 1,
        loaded,
        isAnnotation: () => false,
        isNote: () => false,
        isAttachment: () => false,
        isRegularItem: () => true,
        isFileAttachment: () => false,
        getBestAttachments: vi.fn(async () => {
            if (!loaded.has('childItems')) throw new Error("'childItems' not loaded for item");
            if (!loaded.has('itemData')) throw new Error("Item data not loaded for item");
            return bestAttachments;
        }),
    };
}

const labels = (entries: { label: string }[]) => entries.map((entry) => entry.label);

describe('itemMenuItems', () => {
    const getByLibraryAndKeyAsync = vi.fn();
    const getAsync = vi.fn();
    const loadDataTypes = vi.fn(async (items: any[], types: string[]) => {
        for (const item of items) for (const type of types) item.loaded?.add(type);
    });
    const prefs: Record<string, unknown> = {};

    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(prefs)) delete prefs[key];
        resolveLibraryRef.mockReturnValue(7);
        Zotero.Items = { getByLibraryAndKeyAsync, getAsync, loadDataTypes };
        Zotero.Prefs = { get: (key: string) => prefs[key] };
        Zotero.Attachments = { LINK_MODE_LINKED_URL: LINKED_URL };
        Zotero.isMac = true;
    });

    it('loads item and child data before resolving a regular item\'s best attachments', async () => {
        const item = lazyRegularItem([pdfAttachment(10)]);
        getByLibraryAndKeyAsync.mockResolvedValue(item);

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ITEM0001' });

        expect(loadDataTypes).toHaveBeenCalledWith([item], ['itemData', 'childItems']);
        expect(labels(entries)).toEqual([
            'Show in Library',
            'Open PDF in New Tab',
            'Open PDF in New Window',
            'Show in Finder',
        ]);
    });

    it('lists the preferred window behavior first', async () => {
        prefs.openReaderInNewWindow = true;
        getByLibraryAndKeyAsync.mockResolvedValue(lazyRegularItem([pdfAttachment(10)]));

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ITEM0001' });

        expect(labels(entries).slice(1, 3)).toEqual(['Open PDF in New Window', 'Open PDF in New Tab']);
    });

    it('keeps "Show in Library" when the attachment lookup fails', async () => {
        const item = lazyRegularItem([]);
        item.getBestAttachments.mockRejectedValue(new Error('database is locked'));
        getByLibraryAndKeyAsync.mockResolvedValue(item);

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ITEM0001' });

        expect(labels(entries)).toEqual(['Show in Library']);
    });

    it('offers only "Show in Library" for a regular item without attachments', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(lazyRegularItem([]));

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ITEM0001' });

        expect(labels(entries)).toEqual(['Show in Library']);
    });

    it('loads an annotation\'s parent attachment rather than reading it synchronously', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({
            parentID: 10,
            get parentItem() { throw new Error('parent not in memory'); },
            isAnnotation: () => true,
        });
        getAsync.mockResolvedValue(pdfAttachment(10));

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ANNO0001' });

        expect(getAsync).toHaveBeenCalledWith(10);
        expect(labels(entries)).toEqual(['Show in PDF', 'Show in Library', 'Show in Finder']);
    });

    it('selects the annotation itself for "Show in Library"', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ id: 50, key: 'ANNO0001', parentID: 10, isAnnotation: () => true });
        getAsync.mockResolvedValue(pdfAttachment(10));
        selectItemById.mockResolvedValue(true);

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ANNO0001' });
        entries.find((entry) => entry.label === 'Show in Library')!.onClick();
        await vi.waitFor(() => expect(selectItemById).toHaveBeenCalledWith(50));

        expect(revealSource).not.toHaveBeenCalled();
    });

    it('reveals the attachment when the items tree cannot select the annotation', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ id: 50, key: 'ANNO0001', parentID: 10, isAnnotation: () => true });
        getAsync.mockResolvedValue(pdfAttachment(10));
        selectItemById.mockResolvedValue(false);

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ANNO0001' });
        entries.find((entry) => entry.label === 'Show in Library')!.onClick();

        await vi.waitFor(() => expect(revealSource).toHaveBeenCalledWith({ library_id: 7, zotero_key: 'ATT10' }));
    });

    it('offers "Open Attachment" for a file without a built-in reader', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(docxAttachment(20));

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ATT20' });

        expect(labels(entries)).toEqual(['Show in Library', 'Open Attachment', 'Show in Finder']);
        entries.find((entry) => entry.label === 'Open Attachment')!.onClick();
        expect(viewAttachment).toHaveBeenCalledWith(20);
    });

    it('opens a regular item\'s best file when none has a built-in reader', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(lazyRegularItem([docxAttachment(20)]));

        const entries = await itemMenuItems({ library_id: 7, zotero_key: 'ITEM0001' });

        expect(labels(entries)).toEqual(['Show in Library', 'Open Attachment', 'Show in Finder']);
    });

    it('returns no entries for an item that no longer exists', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(false);

        expect(await itemMenuItems({ library_id: 7, zotero_key: 'GONE0001' })).toEqual([]);
    });
});
