import { version } from "../package.json";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import eventBus from "../react/eventBus";
import { CitationService } from "./services/CitationService";
// import { newZoteroAttachmentPane, ZoteroAttachmentPane } from './ui/ZoteroAttachmentPane'
import { BeaverDB } from "./services/database";
import { uiManager } from "../react/ui/UIManager";
import { cleanupAllAttachmentPanePatches } from './ui/ZoteroAttachmentPane'
import { getPref, setPref } from "./utils/prefs";

// const attachmentPanes: Map<Window, ZoteroAttachmentPane> = new Map();

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
	// Upgrade to 0.5.0 or newer from a version before 0.5.0
    if (compareVersions(lastVersion, '0.5.0') < 0 && compareVersions(currentVersion, '0.5.0') >= 0) {
        
        // a) Show changelog
        Zotero.launchURL("https://www.beaverapp.ai/changelog/v0.5");

        // b) Set flag to run consistency check from UI context
        setPref('runConsistencyCheck', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for consistency check.`);
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
	
	// -------- Initialize Generative AI provider for direct API calls --------
	// let provider;
	// if (getPref("googleGenerativeAiApiKey")) {
	// 	provider = new GeminiProvider(getPref("googleGenerativeAiApiKey"));
	// } else if (getPref("openAiApiKey")) {
	// 	provider = new OpenAIProvider(getPref("openAiApiKey"));
	// }
	// addon.aiProvider = provider;
	
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
	// This ensures all windows share the same event bus.
	win.__beaverEventBus = eventBus;

	BeaverUIFactory.registerChatPanel(win);

	// Initialize Beaver attachment info row for this window
	// if (!attachmentPanes.has(win)) { // Check if already initialized for this window
	// 	ztoolkit.log(`Initializing Beaver attachment pane for window: ${win.location.href}`);
	// 	try {
	// 		const pane = await newZoteroAttachmentPane(win);
	// 		if (pane) {
	// 			attachmentPanes.set(win, pane);
	// 			ztoolkit.log("Beaver attachment pane initialized successfully.");
	// 		} else {
	// 			ztoolkit.log("Failed to initialize Beaver attachment pane (returned null).");
	// 		}
	// 	} catch (err) {
	// 		ztoolkit.log("Error initializing Beaver attachment pane:", err);
	// 	}
	// }

	ztoolkit.log("UI ready");
	
	// Load styles for this window
	loadStylesheet();
	loadKatexStylesheet();
	ztoolkit.log("Styles loaded for window");
}

async function onMainWindowUnload(win: Window): Promise<void> {
	// Clean up Beaver attachment info row for this window
	// const pane = attachmentPanes.get(win);
	// if (pane) {
	// 	ztoolkit.log(`Unloading Beaver attachment pane for window: ${win.location.href}`);
	// 	try {
	// 		pane.unload();
	// 	} catch (err) {
	// 		ztoolkit.log("Error unloading Beaver attachment pane:", err);
	// 	}
	// 	attachmentPanes.delete(win); // Remove from map
	// }
	// Clean up Chat Panel for this window
	BeaverUIFactory.removeChatPanel(win);

	// Unload the stylesheet
	unloadKatexStylesheet();
	unloadStylesheet();

	ztoolkit.unregisterAll();
	addon.data.dialog?.window?.close();

	// Clean up event bus for this window
	if (win.__beaverEventBus) {
		win.__beaverEventBus = null;
	}
}

function loadStylesheet() {
	// Load the stylesheet
	const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/beaver.css`;
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const styleSheet = Services.io.newURI(styleURI);
	if (ssService.sheetRegistered(styleSheet, ssService.AUTHOR_SHEET)) {
		ssService.unregisterSheet(styleSheet, ssService.AUTHOR_SHEET);
	}
    ssService.loadAndRegisterSheet(styleSheet, ssService.AUTHOR_SHEET);
}


function unloadStylesheet() {
	// Unload the stylesheet
	const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/beaver.css`;
	const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
		.getService(Ci.nsIStyleSheetService);
	const styleSheet = Services.io.newURI(styleURI);
	if (ssService.sheetRegistered(styleSheet, ssService.AUTHOR_SHEET)) {
		ssService.unregisterSheet(styleSheet, ssService.AUTHOR_SHEET);
	}	
}

/**
 * Load the KaTeX CSS stylesheet
 */
function loadKatexStylesheet() {
	const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/katex-embedded.css`;
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const styleSheet = Services.io.newURI(styleURI);
	if (ssService.sheetRegistered(styleSheet, ssService.AUTHOR_SHEET)) {
		ssService.unregisterSheet(styleSheet, ssService.AUTHOR_SHEET);
	}
    ssService.loadAndRegisterSheet(styleSheet, ssService.AUTHOR_SHEET);
}

/**
 * Unload the KaTeX CSS stylesheet
 */
function unloadKatexStylesheet() {
	const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/katex-embedded.css`;
	const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
		.getService(Ci.nsIStyleSheetService);
	const styleSheet = Services.io.newURI(styleURI);
	if (ssService.sheetRegistered(styleSheet, ssService.AUTHOR_SHEET)) {
		ssService.unregisterSheet(styleSheet, ssService.AUTHOR_SHEET);
	}	
}

async function onShutdown(): Promise<void> {
	try {
		ztoolkit.log("Cleaning up Beaver during shutdown.");
		
		// Close database connection if it exists
		if (addon.db) {
			await addon.db.closeDatabase();
			addon.db = undefined;
		}

		// Clean up main window event bus
		const mainWin = Zotero.getMainWindow();
		if (mainWin && mainWin.__beaverEventBus) {
			mainWin.__beaverEventBus = null;
		}

		// Dispose CitationService if it exists
		if (addon.citationService) {
			addon.citationService.dispose();
			addon.citationService = undefined;
		}

		// Final cleanup for any remaining attachment panes
		// ztoolkit.log("Cleaning up all Beaver attachment panes during shutdown.");
		// for (const [win, pane] of attachmentPanes.entries()) {
		// 	ztoolkit.log(`Force unloading Beaver attachment pane for window: ${win.location.href}`);
		// 	try {
		// 		pane.unload();
		// 	} catch (err) {
		// 		ztoolkit.log("Error during shutdown unload of attachment pane:", err);
		// 	}
		// }
		// attachmentPanes.clear();

		// Global cleanup of all attachment pane patches
		cleanupAllAttachmentPanePatches();

		// Call UIManager cleanup
		if (uiManager) {
            uiManager.cleanup();
            ztoolkit.log("UIManager cleanup executed.");
        } else {
            ztoolkit.log("UIManager instance not found during shutdown.");
        }

	} catch (error) {
		ztoolkit.log("Error during shutdown:", error);
	}
	
	// Unregister keyboard shortcuts
	BeaverUIFactory.unregisterShortcuts();
	
	// Unload stylesheets
	unloadKatexStylesheet();
	unloadStylesheet();
	
	ztoolkit.unregisterAll();
	addon.data.dialog?.window?.close();
	addon.data.alive = false;
	delete Zotero[addon.data.config.addonInstance as keyof typeof Zotero];
}

export default {
	onStartup,
	onShutdown,
	onMainWindowLoad,
	onMainWindowUnload
};
