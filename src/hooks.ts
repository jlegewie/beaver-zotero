import { InstanceDocuments } from "./services/instanceDocuments";
import { InstanceBackground } from "./services/instanceBackground";
import { ZOTERO_PLUGIN_CLIENT_TYPE } from "@beaver/agent-core/protocol/agentProtocol";
import { setActionClient } from "@beaver/agent-core/types/actions";
import { version } from "../package.json";
import { getAllVersionUpdateMessageVersions } from "../react/constants/versionUpdateMessages";
import { disposeMuPDFWorker } from "./beaver-extract";
import { cleanupReaderIntegration, initReaderIntegration } from "./modules/readerIntegration";
import { cleanupReaderToolbarMenu, initReaderToolbarMenu } from "./modules/readerToolbarMenu";
import { cleanupContextMenus, initContextMenus } from "./modules/zoteroContextMenu";
import {
    registerTablesApi,
    unregisterTablesApi
} from "./services/artifacts/tablesApiHost";
import {
    cleanupReaderTableViews,
    cleanupReaderTableViewsForWindow,
    initReaderTableViews,
} from "./services/artifacts/view/readerTableView";
import { BackgroundExtractor } from "./services/backgroundExtractor";
import { NewItemWatcher } from "./services/backgroundProcessing/newItemWatcher";
import { ReconcilerService } from "./services/backgroundProcessing/reconciler";
import { CitationService } from "./services/CitationService";
import { BeaverDB } from "./services/database";
import { DocumentCache } from "./services/documentCache";
import { createInstanceAccount } from './services/instanceAccount';
import { InstancePreferences } from './services/instancePreferences';
import { registerBeaverProtocolHandler, unregisterBeaverProtocolHandler } from "./services/protocolHandler";
import { DevelopmentVoiceHarness } from "./services/voice/developmentHarness";
import { NativeVoice } from "./services/voice/nativeVoice";
import { productVoiceAdapters } from "./services/voice/productVoice";
import { createVoiceService } from "./services/voice/voiceService";
import {
    cleanupTableItemPane,
    initTableItemPane,
} from "./ui/tableItemPane";
import { BeaverUIFactory } from "./ui/ui";
import { cancelAllActiveTasks } from "./utils/backgroundTasks";
import { compareVersions } from "./utils/compareVersions";
import { configurePDFForBeaver } from "./utils/configurePDFForBeaver";
import { initLocale } from "./utils/locale";
import { clearPref, getPref, setPref } from "./utils/prefs";
import { addPendingVersionNotification } from "./utils/versionNotificationPrefs";
import { createZToolkit } from "./utils/ztoolkit";

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

function ensureDocumentRuntime(): void {
    addon.documents ??= new InstanceDocuments();
    configurePDFForBeaver({ onWorkerStartFailure: info => addon.runtime.publish('document-worker:failure', info) });
}

async function disposeAccountServices(): Promise<void> {
    addon.threads.dispose();
    addon.presence.dispose();
    try { addon.documents?.dispose(); } catch (error) { ztoolkit.log(`disposeDocuments: ${error}`); }
    addon.documents = undefined;
    try { if (addon.background) await withShutdownTimeout(addon.background.dispose(), "disposeBackground"); }
    catch (error) { ztoolkit.log(`disposeBackground: ${error}`); }
    addon.background = undefined;
    try { addon.preferences?.dispose(); } catch (error) { ztoolkit.log(`disposePreferences: ${error}`); }
    try { if (addon.account) await withShutdownTimeout(addon.account.dispose(), 'disposeAccount'); }
    catch (error) { ztoolkit.log(`disposeAccount: ${error}`); }
}

/**
 * Close the agent connection via the window's React bundle (`agentService` is
 * per-bundle). Synchronous and best-effort — teardown must not wait on the network.
 */
function closeAgentConnection(
    win: Window | null | undefined,
    reason: string,
    options?: { rememberInterruptedThread?: boolean },
): void {
    const close = (win as any)?.BeaverReact?.closeAgentConnection;
    if (typeof close !== "function") return;

    try {
        close(reason, options);
    } catch (e) {
        ztoolkit.log(`closeAgentConnection: ${e}`);
    }
}

async function cleanupDevTemporaryAnnotations(
    win: Window | null | undefined,
): Promise<void> {
    if (process.env.NODE_ENV !== "development") return;

    const cleanup = (win as any)?.BeaverReact?.cleanupTemporaryAnnotations;
    if (typeof cleanup !== "function") return;

    try {
        await withShutdownTimeout(cleanup(), "cleanupTemporaryAnnotations");
    } catch (e) {
        ztoolkit.log(`cleanupTemporaryAnnotations: ${e}`);
    }
}

let isAppQuitting = false;
let quitObserverRegistered = false;
const quitObserver = {
    observe(_subject: any, topic: string) {
        if (topic === "quit-application-granted" || topic === "quit-application") {
            isAppQuitting = true;
            Zotero.__beaverShuttingDown = true;
        }
        // Close beaver.sqlite on quit-application, BEFORE the
        // profile-before-change barrier where Sqlite.sys.mjs waits for all
        // connections.
        if (topic === "quit-application") {
            void disposeAccountServices();
            try {
                if (addon?.db) {
                    addon.db.closeDatabase().catch((error: unknown) => {
                        Zotero.logError(error as Error);
                    });
                    addon.db = undefined;
                }
            } catch (_) {
                // Best-effort — process is dying
            }
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
 * Handles upgrade tasks between plugin versions.
 * @param lastVersion The previously installed version
 * @param currentVersion The current plugin version
 */
async function handleUpgrade(lastVersion: string, currentVersion: string) {
    // Mark welcome onboarding as shown for existing users who are upgrading.
    // This prevents the first-install popup from showing to users who already have the plugin.
    // The reader tip is intentionally NOT suppressed — existing users should see it once.
    if (!getPref('onboardingWelcomeShown')) {
        setPref('onboardingWelcomeShown', true);
    }

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

/**
 * Open the plugin database, releasing Zotero's pane lock if the open takes it.
 *
 * Zotero 10 runs an integrity check whenever a database's WAL file wasn't
 * truncated by a clean shutdown (force quit, crash, `kill`). The check displays
 * the modal pane overlay ("Checking database integrity…") and locks the pane,
 * but only the corruption path restores the previous display — a check that
 * passes leaves the overlay up. That is invisible for Zotero's own database,
 * which is opened while the pane is still locked during startup and unlocked
 * afterwards by `ZoteroPane.makeVisible()`. We open after `uiReadyPromise`, so
 * the overlay would instead stay up for the rest of the session, with no way
 * for the user to dismiss it.
 *
 * Only clears a lock that this open introduced, so a lock held by another
 * operation is left alone. Zotero 7-9 put plugin databases in rollback-journal
 * mode and have no such check, so the lock never appears and this is a no-op.
 */
async function openPluginDatabase(dbConnection: _ZoteroTypes.DB): Promise<void> {
    const wasLocked = Zotero.locked;
    await dbConnection.test();
    if (!wasLocked && Zotero.locked) {
        ztoolkit.log("Database open locked the Zotero pane (unclean shutdown integrity check) — releasing it");
        Zotero.hideZoteroPaneOverlays();
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

    // Retired preferences: nothing reads them, so a value left by an earlier
    // version is dropped rather than carried in the profile indefinitely.
    clearPref("backgroundProcessingContinuous");

    // -------- Configure the PDF package (esbuild bundle copy) --------
    // Idempotent. Must run before any PDF op. The webpack bundle calls the
    // same adapter from `react/index.tsx` for its own copy of the config.
    ensureDocumentRuntime();

    // -------- Declare the client actions are gated on --------
    // Each bundle holds its own copy of this seam, so the webpack bundle
    // registers the same value from `react/index.tsx`.
    setActionClient(ZOTERO_PLUGIN_CLIENT_TYPE);

    // -------- Store plugin version --------
    addon.pluginVersion = version;
    addon.preferences ??= new InstancePreferences();
    addon.account ??= createInstanceAccount();
    addon.threads.start(addon.account);
    addon.account.start();
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
        await openPluginDatabase(dbConnection);
        await beaverDB.initDatabase(version);

        // -------- Initialize Document Cache --------
        const documentCache = new DocumentCache(beaverDB);
        await documentCache.init();
        await documentCache.runStartupGC();
        addon.documentCache = documentCache;
        ztoolkit.log("DocumentCache initialized successfully");

        // -------- Handle plugin upgrade --------
        const lastVersion = getPref('installedVersion');
        if (lastVersion && lastVersion !== version) {
            await handleUpgrade(lastVersion, version);
        }

        // -------- Set installed version --------
        setPref('installedVersion', version);
        ztoolkit.log(`Installed version: ${getPref('installedVersion')}`);

        // -------- Initialize background extraction processor --------
        const backgroundExtractor = new BackgroundExtractor();
        addon.backgroundExtractor = backgroundExtractor;
        backgroundExtractor.start();
        addon.background = new InstanceBackground();
        addon.background.start(addon.account!);
        ztoolkit.log("BackgroundExtractor started");

        // Whole-library producers are independently pref-gated. They only
        // enumerate searchable libraries mirrored from the webpack profile.
        const processingReconciler = new ReconcilerService();
        addon.processingReconciler = processingReconciler;
        processingReconciler.start();
        const newItemWatcher = new NewItemWatcher();
        addon.newItemWatcher = newItemWatcher;
        newItemWatcher.start();
        ztoolkit.log("Background processing producers started");

        try {
            const legacyContentCache = PathUtils.join(Zotero.Profile.dir, "beaver", "content-cache");
            if (await IOUtils.exists(legacyContentCache)) {
                await IOUtils.remove(legacyContentCache, { recursive: true });
            }
        } catch (error) {
            ztoolkit.log(`Legacy content-cache cleanup failed: ${error}`);
        }

        // -------- Initialize Citation Service with caching --------
        const citationService = new CitationService(ztoolkit);
        addon.citationService = citationService;
        ztoolkit.log("CitationService initialized successfully");

        // Voice is optional: its initialization must not prevent the rest of Beaver loading.
        try {
            if (Zotero.isMac) addon.voiceNative = new NativeVoice();
            if (__env__ === 'development') {
                addon.voiceHarness = new DevelopmentVoiceHarness(undefined, addon.voiceNative, productVoiceAdapters(addon.voiceNative, () => addon.voice?.uploadContext));
                addon.voice = addon.voiceHarness.service;
            } else {
                addon.voice = createVoiceService(productVoiceAdapters(addon.voiceNative, () => addon.voice?.uploadContext));
            }
        } catch {
            disposeVoice();
            ztoolkit.log('Voice initialization failed; continuing without voice');
        }

        // -------- Register keyboard shortcuts --------
        BeaverUIFactory.registerShortcuts();

        // -------- Register protocol handler (zotero://beaver) --------
        registerBeaverProtocolHandler();

        // -------- Register Zotero 8 context menus (no-op on Zotero 7) --------
        initContextMenus();

        // -------- Register reader text selection popup & context menu --------
        initReaderIntegration();

        // -------- Register reader toolbar dropdown menu --------
        await initReaderToolbarMenu();

        // -------- Enhance stored tables opened in the reader --------
        // The reader is the only surface a stored table has, so every way of
        // opening one — double-click, `zotero://open`, the item pane — arrives
        // here and needs no interception anywhere.
        initReaderTableViews();

        // -------- Describe a stored table in the item pane --------
        // Registered once, globally: Zotero re-creates the section in every
        // window's item pane from the same registration.
        initTableItemPane();

        // -------- Publish the table surfaces to the other bundle --------
        // The reader views and the item-pane registration keep module state, so
        // they live in this bundle only. Anything on the webpack side reaches
        // them through `Zotero.__beaverTables` rather than importing them,
        // which would give it a second, permanently empty copy.
        registerTablesApi();

        // -------- Register Zotero preferences pane --------
        await Zotero.PreferencePanes.register({
            pluginID: addon.data.config.addonID,
            src: rootURI + 'content/beaverZoteroPrefs.xhtml',
            scripts: [rootURI + 'content/beaverZoteroPrefs.js'],
            id: 'beaver-prefpane',
            label: 'Beaver',
            image: rootURI + 'content/icons/beaver@0.5x.png',
        });

        // -------- Load UI for all windows --------
        const mainWindows = Zotero.getMainWindows();
        if (mainWindows.length > 0) {
            await Promise.all(
                mainWindows.map((win) => onMainWindowLoad(win)),
            );
        }
    } catch (error) {
        await disposeAccountServices();
        // If startup fails after opening the DB, close it immediately
        // to prevent AsyncShutdown timeout → FATAL ERROR crash.
        ztoolkit.log(`Startup failed, closing database: ${error}`);
        // Stop the background extractor
        try {
            addon.newItemWatcher?.stop();
            addon.newItemWatcher = undefined;
            addon.processingReconciler?.stop();
            addon.processingReconciler = undefined;
            if (addon.backgroundExtractor) {
                await addon.backgroundExtractor.stop();
                addon.backgroundExtractor = undefined;
            }
        } catch (stopError) {
            ztoolkit.log(`Failed to stop backgroundExtractor during startup error recovery: ${stopError}`);
        }
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
    if (win.closed || addon.runtime.getWindow(win)) return;
    const runtime = addon.runtime.attachWindow(win);

    // Create ztoolkit for every window
    addon.data.ztoolkit = createZToolkit();

    // Re-configure the PDF package on every main-window load. Required for
    // the macOS close-last-window-then-reopen lifecycle (see CLAUDE.md):
    // `onStartup()` does not re-run, but the package's module-scope config
    // must be configured before this window can dispatch document work.
    // Idempotent — `configurePDF()` overwrites prior config.
    ensureDocumentRuntime();

    registerMainWindowFtl(win);

    // Wait for the UI to be ready
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);

    if (runtime.status === 'closing' || addon.runtime.getWindow(win) !== runtime) return;
    if (win.closed) {
        addon.runtime.detachWindow(win);
        return;
    }

    BeaverUIFactory.registerChatPanel(win);

    ztoolkit.log("UI ready");
    
    // Load styles for this window
    loadStylesheet();
    loadKatexStylesheet(win);
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
    const runtime = addon.runtime.getWindow(win);
    if (!addon.runtime.markClosing(win)) return;
    if (runtime) {
        addon.mutations.cancelOwner(runtime.id);
        void addon.notePreviews.detachOwner(runtime.id).catch(error => {
            ztoolkit.log('Failed to restore closing window note previews', error);
        });
    }
    ztoolkit.log("onMainWindowUnload: Starting cleanup");

    try {
        try {
            addon.voice?.windowUnloaded(win);
        } catch {
            ztoolkit.log('Voice window cleanup failed; continuing cleanup');
        }
        // Close first: later steps can await, and the window may be gone when
        // this handler returns. Read quitting and the window count here — the
        // later scope check runs after those awaits.
        const appGoingAway = isAppQuitting || (Services?.startup?.shuttingDown ?? false);
        if (appGoingAway) await addon.mutations.dispose();
        const isLastMainWindow = Zotero.getMainWindows()
            .filter(w => w !== win && !w.closed).length === 0;
        // Record only when Beaver itself is going away. Closing one of several
        // windows also abandons the run, but Beaver keeps running, so a
        // "Beaver closed mid-response" offer would be false — in the surviving
        // window (which runs its own bundle) it would even appear mid-session.
        // That thread is still in the chat history to reopen.
        //
        // On a quit every window is going away, and the one holding the socket
        // is not necessarily the last to unload — the later ones have nothing
        // left to close, so gating on "last window" alone would record nothing.
        closeAgentConnection(
            win,
            appGoingAway ? "Zotero quitting" : "Main window closed",
            { rememberInterruptedThread: true },
        );

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

            await disposeAccountServices();

            // Cancel all background tasks (sync, PDF fetch, metadata enrich)
            // and clear their 60-second cleanup timers that keep the event loop alive.
            cancelAllActiveTasks();
        }

        // Clean up window-specific resources

        // Clean up event bus for this window
        if (win.__beaverEventBus) {
            win.__beaverEventBus = null;
        }

        // Stop the busy-context heartbeat timer (registered by busyContext.ts in
        // the webpack bundle) so it doesn't outlive the window.
        try {
            win.__beaverStopBusyHeartbeat?.();
        } catch (e) {
            ztoolkit.log(`stopBusyHeartbeat: ${e}`);
        }

        // Resume Zotero sync suppression held by a mutating agent run before
        // this window's timers and React cleanup are torn down.
        try {
            const rescheduleSync = !(isAppQuitting || isAppShuttingDown);
            if (runtime) addon.syncPause.releaseWindow(runtime.id);
        } catch (e) {
            ztoolkit.log(`resumeSyncAfterRun: ${e}`);
        }

        // The separate Beaver and preferences windows render with THIS window's
        // React instance and share its Jotai store, so they cannot outlive it.
        // Close them before React is torn down (their roots then unmount
        // cleanly). This runs on every main-window unload, not only during
        // global cleanup: with several main windows the owner can close while
        // others remain, and on macOS the app keeps running after the last
        // window closes — in both cases a surviving auxiliary window would be
        // frozen against a dead bundle, with its state invisible to the bundle
        // a reopened main window loads.
        BeaverUIFactory.closeWindowsRenderedBy(win, isLastWindow);

        // Dev-only: visualizer highlights are temporary reader annotations
        // owned by the React bundle, so clear them before unmounting React.
        await cleanupDevTemporaryAnnotations(win);

        // Remove React components and DOM elements for this window.
        // React cleanup effects run here — they will see the shutdown
        // flag and skip any fire-and-forget DB/network operations.
        BeaverUIFactory.removeChatPanel(win);
        addon.runtime.detachWindow(win);

        // Remove the <link rel="localization"> we added in onMainWindowLoad.
        // Leaving it behind after disable causes the locale bundle to log
        // "Missing resource" and emits an uncaught promise rejection on the
        // next popup translation, breaking Zotero's right-click menu.
        unregisterMainWindowFtl(win);

        // Release this window's table views. Window-specific, so it runs on
        // every unload and not only during global cleanup: a reader-hosted
        // table left behind holds the closed window's iframe and its rendered
        // document — a dead realm kept alive, which on macOS (close the last
        // window, app keeps running) survives indefinitely.
        cleanupReaderTableViewsForWindow(win);

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

        addon.newItemWatcher?.stop();
        addon.newItemWatcher = undefined;
        addon.processingReconciler?.stop();
        addon.processingReconciler = undefined;

        // 2. Stop the background extraction processor. It owns the
        //    background MuPDFWorkerClient and an in-flight extraction may
        //    still be running; the stop() call aborts it cooperatively and
        //    disposes the worker.
        if (addon.backgroundExtractor) {
            await withShutdownTimeout(
                addon.backgroundExtractor.stop(),
                "backgroundExtractor.stop",
            );
            addon.backgroundExtractor = undefined;
        }

        // 3. Terminate the remaining MuPDF worker(s). Sentencex lives
        //    inside the worker and dies with `worker.terminate()`. With
        //    `name` omitted, disposes any slot still alive (the hot one
        //    in the steady state; the background slot was already
        //    disposed by step 2).
        await withShutdownTimeout(disposeMuPDFWorker(), "disposeMuPDFWorker");

        addon.documentCache = undefined;

        // 4. Close database connection
        if (addon.db) {
            await withShutdownTimeout(addon.db.closeDatabase(), "closeDatabase");
            addon.db = undefined;
        }

        // 4. Dispose CitationService
        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        // 5. Unregister keyboard shortcuts (clears interval, unregisters Zotero.Reader listeners)
        BeaverUIFactory.unregisterShortcuts();

        // Dispose the plugin-owned window registry and reader-width dispatcher.
        addon.runtime.disposeInstance();

        // 7. Unload stylesheets
        unloadKatexStylesheet(win);
        unloadStylesheet();

        // 8. Unregister ztoolkit
        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();

        // 9. Close separate Beaver and preferences windows if any survived
        //    (normally already closed above, before React was torn down)
        BeaverUIFactory.closeBeaverWindow();
        BeaverUIFactory.closePreferencesWindow();

        // 10. Unregister quit observer
        unregisterQuitObserver();

        // 11. Unregister context menus
        cleanupContextMenus();

        // 12. Unregister reader integration listeners, and release the table
        //     views: one left behind holds its reader, that reader's document
        //     and the window both live in.
        cleanupReaderIntegration();
        unregisterTablesApi();
        cleanupReaderTableViews();
        cleanupTableItemPane();

        // 13. Unregister reader toolbar menu
        cleanupReaderToolbarMenu();

        // 14. Unregister protocol handler
        unregisterBeaverProtocolHandler();

        // 15. Drop React-bundle cross-bundle globals attached to Zotero
        Zotero.__beaverShuttingDown = undefined;
        Zotero.__beaverWrittenAnnotationItems = undefined;
        Zotero.__beaverWrittenAnnotationKeys = undefined;

        ztoolkit.log("onMainWindowUnload: Cleanup completed successfully");
    } catch (error: any) {
        ztoolkit.log(`onMainWindowUnload: Error during cleanup: ${error.message}`);
    } finally {
        if (addon.runtime.getWindow(win) === runtime) {
            BeaverUIFactory.closeWindowsRenderedBy(win);
            BeaverUIFactory.removeChatPanel(win);
            addon.runtime.detachWindow(win);
        }
    }
}

/**
 * Global AUTHOR_SHEETs, in cascade order.
 *
 * The `agent-ui-*` sheets come from `packages/agent-ui/src/theme/` and are copied
 * into `addon/content/styles/` at build time by `scripts/copy-agent-ui-css.mjs`,
 * so they are generated, not checked in. `agent-ui-tokens.css` holds Beaver's own
 * custom properties plus the documented contract of platform tokens Zotero
 * supplies; `agent-ui-utilities.css` holds the utility layer, scoped
 * `.beaver-root`; `agent-ui-components.css` holds the shared component rules —
 * the sign-in surface, the link vocabulary, the composer and the bars that dock
 * to it, the editor field and the tooltip family.
 *
 * Order is the cascade. The shared sheets are registered *before* `beaver.css` so
 * this client's own rules win at equal specificity — the package supplies the
 * shared baseline, this client adapts it. Tokens precede the utilities that
 * consume them, and the components sheet follows both: it is written in that
 * vocabulary and has to beat it where the two land on one element, which
 * `.text-link` beside `.font-color-secondary` does.
 *
 * Kept as separate sheets rather than concatenated, so provenance stays readable
 * and the shared files are byte-identical to what the Word add-in imports. Keep
 * this list in step with the `<?xml-stylesheet?>` links in `beaverWindow.xhtml`
 * and `beaverPreferences.xhtml`.
 */
const GLOBAL_STYLESHEETS = [
    "agent-ui-tokens.css",
    "agent-ui-utilities.css",
    "agent-ui-components.css",
    "agent-ui-table.css",
    "beaver.css",
];

function loadStylesheet() {
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    for (const name of GLOBAL_STYLESHEETS) {
        const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/${name}`;
        const styleSheet = Services.io.newURI(styleURI);
        // Per sheet, so one missing file cannot cost the others. The agent-ui
        // sheets are copied in at build time rather than checked in, so a build
        // that skipped `copy:agent-ui-css` would otherwise take beaver.css down
        // with it and render the whole plugin unstyled.
        try {
            if (ssService.sheetRegistered(styleSheet, sheetType)) {
                ssService.unregisterSheet(styleSheet, sheetType);
            }
            ssService.loadAndRegisterSheet(styleSheet, sheetType);
        } catch (error) {
            Zotero.logError(
                new Error(`Beaver: failed to register ${name}: ${error}`),
            );
        }
    }
}

function unloadStylesheet() {
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    for (const name of GLOBAL_STYLESHEETS) {
        const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/${name}`;
        const styleSheet = Services.io.newURI(styleURI);
        if (ssService.sheetRegistered(styleSheet, sheetType)) {
            ssService.unregisterSheet(styleSheet, sheetType);
        }
    }
}

/**
 * Load KaTeX stylesheet as a per-document <link> element instead of a global
 * AUTHOR_SHEET. This prevents the note editor iframe (resource://zotero/note-editor/)
 * from attempting to load chrome://beaver/ font resources, which its security
 * policy blocks.
 */
function loadKatexStylesheet(win: Window) {
    if (!win?.document) return;
    const doc = win.document;
    if (doc.getElementById("beaver-katex-stylesheet")) return;
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "html:link") as HTMLLinkElement;
    link.id = "beaver-katex-stylesheet";
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = `chrome://${addon.data.config.addonRef}/content/styles/katex-embedded.css`;
    doc.documentElement.appendChild(link);
}

function unloadKatexStylesheet(win: Window) {
    if (!win?.document) return;
    const el = win.document.getElementById("beaver-katex-stylesheet");
    if (el) el.remove();
}

/**
 * Register Beaver's mainWindow.ftl as a <link rel="localization"> in the
 * window's DOM, mirroring MozXULElement.insertFTLIfNeeded
 */
function registerMainWindowFtl(win: Window): void {
    if (!win?.document) return;
    const doc = win.document;
    const ftlPath = `${addon.data.config.addonRef}-mainWindow.ftl`;
    const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
    const XHTML_NS = 'http://www.w3.org/1999/xhtml';
    let container: Element | null = doc.head || doc.querySelector('linkset');
    if (!container) {
        if (doc.documentElement.namespaceURI === XUL_NS) {
            container = doc.createXULElement('linkset');
            doc.documentElement.appendChild(container);
        } else {
            container = doc.documentElement;
        }
    }
    const alreadyPresent = Array.from(container.querySelectorAll('link')).some(
        (l: any) => l?.getAttribute('href') === ftlPath,
    );
    if (alreadyPresent) return;
    const link = doc.createElementNS(XHTML_NS, 'link');
    link.setAttribute('rel', 'localization');
    link.setAttribute('href', ftlPath);
    container.appendChild(link);
}

function unregisterMainWindowFtl(win: Window): void {
    if (!win?.document) return;
    const doc = win.document;
    const ftlPath = `${addon.data.config.addonRef}-mainWindow.ftl`;
    const link = doc.querySelector(`link[rel="localization"][href="${ftlPath}"]`);
    if (link) link.remove();
}

function disposeVoice(): void {
    try { addon.voice?.dispose(); } catch { ztoolkit.log('Voice disposal failed'); }
    try { addon.voiceNative?.dispose(); } catch { ztoolkit.log('Native voice disposal failed'); }
    addon.voiceNative = undefined;
    addon.voice = undefined;
    addon.voiceHarness = undefined;
}

let appShutdownDisposal: Promise<void> | undefined;

/** APP_SHUTDOWN runs too late to access windows, React, or reader UI. */
function onAppShutdown(): Promise<void> {
    return appShutdownDisposal ??= disposeAppServices();
}

async function disposeAppServices(): Promise<void> {
    Zotero.__beaverShuttingDown = true;
    addon.data.alive = false;
    const attempt = async (label: string, cleanup: () => void | Promise<unknown>) => {
        try {
            await withShutdownTimeout(Promise.resolve(cleanup()), label);
        } catch (error) {
            ztoolkit.log(`onAppShutdown: ${label} failed:`, error);
        }
    };
    await addon.mutations.dispose();
    addon.syncPause.resumeSyncNow();
    await attempt('disposeAccount', disposeAccountServices);
    await attempt('cancelAllActiveTasks', () => cancelAllActiveTasks());
    await attempt('newItemWatcher.stop', () => addon.newItemWatcher?.stop());
    addon.newItemWatcher = undefined;
    await attempt('processingReconciler.stop', () => addon.processingReconciler?.stop());
    addon.processingReconciler = undefined;
    await attempt('backgroundExtractor.stop', () => addon.backgroundExtractor?.stop());
    addon.backgroundExtractor = undefined;
    await attempt('disposeMuPDFWorker', () => disposeMuPDFWorker(undefined, { force: true }));
    addon.documentCache = undefined;
    // Keep a failed connection available to bootstrap's independent DB fallback.
    await attempt('closeDatabase', async () => {
        if (addon.db) {
            await addon.db.closeDatabase();
            addon.db = undefined;
        }
    });
    await attempt('citationService.dispose', () => addon.citationService?.dispose());
    addon.citationService = undefined;
}

let instanceDisposal: Promise<void> | undefined;

/** Full cleanup for plugin disable/reload, while Zotero UI is still usable. */
function onShutdown(): Promise<void> {
    return instanceDisposal ??= disposePlugin();
}

async function disposePlugin(): Promise<void> {
    await addon.mutations.dispose();
    addon.syncPause.resumeSyncNow();
    Zotero.__beaverShuttingDown = true;
    addon.data.alive = false;
    cancelAllActiveTasks();
    ztoolkit.log("onShutdown: Running fallback cleanup");
    
    try {
        disposeVoice();
        const openWindows = Zotero.getMainWindows?.().filter(w => w && !w.closed) ?? [];
        for (const win of openWindows) addon.runtime.markClosing(win);
        for (const win of openWindows) {
            closeAgentConnection(win as Window, "Beaver plugin shutting down", {
                rememberInterruptedThread: true,
            });
            BeaverUIFactory.closeWindowsRenderedBy(win);
            await cleanupDevTemporaryAnnotations(win as Window);
            BeaverUIFactory.removeChatPanel(win as Window);
            addon.runtime.detachWindow(win);
        }

        addon.newItemWatcher?.stop();
        addon.newItemWatcher = undefined;
        addon.processingReconciler?.stop();
        addon.processingReconciler = undefined;

        if (addon.backgroundExtractor) {
            try {
                await addon.backgroundExtractor.stop();
            } catch (_e) { /* best-effort */ }
            addon.backgroundExtractor = undefined;
        }

        addon.documentCache = undefined;
        await disposeAccountServices();

        if (addon.db) {
            await addon.db.closeDatabase();
            addon.db = undefined;
        }

        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        BeaverUIFactory.unregisterShortcuts();

        addon.runtime.disposeInstance();

        BeaverUIFactory.closeBeaverWindow();
        BeaverUIFactory.closePreferencesWindow();

        // Remove the FTL <link> from any still-open main windows so the
        // locale bundle doesn't try to resolve Beaver's FTL after disable,
        // which breaks Zotero's right-click menu.
        const openWins = Zotero.getMainWindows?.().filter(w => w && !w.closed) ?? [];
        for (const w of openWins) {
            unregisterMainWindowFtl(w as Window);
            unloadKatexStylesheet(w as Window);
        }
        unloadStylesheet();
        
        unregisterQuitObserver();
        cleanupContextMenus();
        cleanupReaderIntegration();
        unregisterTablesApi();
        cleanupReaderTableViews();
        cleanupTableItemPane();
        cleanupReaderToolbarMenu();
        unregisterBeaverProtocolHandler();

        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();
        addon.data.alive = false;

        // Drop React-bundle cross-bundle globals so plugin disable doesn't
        // leak the Jotai store (dead atom-keyed entries) or leave a stale
        // shutdown flag that would short-circuit the next onStartup().
        Zotero.__beaverShuttingDown = undefined;
        Zotero.__beaverWrittenAnnotationItems = undefined;
        Zotero.__beaverWrittenAnnotationKeys = undefined;
        // Note: the singleton is removed from Zotero in addon/bootstrap.js's
    } catch (error) {
        ztoolkit.log("onShutdown: Error during cleanup:", error);
    } finally {
        // Force-clear the cross-bundle MuPDF worker slots even if the cleanup
        // above threw
        try {
            await disposeMuPDFWorker(undefined, { force: true });
        } catch (e) {
            ztoolkit.log("onShutdown: disposeMuPDFWorker failed:", e);
        }
    }
}

export default {
    onStartup,
    onShutdown,
    onAppShutdown,
    onMainWindowLoad,
    onMainWindowUnload
};
