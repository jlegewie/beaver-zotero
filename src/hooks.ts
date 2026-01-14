import { version } from "../package.json";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import eventBus from "../react/eventBus";
import { CitationService } from "./services/CitationService";
import { BeaverDB } from "./services/database";
import { uiManager } from "../react/ui/UIManager";
import { getPref, setPref } from "./utils/prefs";
import { addPendingVersionNotification } from "./utils/versionNotificationPrefs";
import { getAllVersionUpdateMessageVersions } from "../react/constants/versionUpdateMessages";
import { disposeMuPDF } from "./utils/mupdf";

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
}

async function onStartup() {
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);
    
    initLocale();
    ztoolkit.log("Startup");

    // -------- Store plugin version --------
    addon.pluginVersion = version;
    ztoolkit.log(`Plugin version: ${version}`);

    // -------- Initialize database --------
    const dbConnection = new Zotero.DBConnection("beaver");
    const beaverDB = new BeaverDB(dbConnection);
    addon.db = beaverDB;

    // Test connection and initialize schema
    await dbConnection.test();
    await beaverDB.initDatabase(version);
    
    // -------- Initialize Citation Service with caching --------
    const citationService = new CitationService(ztoolkit);
    addon.citationService = citationService;
    ztoolkit.log("CitationService initialized successfully");
    
    // -------- Register keyboard shortcuts --------
    BeaverUIFactory.registerShortcuts();

    // -------- Add event bus to window --------
    Zotero.getMainWindow().__beaverEventBus = eventBus;
    
    // -------- Load UI for all windows --------
    await Promise.all(
        Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
    );

    // -------- Handle plugin upgrade --------
    const lastVersion = getPref('installedVersion');
    if (lastVersion && lastVersion !== version) {
        await handleUpgrade(lastVersion, version);
    }

    // -------- Set installed version --------
    setPref('installedVersion', version);
    ztoolkit.log(`Installed version: ${getPref('installedVersion')}`);
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
        // Clean up window-specific resources first
        // These are safe to clean up for any window
        
        // Clean up event bus for this window
        if (win.__beaverEventBus) {
            win.__beaverEventBus = null;
        }

        // Remove React components and DOM elements for this window
        BeaverUIFactory.removeChatPanel(win);

        // Check if this is the last main window
        // Only run global cleanup if no other main windows remain
        const remainingWindows = Zotero.getMainWindows().filter(w => w !== win && !w.closed);
        const isLastWindow = remainingWindows.length === 0;
        
        if (!isLastWindow) {
            ztoolkit.log("onMainWindowUnload: Other windows remain, skipping global cleanup");
            return;
        }

        ztoolkit.log("onMainWindowUnload: Last window closing, running global cleanup");

        // Global cleanup - only run when last window closes
        
        // 1. Dispose MuPDF WASM module to release native resources
        await disposeMuPDF();

        // 2. Close database connection
        if (addon.db) {
            await addon.db.closeDatabase();
            addon.db = undefined;
        }

        // 3. Dispose CitationService
        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        // 4. Unregister keyboard shortcuts (clears interval, unregisters Zotero.Reader listeners)
        BeaverUIFactory.unregisterShortcuts();

        // 5. Clean up UIManager (restores Zotero.Reader.onChangeSidebarWidth)
        if (uiManager) {
            uiManager.cleanup();
        }

        // 6. Unload stylesheets
        unloadKatexStylesheet();
        unloadStylesheet();

        // 7. Unregister ztoolkit
        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();

        // 8. Close separate Beaver window if open
        BeaverUIFactory.closeBeaverWindow();

        // 9. Mark addon as not alive to prevent any further callbacks
        addon.data.alive = false;

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
        // These should already be done in onMainWindowUnload, but just in case
        await disposeMuPDF();

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
        
        unloadKatexStylesheet();
        unloadStylesheet();
        
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
