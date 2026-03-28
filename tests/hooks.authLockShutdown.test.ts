import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockCloseBeaverWindow,
    mockClosePreferencesWindow,
    mockCleanupContextMenus,
    mockCancelAllActiveTasks,
    mockDisposeMuPDF,
    mockRegisterChatPanel,
    mockRegisterShortcuts,
    mockRemoveChatPanel,
    mockUiManagerCleanup,
    mockUnregisterBeaverProtocolHandler,
    mockUnregisterShortcuts,
} = vi.hoisted(() => ({
    mockCloseBeaverWindow: vi.fn(),
    mockClosePreferencesWindow: vi.fn(),
    mockCleanupContextMenus: vi.fn(),
    mockCancelAllActiveTasks: vi.fn(),
    mockDisposeMuPDF: vi.fn().mockResolvedValue(undefined),
    mockRegisterChatPanel: vi.fn(),
    mockRegisterShortcuts: vi.fn(),
    mockRemoveChatPanel: vi.fn(),
    mockUiManagerCleanup: vi.fn(),
    mockUnregisterBeaverProtocolHandler: vi.fn(),
    mockUnregisterShortcuts: vi.fn(),
}));

vi.mock('../src/ui/ui', () => ({
    BeaverUIFactory: {
        registerChatPanel: mockRegisterChatPanel,
        removeChatPanel: mockRemoveChatPanel,
        registerShortcuts: mockRegisterShortcuts,
        unregisterShortcuts: mockUnregisterShortcuts,
        closeBeaverWindow: mockCloseBeaverWindow,
        closePreferencesWindow: mockClosePreferencesWindow,
    },
}));

vi.mock('../src/utils/mupdf', () => ({
    disposeMuPDF: mockDisposeMuPDF,
}));

vi.mock('../react/ui/UIManager', () => ({
    uiManager: {
        cleanup: mockUiManagerCleanup,
    },
}));

vi.mock('../src/services/protocolHandler', () => ({
    registerBeaverProtocolHandler: vi.fn(),
    unregisterBeaverProtocolHandler: mockUnregisterBeaverProtocolHandler,
}));

vi.mock('../src/utils/backgroundTasks', () => ({
    cancelAllActiveTasks: mockCancelAllActiveTasks,
}));

vi.mock('../src/modules/zoteroContextMenu', () => ({
    initContextMenus: vi.fn(),
    cleanupContextMenus: mockCleanupContextMenus,
}));

vi.mock('../src/utils/locale', () => ({
    initLocale: vi.fn(),
}));

vi.mock('../src/utils/ztoolkit', () => ({
    createZToolkit: vi.fn(),
}));

vi.mock('../src/services/CitationService', () => ({
    CitationService: class MockCitationService {},
}));

vi.mock('../src/services/database', () => ({
    BeaverDB: class MockBeaverDB {},
}));

vi.mock('../src/services/attachmentFileCache', () => ({
    AttachmentFileCache: class MockAttachmentFileCache {},
}));

vi.mock('../react/eventBus', () => ({
    default: {},
}));

vi.mock('../src/utils/prefs', () => ({
    getPref: vi.fn(),
    setPref: vi.fn(),
}));

vi.mock('../src/utils/versionNotificationPrefs', () => ({
    addPendingVersionNotification: vi.fn(),
}));

vi.mock('../react/constants/versionUpdateMessages', () => ({
    getAllVersionUpdateMessageVersions: vi.fn(() => []),
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
    return {
        closed: false,
        document: {
            getElementById: vi.fn().mockReturnValue(null),
        },
    } as Window & Record<string, unknown>;
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
    return (await import('../src/hooks')).default;
}

describe('hooks auth lock shutdown cleanup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        setupGlobals();
        mockDisposeMuPDF.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
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
