import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentFileUnavailableError, openReader, openNote, viewAttachment } from '../../../react/runtime/navigation';
import { runWindowOperation } from '../../../react/runtime/libraryMutation';
vi.mock('../../../react/utils/navigationNotice', () => ({ notifyNavigationUnavailable: vi.fn() }));
vi.mock('../../../react/runtime/libraryMutation', () => ({ runWindowOperation: vi.fn() }));
let a: any, b: any;
beforeEach(() => {
    const main = () => ({ closed: false, focus: vi.fn(), ZoteroPane: { itemsView: { waitForLoad: vi.fn(async () => {}) }, collectionsView: { waitForLoad: vi.fn(async () => {}) } }, Zotero_Tabs: { _tabs: [], select: vi.fn(), isOwnTabEvent: vi.fn() } });
    a = main(); b = main();
    let active = b;
    a.focus.mockImplementation(() => { active = a; });
    vi.stubGlobal('Zotero', {
        getMainWindow: vi.fn(() => active),
        Promise: { delay: vi.fn(async () => {}) },
        Reader: { open: vi.fn(async (itemID, _location, options) => ({ itemID, _window: options.window })), getByTabID: vi.fn() },
        Notes: { open: vi.fn(async () => undefined), _editorInstances: [] },
        Items: { getAsync: vi.fn(async () => null) },
    });
});
it('passes A to native reader and note opening while B is active', async () => {
    await openReader(42, { pageIndex: 3 }, {}, a);
    await openNote(17, a);
    expect(Zotero.Reader.open).toHaveBeenCalledWith(42, { pageIndex: 3 }, { window: a });
    expect((Zotero as any).Notes.open).toHaveBeenCalledWith(17, undefined, { window: a });
    expect(b.focus).not.toHaveBeenCalled();
});
it('uses the local copy of a PDF under legacy global duplicate detection', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local', data: { itemID: 42 } }];
    const reader = { itemID: 42, _window: a, navigate: vi.fn(async () => {}) };
    vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(reader as any);
    expect(await openReader(42, { pageIndex: 8 }, {}, a)).toBe(reader);
    expect(a.Zotero_Tabs.select).toHaveBeenCalledWith('local');
    expect(reader.navigate).toHaveBeenCalledWith({ pageIndex: 8 });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
});
it('allows a new local copy on legacy Zotero instead of selecting another window’s PDF', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    await openReader(42, undefined, {}, a);
    expect(Zotero.Reader.open).toHaveBeenCalledWith(42, undefined, { window: a, allowDuplicate: true });
    expect(a.focus).toHaveBeenCalledOnce();
});
it('rejects a native result from the wrong window and a target closed during opening', async () => {
    vi.mocked(Zotero.Reader.open).mockResolvedValue({ itemID: 42, _window: b } as any);
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    vi.mocked(Zotero.Reader.open).mockImplementation(async () => { a.closed = true; return undefined; });
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
});

it('does not open in B when legacy Zotero cannot activate A', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.focus.mockImplementation(() => {});
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    await expect(openNote(17, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
    expect((Zotero as any).Notes.open).not.toHaveBeenCalled();
});

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
it('contains unavailable-window failures in fire-and-forget attachment opening', async () => {
    a.closed = true;
    await expect(viewAttachment(42, a)).resolves.toBeUndefined();
    await expect(viewAttachment(42)).resolves.toBeUndefined();
});


it('restores an unloaded local legacy tab instead of opening a duplicate', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local', type: 'reader-unloaded', data: { itemID: 42 } }];
    const reader = { itemID: 42, _window: a, navigate: vi.fn() };
    (Zotero as any).Promise = { delay: vi.fn(async () => {
        vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(reader as any);
    }) };
    expect(await openReader(42, { pageIndex: 8 }, {}, a)).toBe(reader);
    expect(a.Zotero_Tabs.select).toHaveBeenCalledWith('local', false, { location: { pageIndex: 8 } });
    expect(reader.navigate).not.toHaveBeenCalled();
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
    expect(b.Zotero_Tabs.select).not.toHaveBeenCalled();
});

it('does not reopen a different tab when the restoring tab closes', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local', type: 'reader-unloaded', data: { itemID: 42 } }];
    (Zotero as any).Promise = { delay: vi.fn(async () => { a.Zotero_Tabs._tabs = []; }) };
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
});


it('waits for an already-loading local reader before applying a new location', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local', type: 'reader-loading', data: { itemID: 42 } }];
    let initialize!: () => void;
    const reader = { itemID: 42, _window: a, navigate: vi.fn(), _initPromise: new Promise<void>(resolve => { initialize = resolve; }) };
    vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(reader as any);
    const pending = openReader(42, { pageIndex: 8 }, {}, a);
    await Promise.resolve();
    expect(reader.navigate).not.toHaveBeenCalled();
    initialize();
    expect(await pending).toBe(reader);
    expect(reader.navigate).toHaveBeenCalledWith({ pageIndex: 8 });
});


it.each(['note-unloaded', 'note-loading'])('restores the local %s tab despite a foreign editor for the same note', async (type) => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local-note', type, data: { itemID: 17 } }];
    const foreign = { itemID: 17, tabID: 'foreign-note' };
    const restored = { itemID: 17, tabID: 'local-note' };
    (Zotero as any).Notes._editorInstances = [foreign];
    (Zotero as any).Promise = { delay: vi.fn(async () => {
        (Zotero as any).Notes._editorInstances.push(restored);
    }) };
    expect(await openNote(17, a)).toBe(restored);
    expect(a.Zotero_Tabs.select).toHaveBeenCalledWith('local-note');
    expect((Zotero as any).Notes.open).not.toHaveBeenCalled();
    expect(b.Zotero_Tabs.select).not.toHaveBeenCalled();
});

it('does not duplicate a local note whose tab closes during restoration', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local-note', type: 'note-unloaded', data: { itemID: 17 } }];
    (Zotero as any).Promise = { delay: vi.fn(async () => { a.Zotero_Tabs._tabs = []; }) };
    await expect(openNote(17, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    expect((Zotero as any).Notes.open).not.toHaveBeenCalled();
});

it('allows a local note duplicate only when there is no local tab', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    (Zotero as any).Notes._editorInstances = [{ itemID: 17, tabID: 'foreign-note' }];
    await openNote(17, a);
    expect((Zotero as any).Notes.open).toHaveBeenCalledWith(17, undefined, { window: a, allowDuplicate: true });
});


it.each([false, true])('waits for the local note editor initialization (restoring: %s)', async (restoring) => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local-note', type: restoring ? 'note-unloaded' : 'note', data: { itemID: 17 } }];
    let initialize!: () => void;
    const editor = { itemID: 17, tabID: 'local-note', _initPromise: new Promise<void>(resolve => { initialize = resolve; }) };
    (Zotero as any).Notes._editorInstances = restoring ? [] : [editor];
    (Zotero as any).Promise = { delay: vi.fn(async () => { (Zotero as any).Notes._editorInstances.push(editor); }) };
    let finished = false;
    const pending = openNote(17, a).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    initialize();
    expect(await pending).toBe(editor);
});

it('rejects a note tab closed while its editor initializes', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local-note', data: { itemID: 17 } }];
    let initialize!: () => void;
    const editor = { itemID: 17, tabID: 'local-note', _initPromise: new Promise<void>(resolve => { initialize = resolve; }) };
    (Zotero as any).Notes._editorInstances = [editor];
    const pending = openNote(17, a);
    await vi.waitFor(() => expect(a.Zotero_Tabs.select).toHaveBeenCalledWith('local-note'));
    a.Zotero_Tabs._tabs = [];
    initialize();
    await expect(pending).rejects.toMatchObject({ code: 'window_unavailable' });
});


it.each([false, true])('rejects a reader closed during initialization (registration delayed: %s)', async (delayed) => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local', type: 'reader-loading', data: { itemID: 42 } }];
    let initialize!: () => void;
    const reader = { itemID: 42, _window: a, navigate: vi.fn(), _initPromise: new Promise<void>(resolve => { initialize = resolve; }) };
    vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(delayed ? undefined as any : reader as any);
    (Zotero as any).Promise = { delay: vi.fn(async () => { vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(reader as any); }) };
    const pending = openReader(42, { pageIndex: 8 }, {}, a);
    await new Promise(resolve => setTimeout(resolve, 0));
    a.Zotero_Tabs._tabs = [];
    vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(undefined as any);
    initialize();
    await expect(pending).rejects.toMatchObject({ code: 'window_unavailable' });
    expect(reader.navigate).not.toHaveBeenCalled();
});


it.each(['reader', 'note', 'attachment'])('waits for delayed native activation before opening a %s', async kind => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.focus.mockImplementation(() => {});
    a.ZoteroPane.viewAttachment = vi.fn();
    let ticks = 0;
    Zotero.Promise.delay = vi.fn(async () => {
        if (++ticks === 3) vi.mocked(Zotero.getMainWindow).mockReturnValue(a);
    });
    if (kind === 'reader') await openReader(42, undefined, {}, a);
    if (kind === 'note') await openNote(17, a);
    if (kind === 'attachment') await viewAttachment(42, a);
    expect(ticks).toBe(3);
    expect(a.focus).toHaveBeenCalledOnce();
    expect(kind === 'reader' ? Zotero.Reader.open : kind === 'note' ? (Zotero as any).Notes.open : a.ZoteroPane.viewAttachment).toHaveBeenCalledOnce();
});

it('aborts activation when the target closes during the wait', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.focus.mockImplementation(() => {});
    Zotero.Promise.delay = vi.fn(async () => { a.closed = true; });
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
});

it('rechecks activation after the wait resolves and before invoking the native API', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    let reads = 0;
    vi.mocked(Zotero.getMainWindow).mockImplementation(() => ++reads <= 2 ? a : b);
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
});


describe('file availability before opening the reader', () => {
    const TO_DOWNLOAD = 2;
    const FORCE_DOWNLOAD = 5;
    let item: any;
    let fileOnDisk: boolean;

    beforeEach(() => {
        fileOnDisk = false;
        item = {
            libraryID: 1,
            attachmentSyncState: TO_DOWNLOAD,
            attachmentContentType: 'application/pdf',
            isAttachment: () => true,
            isFileAttachment: () => true,
            isStoredFileAttachment: () => true,
            getFilePath: () => '/storage/ABC/file.pdf',
            getFilePathAsync: vi.fn(async () => fileOnDisk ? '/storage/ABC/file.pdf' : false),
        };
        a.ZoteroPane.showAttachmentNotFoundDialog = vi.fn();
        a.ZoteroPane.collectionsView.editable = true;
        vi.stubGlobal('IOUtils', { exists: vi.fn(async () => fileOnDisk) });
        Object.assign(Zotero as any, {
            Items: { getAsync: vi.fn(async () => item) },
            Sync: {
                Storage: { Local: {
                    getEnabledForLibrary: vi.fn(() => true),
                    SYNC_STATE_TO_DOWNLOAD: TO_DOWNLOAD,
                    SYNC_STATE_FORCE_DOWNLOAD: FORCE_DOWNLOAD,
                } },
                Runner: {
                    downloadFile: vi.fn(async () => { fileOnDisk = true; return { localChanges: true }; }),
                    alert: vi.fn(),
                },
            },
            Notifier: { trigger: vi.fn() },
            Attachments: { LINK_MODE_LINKED_URL: 3 },
            logError: vi.fn(),
        });
    });

    it('downloads a file that is only on the server before opening it', async () => {
        await openReader(42, { pageIndex: 0 }, {}, a);
        expect(Zotero.Sync.Runner.downloadFile).toHaveBeenCalledWith(item);
        expect(Zotero.Reader.open).toHaveBeenCalledWith(42, { pageIndex: 0 }, { window: a });
        expect(vi.mocked(Zotero.Sync.Runner.downloadFile).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(Zotero.Reader.open).mock.invocationCallOrder[0]);
    });

    it('shows the not-found dialog instead of a blank reader when the download yields no file', async () => {
        vi.mocked(Zotero.Sync.Runner.downloadFile).mockResolvedValue({ localChanges: false } as any);
        await expect(openReader(42, undefined, {}, a)).rejects.toBeInstanceOf(AttachmentFileUnavailableError);
        expect(a.ZoteroPane.showAttachmentNotFoundDialog).toHaveBeenCalledWith(
            item, '/storage/ABC/file.pdf', expect.objectContaining({ notOnServer: true }));
        expect(Zotero.Reader.open).not.toHaveBeenCalled();
    });

    it('reports a failed download without opening the reader', async () => {
        const error = new Error('offline');
        vi.mocked(Zotero.Sync.Runner.downloadFile).mockRejectedValue(error);
        await expect(openReader(42, undefined, {}, a)).rejects.toBeInstanceOf(AttachmentFileUnavailableError);
        expect((Zotero.Sync.Runner as any).alert).toHaveBeenCalledWith(error);
        expect(Zotero.Reader.open).not.toHaveBeenCalled();
    });

    it('does not download a missing linked file', async () => {
        item.isStoredFileAttachment = () => false;
        await expect(openReader(42, undefined, {}, a)).rejects.toBeInstanceOf(AttachmentFileUnavailableError);
        expect(Zotero.Sync.Runner.downloadFile).not.toHaveBeenCalled();
        expect(a.ZoteroPane.showAttachmentNotFoundDialog).toHaveBeenCalledWith(
            item, '/storage/ABC/file.pdf', expect.objectContaining({ linkedFile: true, notOnServer: false }));
    });

    it('opens a local file directly unless a newer server version is queued', async () => {
        fileOnDisk = true;
        item.attachmentSyncState = 0;
        await openReader(42, undefined, {}, a);
        expect(Zotero.Sync.Runner.downloadFile).not.toHaveBeenCalled();

        item.attachmentSyncState = FORCE_DOWNLOAD;
        await openReader(42, undefined, {}, a);
        expect(Zotero.Sync.Runner.downloadFile).toHaveBeenCalledOnce();
        expect(Zotero.Reader.open).toHaveBeenCalledTimes(2);
    });

    it('opens the existing local copy when refreshing a queued file fails', async () => {
        fileOnDisk = true;
        item.attachmentSyncState = FORCE_DOWNLOAD;
        vi.mocked(Zotero.Sync.Runner.downloadFile).mockRejectedValue(new Error('offline'));
        await openReader(42, undefined, {}, a);
        expect(Zotero.Reader.open).toHaveBeenCalledOnce();
        expect((Zotero.Sync.Runner as any).alert).not.toHaveBeenCalled();
    });
});

describe('content type before opening the reader', () => {
    let item: any;

    beforeEach(() => {
        vi.mocked(runWindowOperation).mockReset();
        item = {
            libraryID: 1,
            attachmentSyncState: 0,
            attachmentContentType: 'application/pdf',
            attachmentFilename: 'paper.pdf',
            isAttachment: () => true,
            isFileAttachment: () => true,
            isStoredFileAttachment: () => true,
            getFilePath: () => '/storage/ABC/paper.pdf',
            getFilePathAsync: vi.fn(async () => '/storage/ABC/paper.pdf'),
        };
        vi.stubGlobal('IOUtils', { exists: vi.fn(async () => true) });
        Object.assign(Zotero as any, {
            Items: { getAsync: vi.fn(async () => item) },
            Sync: { Storage: { Local: {
                getEnabledForLibrary: vi.fn(() => true),
                SYNC_STATE_TO_DOWNLOAD: 2,
                SYNC_STATE_FORCE_DOWNLOAD: 5,
            } } },
            Attachments: { LINK_MODE_LINKED_URL: 3 },
        });
    });

    it('corrects a mislabelled PDF in the plugin realm before the reader opens it', async () => {
        item.attachmentContentType = 'application/octet-stream';
        await openReader(42, undefined, {}, a);
        expect(runWindowOperation).toHaveBeenCalledWith('ensureReaderContentType', [42]);
        expect(vi.mocked(runWindowOperation).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(Zotero.Reader.open).mock.invocationCallOrder[0]);
    });

    it('opens a correctly typed PDF without a library write', async () => {
        await openReader(42, undefined, {}, a);
        expect(runWindowOperation).not.toHaveBeenCalled();
        expect(Zotero.Reader.open).toHaveBeenCalledOnce();
    });

    it('still opens the reader when the correction fails', async () => {
        item.attachmentContentType = '';
        vi.mocked(runWindowOperation).mockRejectedValue(new Error('library locked') as never);
        await openReader(42, undefined, {}, a);
        expect(Zotero.Reader.open).toHaveBeenCalledOnce();
    });
});
