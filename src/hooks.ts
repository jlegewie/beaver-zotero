import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import { getPref } from "./utils/prefs";
import eventBus from "../react/eventBus";
import { GeminiProvider, OpenAIProvider } from "./services/OpenAIProvider";
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

	// Initialize database
	const dbConnection = new Zotero.DBConnection("beaver");
	const beaverDB = new BeaverDB(dbConnection);
	addon.db = beaverDB;

	// Test connection and initialize schema
	await dbConnection.test();
	await beaverDB.initDatabase();
	
	// Initialize Generative AI provider
	let provider;
	if (getPref("googleGenerativeAiApiKey")) {
		provider = new GeminiProvider(getPref("googleGenerativeAiApiKey"));
	} else if (getPref("openAiApiKey")) {
		provider = new OpenAIProvider(getPref("openAiApiKey"));
	}
	addon.aiProvider = provider;
	
	// Initialize Citation Service with caching
	const citationService = new CitationService(ztoolkit);
	addon.citationService = citationService;
	ztoolkit.log("CitationService initialized successfully");
	
	BeaverUIFactory.registerShortcuts();

	// Register preference pane
	// Zotero.PreferencePanes.register({
	// 	pluginID: addon.data.config.addonID,
	// 	src: rootURI + "content/preferences.xhtml",
	// 	label: "Beaver",
	// 	image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
	// });
	// ztoolkit.log("Preference pane registered");

	// Add event bus to window
	Zotero.getMainWindow().__beaverEventBus = eventBus;
	
	await Promise.all(
		Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
	);
}

async function onMainWindowLoad(win: Window): Promise<void> {
	// Create ztoolkit for every window
	addon.data.ztoolkit = createZToolkit();
	
	// @ts-ignore This is a moz feature
	win.MozXULElement.insertFTLIfNeeded(
		`${addon.data.config.addonRef}-mainWindow.ftl`,
	);

	// Wait for the UI to be ready
	await Promise.all([
    	Zotero.initializationPromise,
		Zotero.unlockPromise,
		Zotero.uiReadyPromise,
	]);

	// Register Beaver UI elements
	// BeaverUIFactory.registerMenuItems();

	// Create (or reuse) an EventTarget for this window
	if (!win.__beaverEventBus) {
		win.__beaverEventBus = new EventTarget();
	}

	BeaverUIFactory.registerChatPanel(win);
	// BeaverUIFactory.registerExtraColumn();
	// BeaverUIFactory.registerSearchCommand();

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
	// Unregister keyboard shortcuts
	// BeaverUIFactory.unregisterShortcuts();
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

/**
* This function is just an example of dispatcher for Notify events.
* Any operations should be placed in a function to keep this funcion clear.
*/
async function onNotify(
	event: string,
	type: string,
	ids: Array<string | number>,
	extraData: { [key: string]: any },
) {
	// Skip if addon is not alive
	if (!addon?.data.alive) return;
	ztoolkit.log("notify", event, type, ids, extraData);

	
	// Get all main windows
	const windows = Zotero.getMainWindows();
	
	// Handle different notification types
	switch (type) {
		case "item":
			// Dispatch itemSelected event to all windows
			if (event === "select") {
				windows.forEach(win => {
					if (win.__beaverEventBus) {
						win.__beaverEventBus.dispatchEvent(
							new win.CustomEvent("itemSelected", { 
								detail: { itemIDs: ids } 
							})
						);
					}
				});
			}
			break;
			
		// Add other notification types as needed
		default:
			break;
	}
}

/**
* This function is just an example of dispatcher for Preference UI events.
* Any operations should be placed in a function to keep this funcion clear.
* @param type event type
* @param data event data
*/
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
	switch (type) {
		case "load":
		registerPrefsScripts(data.window);
		break;
		default:
		return;
	}
}

export default {
	onStartup,
	onShutdown,
	onMainWindowLoad,
	onMainWindowUnload,
	onNotify,
	onPrefsEvent
};
