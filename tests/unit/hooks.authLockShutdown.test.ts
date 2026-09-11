import { BeaverInstance } from '../../src/runtime/instance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockCloseBeaverWindow,
    mockClosePreferencesWindow,
    mockCleanupContextMenus,
    mockCancelAllActiveTasks,
    mockDisposeMuPDFWorker,
    mockRegisterChatPanel,
    mockRegisterShortcuts,
    mockRemoveChatPanel,
    mockUnregisterBeaverProtocolHandler,
    mockUnregisterShortcuts,
} = vi.hoisted(() => ({
    mockCloseBeaverWindow: vi.fn(),
    mockClosePreferencesWindow: vi.fn(),
    mockCleanupContextMenus: vi.fn(),
    mockCancelAllActiveTasks: vi.fn(),
    mockDisposeMuPDFWorker: vi.fn().mockResolvedValue(undefined),
    mockRegisterChatPanel: vi.fn(),
    mockRegisterShortcuts: vi.fn(),
    mockRemoveChatPanel: vi.fn(),
    mockUnregisterBeaverProtocolHandler: vi.fn(),
    mockUnregisterShortcuts: vi.fn(),
}));

vi.mock('../../src/ui/ui', () => ({
    BeaverUIFactory: {
        registerChatPanel: mockRegisterChatPanel,
        removeChatPanel: mockRemoveChatPanel,
        registerShortcuts: mockRegisterShortcuts,
        unregisterShortcuts: mockUnregisterShortcuts,
        closeWindowsRenderedBy: vi.fn(),
        closeBeaverWindow: mockCloseBeaverWindow,
        closePreferencesWindow: mockClosePreferencesWindow,
    },
}));

vi.mock('../../src/beaver-extract', () => ({
    disposeMuPDFWorker: mockDisposeMuPDFWorker,
}));


vi.mock('../../src/services/protocolHandler', () => ({
    registerBeaverProtocolHandler: vi.fn(),
    unregisterBeaverProtocolHandler: mockUnregisterBeaverProtocolHandler,
}));

vi.mock('../../src/utils/backgroundTasks', () => ({
    cancelAllActiveTasks: mockCancelAllActiveTasks,
}));

vi.mock('../../src/modules/zoteroContextMenu', () => ({
    initContextMenus: vi.fn(),
    cleanupContextMenus: mockCleanupContextMenus,
}));

vi.mock('../../src/utils/locale', () => ({
    initLocale: vi.fn(),
}));

vi.mock('../../src/utils/ztoolkit', () => ({
    createZToolkit: vi.fn(),
}));

vi.mock('../../src/services/CitationService', () => ({
    CitationService: class MockCitationService {},
}));

vi.mock('../../src/services/database', () => ({
    BeaverDB: class MockBeaverDB {
        initDatabase = vi.fn().mockResolvedValue(undefined);
        closeDatabase = vi.fn().mockResolvedValue(undefined);
    },
}));

vi.mock('../../src/services/backgroundExtractor', () => ({
    BackgroundExtractor: class MockBackgroundExtractor {
        start = vi.fn();
        stop = vi.fn().mockResolvedValue(undefined);
        processOnce = vi.fn().mockResolvedValue({ processed: false });
    },
}));

vi.mock('../../react/eventBus', () => ({
    default: {},
}));

vi.mock('../../src/utils/prefs', () => ({
    getPref: vi.fn(),
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

vi.mock('../../src/utils/versionNotificationPrefs', () => ({
    addPendingVersionNotification: vi.fn(),
}));

vi.mock('../../react/constants/versionUpdateMessages', () => ({
    getAllVersionUpdateMessageVersions: vi.fn(() => []),
}));

vi.mock('../../src/services/voice/voiceService', () => ({
    createVoiceService: vi.fn(() => { throw new Error('Timer module unavailable'); }),
}));
vi.mock('../../src/services/voice/developmentHarness', () => ({
    DevelopmentVoiceHarness: vi.fn(function () { throw new Error('Timer module unavailable'); }),
}));
vi.mock('../../src/services/documentCache', () => ({
    DocumentCache: class {
        init = vi.fn().mockResolvedValue(undefined);
        runStartupGC = vi.fn().mockResolvedValue(undefined);
    },
}));
vi.mock('../../src/utils/configurePDFForBeaver', () => ({ configurePDFForBeaver: vi.fn() }));
vi.mock('../../src/modules/readerIntegration', () => ({ initReaderIntegration: vi.fn(), cleanupReaderIntegration: vi.fn() }));
vi.mock('../../src/modules/readerToolbarMenu', () => ({ initReaderToolbarMenu: vi.fn(), cleanupReaderToolbarMenu: vi.fn() }));
vi.mock('../../src/services/artifacts/view/readerTableView', () => ({
    initReaderTableViews: vi.fn(), cleanupReaderTableViews: vi.fn(), cleanupReaderTableViewsForWindow: vi.fn(),
}));
vi.mock('../../src/ui/tableItemPane', () => ({ initTableItemPane: vi.fn(), cleanupTableItemPane: vi.fn() }));
vi.mock('../../src/services/artifacts/tablesApiHost', () => ({
    registerTablesApi: vi.fn(), unregisterTablesApi: vi.fn(), unregisterTableShadowRestore: vi.fn(),
}));

function makeAuthLock() {
    return {
        locked: true,
        queue: [],
        lockName: 'refresh-session',
        lockToken: 1,
        tokenCounter: 1,
    };
}

function makeWindow() {
    const win = {
        EventTarget,
        closed: false,
        document: {
            getElementById: vi.fn().mockReturnValue(null),
        },
    } as Window & Record<string, unknown>;
    (globalThis as any).addon.runtime.attachWindow(win);
    return win;
}

function setupGlobals() {
    const styleSheetService = {
        sheetRegistered: vi.fn().mockReturnValue(false),
        unregisterSheet: vi.fn(),
        loadAndRegisterSheet: vi.fn(),
    };

    (globalThis as any).Services = {
        startup: {
            shuttingDown: true,
        },
        io: {
            newURI: vi.fn((uri: string) => uri),
        },
        obs: {
            addObserver: vi.fn(),
            removeObserver: vi.fn(),
        },
    };

    (globalThis as any).Cc = {
        '@mozilla.org/content/style-sheet-service;1': {
            getService: vi.fn(() => styleSheetService),
        },
    };

    (globalThis as any).Ci = {
        ...(globalThis as any).Ci,
        nsIFile: {
            DIRECTORY_TYPE: 1,
        },
        nsIStyleSheetService: {
            AUTHOR_SHEET: 'author',
        },
    };

    (globalThis as any).addon = {
        runtime: new BeaverInstance(),
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
    (globalThis as any).ztoolkit = {
        log: vi.fn(),
        unregisterAll: vi.fn(),
    };

    Object.assign(globalThis.Zotero, {
        getMainWindows: vi.fn(() => []),
        getMainWindow: vi.fn(() => null),
        __beaverShuttingDown: false,
        Beaver: {},
    });

    return { styleSheetService };
}

async function loadHooks() {
    return (await import('../../src/hooks')).default;
}

describe('hooks auth lock shutdown cleanup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        setupGlobals();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('cancels the originating voice session when a main window unloads', async () => {
        const hooks = await loadHooks();
        const win = makeWindow();
        const voice = { windowUnloaded: vi.fn(), dispose: vi.fn() };
        (globalThis as any).addon.voice = voice;
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);
        await hooks.onMainWindowUnload(win);
        expect(voice.windowUnloaded).toHaveBeenCalledWith(win);
        expect(voice.dispose).not.toHaveBeenCalled();
    });

    it('disposes and removes the plugin voice service on shutdown', async () => {
        const hooks = await loadHooks();
        const voice = { dispose: vi.fn() };
        (globalThis as any).addon.voice = voice;
        await hooks.onShutdown();
        expect(voice.dispose).toHaveBeenCalledOnce();
        expect((globalThis as any).addon.voice).toBeUndefined();
    });

    it.each(['production', 'development'])('continues essential startup when optional voice initialization fails in %s', async env => {
        (globalThis as any).__env__ = env;
        (globalThis as any).Services.startup.shuttingDown = false;
        const testConnection = vi.fn().mockResolvedValue(undefined);
        (Zotero as any).DBConnection = vi.fn(function () { return { test: testConnection }; });
        (Zotero as any).PreferencePanes = { register: vi.fn().mockResolvedValue(undefined) };
        const hooks = await loadHooks();
        await hooks.onStartup();
        expect(testConnection).toHaveBeenCalledOnce();
        expect((globalThis as any).addon.db.initDatabase).toHaveBeenCalledOnce();
        expect((globalThis as any).addon.db.closeDatabase).not.toHaveBeenCalled();
        expect(mockRegisterShortcuts).toHaveBeenCalledOnce();
        expect(Zotero.PreferencePanes.register).toHaveBeenCalledOnce();
        expect((globalThis as any).addon.voice).toBeUndefined();
        expect((globalThis as any).addon.voiceHarness).toBeUndefined();
        const prefs = await import('../../src/utils/prefs');
        expect(prefs.clearPref).toHaveBeenCalledWith('backgroundProcessingContinuous');
    });

    it('continues window cleanup after voice unload throws', async () => {
        const hooks = await loadHooks(); const win = makeWindow();
        (globalThis as any).addon.voice = { windowUnloaded: vi.fn(() => { throw new Error('voice failure'); }) };
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);
        await hooks.onMainWindowUnload(win);
        expect(mockRemoveChatPanel).toHaveBeenCalledWith(win);
    });

    it('closes the database and other services after voice disposal throws', async () => {
        const hooks = await loadHooks();
        const stop = vi.fn().mockResolvedValue(undefined), closeDatabase = vi.fn().mockResolvedValue(undefined);
        (globalThis as any).addon.voice = { dispose: vi.fn(() => { throw new Error('voice failure'); }) };
        (globalThis as any).addon.voiceHarness = {};
        (globalThis as any).addon.db = { closeDatabase };
        (globalThis as any).addon.backgroundExtractor = { stop };
        await hooks.onShutdown();
        expect(stop).toHaveBeenCalledOnce(); expect(closeDatabase).toHaveBeenCalledOnce();
        expect((globalThis as any).addon.runtime.getSnapshot()).toEqual([]);
        expect((globalThis as any).addon.voice).toBeUndefined();
        expect((globalThis as any).addon.voiceHarness).toBeUndefined();
    });

    it('clears the persisted auth lock during full shutdown unload', async () => {
        const hooks = await loadHooks();
        const win = makeWindow();
        win.__beaverAuthLock = makeAuthLock();
        win.__beaverDisposeSupabase = vi.fn().mockResolvedValue(undefined);

        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        await hooks.onMainWindowUnload(win);

        expect(win.__beaverDisposeSupabase).toBeUndefined();
        expect('__beaverAuthLock' in win).toBe(false);
        expect(mockCancelAllActiveTasks).toHaveBeenCalledOnce();
    });

    it('clears the persisted auth lock even if Supabase disposal throws during unload', async () => {
        const hooks = await loadHooks();
        const win = makeWindow();
        win.__beaverAuthLock = makeAuthLock();
        win.__beaverDisposeSupabase = vi.fn().mockRejectedValue(new Error('dispose failed'));

        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        await hooks.onMainWindowUnload(win);

        expect(win.__beaverDisposeSupabase).toBeUndefined();
        expect('__beaverAuthLock' in win).toBe(false);
        expect(ztoolkit.log).toHaveBeenCalledWith(expect.stringContaining('disposeSupabase: Error: dispose failed'));
    });

    it('clears the persisted auth lock after a timed-out Supabase disposal during unload', async () => {
        vi.useFakeTimers();

        const hooks = await loadHooks();
        const win = makeWindow();
        win.__beaverAuthLock = makeAuthLock();
        win.__beaverDisposeSupabase = vi.fn(() => new Promise<void>(() => {}));

        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        const unloadPromise = hooks.onMainWindowUnload(win);
        await vi.advanceTimersByTimeAsync(3000);
        await unloadPromise;

        expect(win.__beaverDisposeSupabase).toBeUndefined();
        expect('__beaverAuthLock' in win).toBe(false);
        expect(Zotero.debug).toHaveBeenCalledWith(expect.stringContaining('disposeSupabase timed out after 3000ms'));
    });

    it('clears the persisted auth lock in fallback shutdown cleanup', async () => {
        const hooks = await loadHooks();
        const mainWin = makeWindow();
        mainWin.__beaverAuthLock = makeAuthLock();
        mainWin.__beaverDisposeSupabase = vi.fn().mockRejectedValue(new Error('dispose failed'));

        vi.mocked(Zotero.getMainWindow).mockReturnValue(mainWin);

        await hooks.onShutdown();

        expect(mainWin.__beaverDisposeSupabase).toBeUndefined();
        expect('__beaverAuthLock' in mainWin).toBe(false);
    });
});
