import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({ store: { get: vi.fn() } }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: {} }));
vi.mock('../../../react/atoms/auth', () => ({ userIdAtom: {} }));
vi.mock('../../../react/host/zotero/sourceActions', () => ({ notifyReferenceUnavailable: vi.fn() }));
vi.mock('../../../react/components/agentRuns/EditNotePreview', () => ({
    stripHtmlTags: vi.fn(), computeDiff: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({ isAttachmentOnServer: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({ safeFileExists: vi.fn() }));

import { revealSource } from '../../../react/utils/sourceUtils';
import { initializeWindowRuntime } from '../../../react/runtime/windowRuntime';

const runtime = { hostWindow: { closed: false }, contextWindow: null, status: 'ready' } as any;
initializeWindowRuntime(runtime);
const source = { library_id: 1, zotero_key: 'ABCDEFGH' };

function mainWindow() {
    return {
        closed: false,
        Zotero_Tabs: { select: vi.fn() },
        ZoteroPane: {
            selectItem: vi.fn(async () => true),
            collectionsView: {
                waitForLoad: vi.fn(async () => {}),
                selectLibrary: vi.fn(async () => true),
                selectCollection: vi.fn(async () => true),
            },
            itemsView: {
                waitForLoad: vi.fn(async () => {}),
                getRowIndexByID: vi.fn(() => false),
            },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    runtime.hostWindow.closed = false;
    runtime.contextWindow = null;
    runtime.status = 'ready';
    Object.assign(Zotero, {
        Items: {
            getIDFromLibraryAndKey: vi.fn(() => 42),
            getAsync: vi.fn(async () => ({ id: 42, libraryID: 1 })),
        },
        Collections: {
            getIDFromLibraryAndKey: vi.fn(() => 7),
            get: vi.fn(() => ({ id: 7 })),
        },
        getMainWindow: vi.fn(() => null),
        openMainWindow: vi.fn(),
        Promise: { delay: vi.fn(async () => {}) },
    });
});

it('reopens the library and waits for its pane before revealing an item from a standalone', async () => {
    const destination = mainWindow();
    const itemsView = destination.ZoteroPane.itemsView;
    delete (destination.ZoteroPane as any).itemsView;
    let ticks = 0;
    vi.mocked(Zotero.Promise.delay).mockImplementation(async () => {
        if (++ticks === 1) vi.mocked(Zotero.getMainWindow).mockReturnValue(destination as any);
        else destination.ZoteroPane.itemsView = itemsView;
    });

    revealSource(source);

    await vi.waitFor(() => expect(destination.ZoteroPane.selectItem).toHaveBeenCalledWith(42));
    expect((Zotero as any).openMainWindow).toHaveBeenCalledOnce();
    expect(ticks).toBe(2);
    expect(destination.ZoteroPane.collectionsView.selectLibrary).toHaveBeenCalledWith(1);
    expect(destination.Zotero_Tabs.select).toHaveBeenCalledWith('zotero-pane');
});

it('keeps the originating context and requested collection when another main window is active', async () => {
    const destination = mainWindow();
    runtime.contextWindow = destination;
    vi.mocked(Zotero.getMainWindow).mockReturnValue(mainWindow() as any);

    revealSource(source, 'COLLKEY1');

    await vi.waitFor(() => expect(destination.ZoteroPane.selectItem).toHaveBeenCalledWith(42));
    expect(destination.ZoteroPane.collectionsView.selectCollection).toHaveBeenCalledWith(7);
    expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    expect((Zotero as any).openMainWindow).not.toHaveBeenCalled();
});

it('waits for delayed collections creation and restoration before selecting and scrolling', async () => {
    const destination = mainWindow();
    const collections = destination.ZoteroPane.collectionsView;
    let finishRestoring!: () => void;
    const restoration = new Promise<void>(resolve => { finishRestoring = resolve; });
    collections.waitForLoad.mockReturnValue(restoration);
    delete (destination.ZoteroPane as any).collectionsView;
    vi.mocked(Zotero.getMainWindow).mockReturnValue(destination as any);
    vi.mocked(Zotero.Promise.delay).mockImplementation(async () => {
        destination.ZoteroPane.collectionsView = collections;
    });

    revealSource(source);

    await vi.waitFor(() => expect(collections.waitForLoad).toHaveBeenCalled());
    expect(destination.ZoteroPane.selectItem).not.toHaveBeenCalled();
    expect(collections.selectLibrary).not.toHaveBeenCalled();
    finishRestoring();
    await vi.waitFor(() => expect(destination.ZoteroPane.selectItem).toHaveBeenCalledWith(42));
});

it.each(['closed', 'closing'])('does not reopen the library from a %s renderer', state => {
    if (state === 'closed') runtime.hostWindow.closed = true;
    else runtime.status = 'closing';

    revealSource(source);

    expect((Zotero as any).openMainWindow).not.toHaveBeenCalled();
    expect(Zotero.Items.getAsync).not.toHaveBeenCalled();
});
