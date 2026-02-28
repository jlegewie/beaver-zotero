import { version } from "../package.json";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import eventBus from "../react/eventBus";
import { CitationService } from "./services/CitationService";
import { BeaverDB } from "./services/database";
import { AttachmentFileCache } from "./services/attachmentFileCache";
import { uiManager } from "../react/ui/UIManager";
import { getPref, setPref } from "./utils/prefs";
import { addPendingVersionNotification } from "./utils/versionNotificationPrefs";
import { getAllVersionUpdateMessageVersions } from "../react/constants/versionUpdateMessages";
import { disposeMuPDF } from "./utils/mupdf";
import { registerBeaverProtocolHandler, unregisterBeaverProtocolHandler } from "./services/protocolHandler";
import { cancelAllActiveTasks } from "./utils/backgroundTasks";

/** Timeout for individual async shutdown operations to prevent hangs. */
const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * Race a promise against a timeout. Returns the promise result if it
 * settles before the deadline, otherwise resolves with `undefined` and
 * logs a warning.  Never rejects – callers should still wrap in try/catch
 * for safety, but a stalled operation will not block shutdown.
 */
function withShutdownTimeout<T>(
    promise: Promise<T>,
    label: string,
): Promise<T | undefined> {
    let timeoutId: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<undefined>((resolve) => {
            timeoutId = setTimeout(() => {
                Zotero.debug(`[beaver] onMainWindowUnload: ${label} timed out after ${SHUTDOWN_TIMEOUT_MS}ms, continuing shutdown`);
                resolve(undefined);
            }, SHUTDOWN_TIMEOUT_MS);
        }),
    ]).finally(() => clearTimeout(timeoutId));
}

let isAppQuitting = false;
let quitObserverRegistered = false;
const quitObserver = {
    observe(subject: any, topic: string) {
        if (topic === "quit-application" || topic === "quit-application-granted") {
            isAppQuitting = true;
        }
    },
};

function registerQuitObserver(): void {
    if (quitObserverRegistered) return;
    try {
        Services.obs.addObserver(quitObserver, "quit-application-granted");
        Services.obs.addObserver(quitObserver, "quit-application");
        quitObserverRegistered = true;
    } catch (error) {
        ztoolkit.log(`registerQuitObserver: Failed to register quit observer: ${error}`);
    }
}

function unregisterQuitObserver(): void {
    if (!quitObserverRegistered) return;
    try {
        Services.obs.removeObserver(quitObserver, "quit-application-granted");
        Services.obs.removeObserver(quitObserver, "quit-application");
    } catch (error) {
        ztoolkit.log(`unregisterQuitObserver: Failed to unregister quit observer: ${error}`);
    } finally {
        quitObserverRegistered = false;
    }
}

/**
 * Compares two semantic version strings.
 * @param v1 Version string 1
 * @param v2 Version string 2
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
 */
function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const len = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

/**
 * Handles upgrade tasks between plugin versions.
 * @param lastVersion The previously installed version
 * @param currentVersion The current plugin version
 */
async function handleUpgrade(lastVersion: string, currentVersion: string) {
    const knownVersions = getAllVersionUpdateMessageVersions();
    if (knownVersions.length && lastVersion) {
        const versionsToNotify = knownVersions
            .filter((versionToNotify) =>
                compareVersions(lastVersion, versionToNotify) < 0 &&
                compareVersions(currentVersion, versionToNotify) >= 0,
            )
            .sort(compareVersions);

        versionsToNotify.forEach((versionToNotify) => {
            addPendingVersionNotification(versionToNotify);
            ztoolkit.log(`handleUpgrade: Queued version notification for ${versionToNotify}.`);
        });
    }

    // Upgrade to 0.5.0 or newer from a version before 0.5.0
    if (compareVersions(lastVersion, '0.5.0') < 0 && compareVersions(currentVersion, '0.5.0') >= 0) {
        setPref('runConsistencyCheck', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for consistency check.`);
    }

    // Upgrade to 0.6.2 or newer from a version before 0.6.2
    if (compareVersions(lastVersion, '0.6.2') < 0 && compareVersions(currentVersion, '0.6.2') >= 0) {
        setPref('runCollectionSync', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for collection sync.`);
    }

    // Upgrade to 0.8.3 or newer
    if (compareVersions(lastVersion, '0.8.3') < 0 && compareVersions(currentVersion, '0.8.3') >= 0) {
        setPref('runWebDAVSync', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for WebDAV sync.`);
    }

    // Upgrade to 0.11.2 or newer: re-sync items with corrected title/date field mappings
    if (compareVersions(lastVersion, '0.11.2') < 0 && compareVersions(currentVersion, '0.11.2') >= 0) {
        setPref('runConsistencyCheck', true);
        setPref('runEmbeddingFullDiff', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flags set for consistency check and embedding full diff.`);
    }
}

async function onStartup() {
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);

    // If the user quit Zotero before plugins finished initializing, the
    // promises above still resolve but the app is already tearing down.
    // Bail out to avoid opening resources that can never be cleaned up.
    if (Services?.startup?.shuttingDown || Zotero.__beaverShuttingDown) {
        ztoolkit.log("Startup aborted: app is already shutting down");
        return;
    }

    registerQuitObserver();
    initLocale();
    ztoolkit.log("Startup");

    // -------- Store plugin version --------
    addon.pluginVersion = version;
    ztoolkit.log(`Plugin version: ${version}`);

    // -------- Initialize database --------
    // Wrap in try/catch so that if any later initialization step fails
    // (e.g. main window already destroyed), we still close the DB
    // connection.  An unclosed connection triggers a FATAL AsyncShutdown
    // timeout crash in Mozilla's Sqlite.sys.mjs shutdown blocker.
    const dbConnection = new Zotero.DBConnection("beaver");
    const beaverDB = new BeaverDB(dbConnection);
    addon.db = beaverDB;

    try {
        // Test connection and initialize schema
        await dbConnection.test();
        await beaverDB.initDatabase(version);

        // -------- Initialize Attachment File Cache --------
        const attachmentFileCache = new AttachmentFileCache(beaverDB);
        await attachmentFileCache.init();
        await attachmentFileCache.runStartupGC();
        addon.attachmentFileCache = attachmentFileCache;
        ztoolkit.log("AttachmentFileCache initialized successfully");

        // -------- Initialize Citation Service with caching --------
        const citationService = new CitationService(ztoolkit);
        addon.citationService = citationService;
        ztoolkit.log("CitationService initialized successfully");

        // -------- Register keyboard shortcuts --------
        BeaverUIFactory.registerShortcuts();

        // -------- Add event bus to window --------
        const mainWindow = Zotero.getMainWindow();
        if (mainWindow) {
            mainWindow.__beaverEventBus = eventBus;
        }

        // -------- Register protocol handler (zotero://beaver) --------
        registerBeaverProtocolHandler();

        // -------- Load UI for all windows --------
        const mainWindows = Zotero.getMainWindows();
        if (mainWindows.length > 0) {
            await Promise.all(
                mainWindows.map((win) => onMainWindowLoad(win)),
            );
        }

        // -------- Handle plugin upgrade --------
        const lastVersion = getPref('installedVersion');
        if (lastVersion && lastVersion !== version) {
            await handleUpgrade(lastVersion, version);
        }

        // -------- Set installed version --------
        setPref('installedVersion', version);
        ztoolkit.log(`Installed version: ${getPref('installedVersion')}`);
    } catch (error) {
        // If startup fails after opening the DB, close it immediately
        // to prevent AsyncShutdown timeout → FATAL ERROR crash.
        ztoolkit.log(`Startup failed, closing database: ${error}`);
        try {
            if (addon.db) {
                await addon.db.closeDatabase();
                addon.db = undefined;
            }
        } catch (closeError) {
            ztoolkit.log(`Failed to close database during startup error recovery: ${closeError}`);
        }
        throw error;
    }
}

async function onMainWindowLoad(win: Window): Promise<void> {
    // Create ztoolkit for every window
    addon.data.ztoolkit = createZToolkit();

    win.MozXULElement.insertFTLIfNeeded(
        `${addon.data.config.addonRef}-mainWindow.ftl`,
    );

    // Wait for the UI to be ready
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);

    // Assign the global eventBus instance to this window.
    win.__beaverEventBus = eventBus;

    BeaverUIFactory.registerChatPanel(win);

    ztoolkit.log("UI ready");
    
    // Load styles for this window
    loadStylesheet();
    loadKatexStylesheet();
    ztoolkit.log("Styles loaded for window");
}

/**
 * Cleanup handler for main window unload.
 * 
 * IMPORTANT: This is where ALL cleanup must happen because:
 * 1. onShutdown() is called AFTER Zotero's internal shutdown begins
 * 2. By the time onShutdown() runs, the crash has already occurred
 * 3. Cleanup must happen during window unload, before Zotero's internal cleanup
 * 
 * The cleanup order matters to prevent SIGSEGV crashes:
 * 1. Dispose native resources (MuPDF WASM, database)
 * 2. Unregister Zotero.Reader event listeners 
 * 3. Restore Zotero.Reader.onChangeSidebarWidth
 * 4. Unmount React components
 * 5. Unload stylesheets
 */
async function onMainWindowUnload(win: Window): Promise<void> {
    ztoolkit.log("onMainWindowUnload: Starting cleanup");
    
    try {
        // Determine cleanup scope BEFORE unmounting React, so we can set
        // the shutdown flag before React cleanup effects run.
        const remainingWindows = Zotero.getMainWindows().filter(w => w !== win && !w.closed);
        const isLastWindow = remainingWindows.length === 0;
        const isAppShuttingDown = Services?.startup?.shuttingDown ?? false;
        const shouldRunGlobalCleanup = isLastWindow && (isAppQuitting || isAppShuttingDown);

        // If this is a full shutdown, signal it BEFORE React unmount.
        // React cleanup effects (useZoteroSync, useEmbeddingIndex, etc.)
        // check this flag to skip fire-and-forget async operations that
        // would otherwise outlive the plugin and cause segfaults.
        if (shouldRunGlobalCleanup) {
            ztoolkit.log("onMainWindowUnload: Setting shutdown flag and cancelling in-flight operations");
            Zotero.__beaverShuttingDown = true;
            addon.data.alive = false;

            // Cancel all background tasks (sync, PDF fetch, metadata enrich)
            // and clear their 60-second cleanup timers that keep the event loop alive.
            cancelAllActiveTasks();
        }

        // Clean up window-specific resources

        // Clean up event bus for this window
        if (win.__beaverEventBus) {
            win.__beaverEventBus = null;
        }

        // Remove React components and DOM elements for this window.
        // React cleanup effects run here — they will see the shutdown
        // flag and skip any fire-and-forget DB/network operations.
        BeaverUIFactory.removeChatPanel(win);

        if (!isLastWindow) {
            ztoolkit.log("onMainWindowUnload: Other windows remain, skipping global cleanup");
            return;
        }
        
        if (!shouldRunGlobalCleanup) {
            ztoolkit.log("onMainWindowUnload: Last window closed but app still running, skipping global cleanup");
            return;
        }

        ztoolkit.log("onMainWindowUnload: Last window closing, running global cleanup");

        // Global cleanup - only run when last window closes

        // 1. Stop Supabase auto-refresh timer to prevent stale timers
        //    surviving plugin reload and causing token refresh races.
        //    The cleanup function is registered by supabaseClient.ts (webpack bundle)
        //    on the window where the bundle was loaded.  Use the `win` parameter
        //    (the window being unloaded) rather than Zotero.getMainWindow(), which
        //    may be unreliable during unload of the last window.
        try {
            if (win?.__beaverDisposeSupabase) {
                await withShutdownTimeout(win.__beaverDisposeSupabase(), "disposeSupabase");
                win.__beaverDisposeSupabase = undefined;
            }
        } catch (e) {
            ztoolkit.log(`disposeSupabase: ${e}`);
        }

        // 2. Dispose MuPDF WASM module to release native resources
        await withShutdownTimeout(disposeMuPDF(), "disposeMuPDF");

        // 3. Clear attachment file cache
        if (addon.attachmentFileCache) {
            addon.attachmentFileCache.clearMemoryCache();
            addon.attachmentFileCache = undefined;
        }

        // 4. Close database connection
        if (addon.db) {
            await withShutdownTimeout(addon.db.closeDatabase(), "closeDatabase");
            addon.db = undefined;
        }

        // 5. Dispose CitationService
        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        // 6. Unregister keyboard shortcuts (clears interval, unregisters Zotero.Reader listeners)
        BeaverUIFactory.unregisterShortcuts();

        // 7. Clean up UIManager (restores Zotero.Reader.onChangeSidebarWidth)
        if (uiManager) {
            uiManager.cleanup();
        }

        // 8. Unload stylesheets
        unloadKatexStylesheet();
        unloadStylesheet();

        // 9. Unregister ztoolkit
        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();

        // 10. Close separate Beaver and preferences windows if open
        BeaverUIFactory.closeBeaverWindow();
        BeaverUIFactory.closePreferencesWindow();

        // 11. Unregister quit observer
        unregisterQuitObserver();

        // 12. Unregister protocol handler
        unregisterBeaverProtocolHandler();

        ztoolkit.log("onMainWindowUnload: Cleanup completed successfully");
    } catch (error: any) {
        ztoolkit.log(`onMainWindowUnload: Error during cleanup: ${error.message}`);
    }
}

function loadStylesheet() {
    const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/beaver.css`;
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const styleSheet = Services.io.newURI(styleURI);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    if (ssService.sheetRegistered(styleSheet, sheetType)) {
        ssService.unregisterSheet(styleSheet, sheetType);
    }
    ssService.loadAndRegisterSheet(styleSheet, sheetType);
}

function unloadStylesheet() {
    const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/beaver.css`;
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const styleSheet = Services.io.newURI(styleURI);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    if (ssService.sheetRegistered(styleSheet, sheetType)) {
        ssService.unregisterSheet(styleSheet, sheetType);
    }	
}

function loadKatexStylesheet() {
    const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/katex-embedded.css`;
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const styleSheet = Services.io.newURI(styleURI);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    if (ssService.sheetRegistered(styleSheet, sheetType)) {
        ssService.unregisterSheet(styleSheet, sheetType);
    }
    ssService.loadAndRegisterSheet(styleSheet, sheetType);
}

function unloadKatexStylesheet() {
    const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/katex-embedded.css`;
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const styleSheet = Services.io.newURI(styleURI);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    if (ssService.sheetRegistered(styleSheet, sheetType)) {
        ssService.unregisterSheet(styleSheet, sheetType);
    }	
}

/**
 * Plugin shutdown handler.
 * 
 * NOTE: Most cleanup should happen in onMainWindowUnload() instead.
 * This function runs AFTER Zotero's internal cleanup has begun,
 * which can cause SIGSEGV if we try to access destroyed objects.
 * 
 * This is kept as a fallback for any remaining cleanup.
 */
async function onShutdown(): Promise<void> {
    ztoolkit.log("onShutdown: Running fallback cleanup");
    
    try {
        const isAppShuttingDown = Services?.startup?.shuttingDown ?? false;
        if (!isAppShuttingDown) {
            const openWindows = Zotero.getMainWindows?.().filter(w => w && !w.closed) ?? [];
            openWindows.forEach((win) => {
                BeaverUIFactory.removeChatPanel(win as Window);
            });
        }

        // These should already be done in onMainWindowUnload, but just in case
        try {
            const mainWin = Zotero.getMainWindow();
            if (mainWin?.__beaverDisposeSupabase) {
                await mainWin.__beaverDisposeSupabase();
                mainWin.__beaverDisposeSupabase = undefined;
            }
        } catch (_e) { /* may not be available during shutdown */ }
        await disposeMuPDF();

        if (addon.attachmentFileCache) {
            addon.attachmentFileCache.clearMemoryCache();
            addon.attachmentFileCache = undefined;
        }

        if (addon.db) {
            await addon.db.closeDatabase();
            addon.db = undefined;
        }

        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        BeaverUIFactory.unregisterShortcuts();

        if (uiManager) {
            uiManager.cleanup();
        }

        BeaverUIFactory.closeBeaverWindow();
        BeaverUIFactory.closePreferencesWindow();

        unloadKatexStylesheet();
        unloadStylesheet();
        
        unregisterQuitObserver();
        unregisterBeaverProtocolHandler();

        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();
        addon.data.alive = false;
        delete Zotero[addon.data.config.addonInstance as keyof typeof Zotero];
    } catch (error) {
        ztoolkit.log("onShutdown: Error during cleanup:", error);
    }
}

export default {
    onStartup,
    onShutdown,
    onMainWindowLoad,
    onMainWindowUnload
};
