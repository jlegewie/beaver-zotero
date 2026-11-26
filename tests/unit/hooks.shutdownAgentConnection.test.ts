import { BeaverInstance } from '../../src/runtime/instance';
/**
 * Closing a window only stops it viewing its chat (`addon.agentRuns`); runs
 * go on. Quitting Zotero or disabling Beaver ends every run, once writes have
 * settled.
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
    mockUnregisterShortcuts,
} = vi.hoisted(() => ({
    mockCloseBeaverWindow: vi.fn(),
    mockClosePreferencesWindow: vi.fn(),
    mockCleanupContextMenus: vi.fn(),
    mockCancelAllActiveTasks: vi.fn(),
    mockCloseWindowsRenderedBy: vi.fn(),
    mockDisposeMuPDFWorker: vi.fn().mockResolvedValue(undefined),
    mockRemoveChatPanel: vi.fn(),
    mockUnregisterShortcuts: vi.fn(),
}));

vi.mock('../../src/ui/ui', () => ({
    BeaverUIFactory: {
        closeBeaverWindow: vi.fn(),
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
vi.mock('../../src/utils/prefs', () => ({ getPref: vi.fn(), setPref: vi.fn() }));
vi.mock('../../src/utils/versionNotificationPrefs', () => ({
    addPendingVersionNotification: vi.fn(),
}));
vi.mock('../../react/constants/versionUpdateMessages', () => ({
    getAllVersionUpdateMessageVersions: vi.fn(() => []),
}));

/** What detaching each window from the registry does, by window id. */
const detachers = new Map<string, () => unknown>();

/** A chat window; `detach` stands for the registry letting go of it. */
function makeWindow(detach: (() => unknown) | null = vi.fn()) {
    const win = {
        EventTarget,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        closed: false,
        document: { getElementById: vi.fn().mockReturnValue(null), querySelector: vi.fn().mockReturnValue(null) },
    } as unknown as Window & Record<string, any>;
    (globalThis as any).addon.runtime.attachWindow(win);
    const id = (globalThis as any).addon.runtime.getWindow(win).id;
    if (detach) detachers.set(id, detach);
    return win;
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
        threads: { start: vi.fn(), dispose: vi.fn() },
        presence: { dispose: vi.fn() },
        runtime: new BeaverInstance(),
        agentRuns: {
            detachWindow: vi.fn((windowId: string) => detachers.get(windowId)?.()),
            shutdown: vi.fn(),
            dispose: vi.fn(),
        },
        mutations: { cancelOwner: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) },
        itemImport: { dispose: vi.fn() },
        images: { dispose: vi.fn() },
        notePreviews: { detachOwner: vi.fn().mockResolvedValue(undefined) },
        syncPause: { releaseOwnerRuns: vi.fn(), scheduleResumeAfterRun: vi.fn(), resumeSyncNow: vi.fn() },
        transactionWatch: { start: vi.fn(), stop: vi.fn(), openAgeMs: vi.fn(() => 0) },
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

describe('a chat window unloading', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
    });

    it.each([
        ['another main window remains', true],
        ['the last main window closes', false],
    ])('only stops viewing its chat when %s and Zotero runs on', async (_case, another) => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const detach = vi.fn();
        const win = makeWindow(detach);
        vi.mocked(Zotero.getMainWindows).mockReturnValue(another ? [win, makeWindow()] : [win]);

        await hooks.onMainWindowUnload(win);

        expect(detach).toHaveBeenCalledOnce();
        // Nothing is stopped or recorded as interrupted.
        expect((globalThis as any).addon.agentRuns.shutdown).not.toHaveBeenCalled();
    });

    it('ends every run when Zotero quits, once writes have settled', async () => {
        setupGlobals({ appShuttingDown: true });
        const hooks = await loadHooks();
        const instance = (globalThis as any).addon;
        let settle!: () => void;
        instance.mutations.dispose = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
        const win = makeWindow();
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        const unloading = hooks.onMainWindowUnload(win);
        await Promise.resolve();
        expect(instance.agentRuns.shutdown).not.toHaveBeenCalled();
        settle();
        await unloading;
        expect(instance.agentRuns.shutdown).toHaveBeenCalledExactlyOnceWith('Zotero quitting');
    });

    it("keeps a window open after its last Zotero 11 library view closes", async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const detach = vi.fn();
        const win = makeWindow(detach);
        // Zotero 11 reports the unload while the window's readers stay open.
        win.ZoteroPane = { libraryViews: [] };
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        await hooks.onMainWindowUnload(win);

        expect(detach).not.toHaveBeenCalled();
        expect((globalThis as any).addon.runtime.getWindow(win)).toBeDefined();
    });

    it("lets go of a window without library views when it itself unloads", async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const detach = vi.fn();
        const win = makeWindow(detach);
        win.ZoteroPane = { libraryViews: [] };
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        await hooks.onMainWindowUnload(win, { windowUnloading: true });

        expect(detach).toHaveBeenCalledOnce();
    });

    it('stops viewing before the window\'s UI is torn down', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const detach = vi.fn();
        const win = makeWindow(detach);
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(mockDisposeMuPDFWorker).not.toHaveBeenCalled();
        for (const later of [mockCloseWindowsRenderedBy, mockRemoveChatPanel]) {
            expect(detach.mock.invocationCallOrder[0]).toBeLessThan(later.mock.invocationCallOrder[0]);
        }
    });

    it('carries on when letting go of the window throws', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const win = makeWindow(vi.fn(() => {
            throw new Error('registry is gone');
        }));
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win, makeWindow()]);

        await hooks.onMainWindowUnload(win);

        expect(mockRemoveChatPanel).toHaveBeenCalled();
        expect(ztoolkit.log).toHaveBeenCalledWith(
            expect.stringContaining('detachFromAgentRuns: Error: registry is gone'),
        );
    });
});

describe('closing the agent connection on plugin shutdown', () => {
    it('shares one disposal when shutdown is requested concurrently', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const closeDatabase = vi.fn().mockResolvedValue(undefined);
        (globalThis as any).addon.db = { closeDatabase };
        const first = hooks.onShutdown();
        const second = hooks.onShutdown();
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(closeDatabase).toHaveBeenCalledOnce();
        await hooks.onShutdown();
        expect(closeDatabase).toHaveBeenCalledOnce();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
    });

    it('ends every run when the plugin is disabled, and lets go of every window', async () => {
        setupGlobals({ appShuttingDown: false });
        const hooks = await loadHooks();
        const runs = (globalThis as any).addon.agentRuns;
        const first = vi.fn();
        const second = vi.fn();
        vi.mocked(Zotero.getMainWindows).mockReturnValue([makeWindow(first), makeWindow(second)]);

        await hooks.onShutdown();

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(runs.dispose).toHaveBeenCalledExactlyOnceWith('Beaver plugin shutting down');
    });
});

describe('late application shutdown', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
        setupGlobals({ appShuttingDown: true });
    });

    it('disposes services once without accessing windows or UI registries', async () => {
        const hooks = await loadHooks();
        const instance = (globalThis as any).addon;
        const stopWatcher = vi.fn();
        const stopReconciler = vi.fn();
        const stopExtractor = vi.fn().mockResolvedValue(undefined);
        const closeDatabase = vi.fn().mockResolvedValue(undefined);
        const disposeCitation = vi.fn();
        instance.newItemWatcher = { stop: stopWatcher };
        instance.processingReconciler = { stop: stopReconciler };
        instance.backgroundExtractor = { stop: stopExtractor };
        instance.db = { closeDatabase };
        instance.citationService = { dispose: disposeCitation };
        const disposeRuntime = vi.spyOn(instance.runtime, 'disposeInstance');
        vi.mocked(Zotero.getMainWindows).mockImplementation(() => { throw new Error('Windows destroyed'); });
        vi.mocked(Zotero.getMainWindow).mockImplementation(() => { throw new Error('Window destroyed'); });

        const first = hooks.onAppShutdown();
        expect(hooks.onAppShutdown()).toBe(first);
        await first;
        for (const cleanup of [stopWatcher, stopReconciler, stopExtractor, closeDatabase, disposeCitation, mockDisposeMuPDFWorker]) {
            expect(cleanup).toHaveBeenCalledOnce();
        }
        expect(Zotero.getMainWindows).not.toHaveBeenCalled();
        expect(Zotero.getMainWindow).not.toHaveBeenCalled();
        for (const cleanup of [disposeRuntime, mockRemoveChatPanel, mockCloseWindowsRenderedBy, mockUnregisterShortcuts, mockCleanupContextMenus, mockCloseBeaverWindow]) {
            expect(cleanup).not.toHaveBeenCalled();
        }
        expect(instance.db).toBeUndefined();
        expect(instance.data.alive).toBe(false);
        expect(Zotero.__beaverShuttingDown).toBe(true);
    });

    it('ends the runs no window holds at app shutdown, after writes settle', async () => {
        // Zotero may quit with no window open (the last one closed earlier).
        const hooks = await loadHooks();
        const instance = (globalThis as any).addon;
        await hooks.onAppShutdown();
        expect(instance.agentRuns.shutdown).toHaveBeenCalledExactlyOnceWith('Zotero quitting');
        expect(instance.mutations.dispose.mock.invocationCallOrder[0])
            .toBeLessThan(instance.agentRuns.shutdown.mock.invocationCallOrder[0]);
        expect(instance.agentRuns.dispose).not.toHaveBeenCalled();
    });

    it('continues service cleanup after failures and preserves the DB fallback', async () => {
        const hooks = await loadHooks();
        const instance = (globalThis as any).addon;
        instance.newItemWatcher = { stop: vi.fn(() => { throw new Error('watcher failed'); }) };
        instance.backgroundExtractor = { stop: vi.fn().mockRejectedValue(new Error('extractor failed')) };
        const closeDatabase = vi.fn().mockRejectedValue(new Error('database failed'));
        instance.db = { closeDatabase };
        const dispose = vi.fn();
        instance.citationService = { dispose };
        await hooks.onAppShutdown();
        expect(mockDisposeMuPDFWorker).toHaveBeenCalledOnce();
        expect(closeDatabase).toHaveBeenCalledOnce();
        expect(instance.db.closeDatabase).toBe(closeDatabase);
        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe('quitting with several windows', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDisposeMuPDFWorker.mockResolvedValue(undefined);
        setupGlobals({ appShuttingDown: true });
    });

    it('runs the app-wide cleanup once when every window reads as closed', async () => {
        const hooks = await loadHooks();
        const instance = (globalThis as any).addon;
        const closeDatabase = vi.fn().mockResolvedValue(undefined);
        instance.db = { closeDatabase };
        const disposeRuntime = vi.spyOn(instance.runtime, 'disposeInstance');
        const detachFirst = vi.fn();
        const detachSecond = vi.fn();
        const first = makeWindow(detachFirst);
        const second = makeWindow(detachSecond);
        // During a quit the other windows already read as closed, so each
        // unload takes itself for the last window.
        (first as any).closed = true;
        (second as any).closed = true;
        vi.mocked(Zotero.getMainWindows).mockReturnValue([first, second]);

        await hooks.onMainWindowUnload(first);
        // The registry is still live for the window that has yet to unload.
        expect(closeDatabase).not.toHaveBeenCalled();
        expect(disposeRuntime).not.toHaveBeenCalled();
        await hooks.onMainWindowUnload(second);

        expect(closeDatabase).toHaveBeenCalledOnce();
        expect(disposeRuntime).toHaveBeenCalledOnce();
        expect(mockUnregisterShortcuts).toHaveBeenCalledOnce();
        // Each window still tears down its own UI; the runs end with the first.
        expect(mockRemoveChatPanel).toHaveBeenCalledWith(first);
        expect(mockRemoveChatPanel).toHaveBeenCalledWith(second);
        expect(detachFirst).toHaveBeenCalledOnce();
        expect(detachSecond).toHaveBeenCalledOnce();
        expect(instance.agentRuns.shutdown).toHaveBeenCalledWith('Zotero quitting');
    });

    it('shares the database close between overlapping shutdown paths', async () => {
        const hooks = await loadHooks();
        const instance = (globalThis as any).addon;
        let finishClose!: () => void;
        const closeDatabase = vi.fn(() => new Promise<void>(resolve => { finishClose = resolve; }));
        instance.db = { closeDatabase };
        const win = makeWindow();
        vi.mocked(Zotero.getMainWindows).mockReturnValue([win]);

        const unload = hooks.onMainWindowUnload(win);
        await vi.waitFor(() => expect(closeDatabase).toHaveBeenCalledOnce());
        // APP_SHUTDOWN arrives while the window's cleanup is still closing it.
        const appShutdown = hooks.onAppShutdown();
        // Let APP_SHUTDOWN reach its own database step before the close settles.
        await new Promise(resolve => setTimeout(resolve, 20));
        finishClose();
        await Promise.all([unload, appShutdown]);

        expect(closeDatabase).toHaveBeenCalledOnce();
        expect(instance.db).toBeUndefined();
    });
});
