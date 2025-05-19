import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import eventBus from "../react/eventBus";
import { CitationService } from "./services/CitationService";
import { newZoteroAttachmentPane, ZoteroAttachmentPane } from './ui/ZoteroAttachmentPane'
import { BeaverDB } from "./services/database";

const attachmentPanes: Map<Window, ZoteroAttachmentPane> = new Map();

async function onStartup() {
	await Promise.all([
		Zotero.initializationPromise,
		Zotero.unlockPromise,
		Zotero.uiReadyPromise,
	]);
	
	initLocale();
	ztoolkit.log("Startup");

	// -------- Initialize database --------
	const dbConnection = new Zotero.DBConnection("beaver");
	const beaverDB = new BeaverDB(dbConnection);
	addon.db = beaverDB;

	// Test connection and initialize schema
	await dbConnection.test();
	await beaverDB.initDatabase();
	
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

	// Create (or reuse) an EventTarget for this window
	if (!win.__beaverEventBus) {
		win.__beaverEventBus = new EventTarget();
	}

	BeaverUIFactory.registerChatPanel(win);

	// Initialize Beaver attachment info row for this window
	if (!attachmentPanes.has(win)) { // Check if already initialized for this window
		ztoolkit.log(`Initializing Beaver attachment pane for window: ${win.location.href}`);
		try {
			const pane = await newZoteroAttachmentPane(win);
			if (pane) {
				attachmentPanes.set(win, pane);
				ztoolkit.log("Beaver attachment pane initialized successfully.");
			} else {
				ztoolkit.log("Failed to initialize Beaver attachment pane (returned null).");
			}
		} catch (err) {
			ztoolkit.log("Error initializing Beaver attachment pane:", err);
		}
	}

	ztoolkit.log("UI ready");
	
	// Load styles for this window
	loadStylesheet();
	loadKatexStylesheet();
	ztoolkit.log("Styles loaded for window");
}

async function onMainWindowUnload(win: Window): Promise<void> {
	// Clean up Beaver attachment info row for this window
	const pane = attachmentPanes.get(win);
	if (pane) {
		ztoolkit.log(`Unloading Beaver attachment pane for window: ${win.location.href}`);
		try {
			pane.unload();
		} catch (err) {
			ztoolkit.log("Error unloading Beaver attachment pane:", err);
		}
		attachmentPanes.delete(win); // Remove from map
	}
	// Clean up Chat Panel for this window
	BeaverUIFactory.removeChatPanel(win);

	// Unload the stylesheet
	unloadKatexStylesheet();
	unloadStylesheet();

	ztoolkit.unregisterAll();
	addon.data.dialog?.window?.close();
}

function loadStylesheet() {
	// Load the stylesheet
	const styleURI = `chrome://beaver/content/styles/beaver.css`;
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

		// Dispose CitationService if it exists
		if (addon.citationService) {
			addon.citationService.dispose();
			addon.citationService = undefined;
		}

		// Final cleanup for any remaining attachment panes
		ztoolkit.log("Cleaning up all Beaver attachment panes during shutdown.");
		for (const [win, pane] of attachmentPanes.entries()) {
			ztoolkit.log(`Force unloading Beaver attachment pane for window: ${win.location.href}`);
			try {
				pane.unload();
			} catch (err) {
				ztoolkit.log("Error during shutdown unload of attachment pane:", err);
			}
		}
		attachmentPanes.clear();
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
