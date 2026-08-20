/**
 * Shutdown hooks close the agent connection through `BeaverReact`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockCloseBeaverWindow,
    mockClosePreferencesWindow,
    mockCleanupContextMenus,
    mockCancelAllActiveTasks,
    mockCloseWindowsRenderedBy,
    mockDisposeMuPDFWorker,
    mockRemoveChatPanel,
    mockUiManagerCleanup,
    mockUnregisterShortcuts,
} = vi.hoisted(() => ({
    mockCloseBeaverWindow: vi.fn(),
    mockClosePreferencesWindow: vi.fn(),
    mockCleanupContextMenus: vi.fn(),
    mockCancelAllActiveTasks: vi.fn(),
    mockCloseWindowsRenderedBy: vi.fn(),
    mockDisposeMuPDFWorker: vi.fn().mockResolvedValue(undefined),
    mockRemoveChatPanel: vi.fn(),
    mockUiManagerCleanup: vi.fn(),
    mockUnregisterShortcuts: vi.fn(),
}));

vi.mock('../../src/ui/ui', () => ({
    BeaverUIFactory: {
        registerChatPanel: vi.fn(),
        removeChatPanel: mockRemoveChatPanel,
        registerShortcuts: vi.fn(),
        unregisterShortcuts: mockUnregisterShortcuts,
        closeBeaverWindow: mockCloseBeaverWindow,
        closePreferencesWindow: mockClosePreferencesWindow,
        closeWindowsRenderedBy: mockCloseWindowsRenderedBy,
    },
}));

vi.mock('../../src/beaver-extract', () => ({
    disposeMuPDFWorker: mockDisposeMuPDFWorker,
}));

vi.mock('../../react/ui/UIManager', () => ({
    uiManager: { cleanup: mockUiManagerCleanup },
    restoreReaderSidebarWidthHandler: vi.fn(),
}));

vi.mock('../../src/services/protocolHandler', () => ({
    registerBeaverProtocolHandler: vi.fn(),
    unregisterBeaverProtocolHandler: vi.fn(),
}));

vi.mock('../../src/utils/backgroundTasks', () => ({
    cancelAllActiveTasks: mockCancelAllActiveTasks,
}));

vi.mock('../../src/modules/zoteroContextMenu', () => ({
    initContextMenus: vi.fn(),
    cleanupContextMenus: mockCleanupContextMenus,
}));

vi.mock('../../src/utils/locale', () => ({ initLocale: vi.fn() }));
vi.mock('../../src/utils/ztoolkit', () => ({ createZToolkit: vi.fn() }));
vi.mock('../../src/services/CitationService', () => ({
    CitationService: class MockCitationService {},
}));
vi.mock('../../src/services/database', () => ({ BeaverDB: class MockBeaverDB {} }));
vi.mock('../../src/services/backgroundExtractor', () => ({
    BackgroundExtractor: class MockBackgroundExtractor {
        start = vi.fn();
        stop = vi.fn().mockResolvedValue(undefined);
        processOnce = vi.fn().mockResolvedValue({ processed: false });
    },
}));
vi.mock('../../react/eventBus', () => ({ default: {} }));
vi.mock('../../src/utils/prefs', () => ({ getPref: vi.fn(), setPref: vi.fn() }));
vi.mock('../../src/utils/versionNotificationPrefs', () => ({
    addPendingVersionNotification: vi.fn(),
}));
vi.mock('../../react/constants/versionUpdateMessages', () => ({
    getAllVersionUpdateMessageVersions: vi.fn(() => []),
}));

function makeWindow(closeAgentConnection: unknown = vi.fn()) {
    return {
        closed: false,
        document: { getElementById: vi.fn().mockReturnValue(null) },
        BeaverReact: { closeAgentConnection },
    } as unknown as Window & Record<string, any>;
}

function setupGlobals({ appShuttingDown }: { appShuttingDown: boolean }) {
    delete (Zotero as any).__beaverMuPDFWorkerClient_hot;
    delete (Zotero as any).__beaverMuPDFWorkerClient_background;

    (globalThis as any).Services = {
        startup: { shuttingDown: appShuttingDown },
        io: { newURI: vi.fn((uri: string) => uri) },
        obs: { addObserver: vi.fn(), removeObserver: vi.fn() },
    };

    (globalThis as any).Cc = {
        '@mozilla.org/content/style-sheet-service;1': {
            getService: vi.fn(() => ({
                sheetRegistered: vi.fn().mockReturnValue(false),
                unregisterSheet: vi.fn(),
                loadAndRegisterSheet: vi.fn(),
            })),
        },
    };

    (globalThis as any).Ci = {
        ...(globalThis as any).Ci,
        nsIFile: { DIRECTORY_TYPE: 1 },
        nsIStyleSheetService: { AUTHOR_SHEET: 'author' },
    };

    (globalThis as any).addon = {
        data: {
            alive: true,
            config: {
                addonRef: 'beaver',
                addonInstance: 'Beaver',
                addonID: 'beaver@test',
            },
        },
    };

    (globalThis as any).rootURI = 'chrome://beaver/';
    (globalThis as any).ztoolkit = { log: vi.fn(), unregisterAll: vi.fn() };

    Object.assign(globalThis.Zotero, {
        getMainWindows: vi.fn(() => []),
        getMainWindow: vi.fn(() => null),
        __beaverShuttingDown: false,
        Beaver: {},
    });
}

async function loadHooks() {
    return (await import('../../src/hooks')).default;
}

describe('closing the agent connection on window unload', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
    });

    it('names the quit when the app is going away', async () => {
        setupGlobals({ appShuttingDown: true });
        const hooks = await loadHooks();
        const close = vi.fn();
        const win = makeWindow(close);
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        await hooks.onMainWindowUnload(win);

        expect(close).toHaveBeenCalledExactlyOnceWith('Zotero quitting', {
            rememberInterruptedThread: true,
        });
    });

    it('records the interrupted chat on a quit even when another window is still open', async () => {
        setupGlobals({ appShuttingDown: true });
        const hooks = await loadHooks();
        const close = vi.fn();
        const win = makeWindow(close);
        // Every window is going away, and this one may be the one holding the
        // socket — the windows that unload later have nothing left to close.
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(close).toHaveBeenCalledExactlyOnceWith('Zotero quitting', {
            rememberInterruptedThread: true,
        });
    });

    it('names the window close, and leaves no record, while another window keeps the run on screen', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const close = vi.fn();
        const win = makeWindow(close);
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(close).toHaveBeenCalledExactlyOnceWith('Main window closed', {
            rememberInterruptedThread: false,
        });
    });

    it('records the interrupted chat when the last window closes', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const close = vi.fn();
        const win = makeWindow(close);
        // Only this window, and it is on its way out.
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        await hooks.onMainWindowUnload(win);

        expect(close).toHaveBeenCalledExactlyOnceWith('Main window closed', {
            rememberInterruptedThread: true,
        });
    });

    it('ignores a window that is already closed when counting what remains', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const close = vi.fn();
        const win = makeWindow(close);
        const gone = makeWindow();
        (gone as any).closed = true;
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, gone]);

        await hooks.onMainWindowUnload(win);

        expect(close).toHaveBeenCalledExactlyOnceWith('Main window closed', {
            rememberInterruptedThread: true,
        });
    });

    it('closes the socket before anything else in teardown', async () => {
        setupGlobals({ appShuttingDown: false });
        (Zotero as any).__beaverMuPDFWorkerClient_hot = { spawnedFromWindow: null };
        const hooks = await loadHooks();
        const close = vi.fn();
        const win = makeWindow(close);
        (Zotero as any).__beaverMuPDFWorkerClient_hot.spawnedFromWindow = win;
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(close).toHaveBeenCalled();
        expect(mockDisposeMuPDFWorker).toHaveBeenCalled();
        expect(mockCloseWindowsRenderedBy).toHaveBeenCalled();
        expect(mockRemoveChatPanel).toHaveBeenCalled();
        for (const later of [
            mockDisposeMuPDFWorker,
            mockCloseWindowsRenderedBy,
            mockRemoveChatPanel,
        ]) {
            expect(close.mock.invocationCallOrder[0]).toBeLessThan(
                later.mock.invocationCallOrder[0],
            );
        }
    });

    it('carries on when the bundle throws', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const win = makeWindow(vi.fn(() => {
            throw new Error('bundle is already gone');
        }));
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(mockRemoveChatPanel).toHaveBeenCalled();
        expect(ztoolkit.log).toHaveBeenCalledWith(
            expect.stringContaining('closeAgentConnection: Error: bundle is already gone'),
        );
    });

    it('carries on when the window has no bundle to ask', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const win = {
            closed: false,
            document: { getElementById: vi.fn().mockReturnValue(null) },
        } as unknown as Window;
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(mockRemoveChatPanel).toHaveBeenCalled();
    });
});

describe('closing the agent connection on plugin shutdown', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
    });

    it('closes every open window\'s connection when the plugin is disabled', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        vi.mocked(Zotero.getMainWindows).mockReturnValue([
            makeWindow(firstClose),
            makeWindow(secondClose),
        ]);

        await hooks.onShutdown();

        // The bundle goes away with the plugin, so both record.
        expect(firstClose).toHaveBeenCalledExactlyOnceWith('Beaver plugin shutting down', {
            rememberInterruptedThread: true,
        });
        expect(secondClose).toHaveBeenCalledExactlyOnceWith('Beaver plugin shutting down', {
            rememberInterruptedThread: true,
        });
    });
});
