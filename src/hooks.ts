import {
	BasicExampleFactory,
	HelperExampleFactory,
	KeyExampleFactory,
	PromptExampleFactory,
	UIExampleFactory,
} from "./modules/examples";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import { VectorStoreDB } from "./services/vectorStore";
import { VoyageClient } from "./services/voyage";
import { getPref } from "./utils/prefs";
import { ItemService } from "./services/ItemService";
import eventBus from "../react/eventBus";
import { GeminiProvider, OpenAIProvider } from "./services/OpenAIProvider";
import { CitationService } from "./services/CitationService";


async function onStartup() {
	await Promise.all([
		Zotero.initializationPromise,
		Zotero.unlockPromise,
		Zotero.uiReadyPromise,
	]);
	
	initLocale();

	ztoolkit.log("Startup");

	// Initialize database and vector store
	const dbConnection = new Zotero.DBConnection("beaver");
	const vectorStore = new VectorStoreDB(dbConnection);
	
	// Test connection and initialize schema
	await dbConnection.test();
	await vectorStore.initDatabase();
	
	// Initialize Voyage client
	const voyageApiKey = getPref("voyageApiKey");
	const voyageClient = voyageApiKey ? new VoyageClient({apiKey: voyageApiKey}) : null;
	
	if(!voyageApiKey)
		ztoolkit.log("Voyage client not initialized. Please set the API key in the preferences.");

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
	
	// Instantiate item service and store reference
	const itemService = new ItemService(vectorStore, voyageClient, 'local');
	addon.itemService = itemService;
	ztoolkit.log("itemService initialized successfully");

	BeaverUIFactory.registerShortcuts();

	// BasicExampleFactory.registerPrefs();
	
	// BasicExampleFactory.registerNotifier();
	
	// KeyExampleFactory.registerShortcuts();
	
	// await UIExampleFactory.registerExtraColumn();
	
	// await UIExampleFactory.registerExtraColumnWithCustomCell();
	
	// UIExampleFactory.registerItemPaneCustomInfoRow();
	
	// UIExampleFactory.registerItemPaneSection();
	
	// UIExampleFactory.registerReaderItemPaneSection();
	
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
	BeaverUIFactory.registerMenuItems();
	BeaverUIFactory.registerInfoRow();

	// Create (or reuse) an EventTarget for this window
	if (!win.__beaverEventBus) {
		win.__beaverEventBus = new EventTarget();
	}

	BeaverUIFactory.registerChatPanel(win);
	// BeaverUIFactory.registerExtraColumn();
	// BeaverUIFactory.registerSearchCommand();

	ztoolkit.log("UI ready");
	
	// Load styles for this window
	loadStylesheet();
	loadKatexStylesheet();
	ztoolkit.log("Styles loaded for window");

	// const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
	// 	closeOnClick: true,
	// 	closeTime: -1,
	// })
	// .createLine({
	// 	text: getString("startup-begin"),
	// 	type: "default",
	// 	progress: 0,
	// })
	// .show();
	
	// await Zotero.Promise.delay(1000);
	// popupWin.changeLine({
	// 	progress: 30,
	// 	text: `[30%] ${getString("startup-begin")}`,
	// });
	
	// UIExampleFactory.registerStyleSheet(win);
	
	// UIExampleFactory.registerRightClickMenuItem();
	
	// UIExampleFactory.registerRightClickMenuPopup(win);
	
	// UIExampleFactory.registerWindowMenuWithSeparator();
	
	// PromptExampleFactory.registerNormalCommandExample();
	
	// PromptExampleFactory.registerAnonymousCommandExample(win);
	
	// PromptExampleFactory.registerConditionalCommandExample();
		
	// await Zotero.Promise.delay(1000);
	
	// popupWin.changeLine({
	// 	progress: 100,
	// 	text: `[100%] ${getString("startup-finish")}`,
	// });
	// popupWin.startCloseTimer(5000);
	
	// addon.hooks.onDialogEvents("dialogExample");
}

async function onMainWindowUnload(win: Window): Promise<void> {
	// Clean up Chat Panel for this window
	BeaverUIFactory.removeChatPanel(win);
	// Unregister keyboard shortcuts
	// BeaverUIFactory.unregisterShortcuts();
	// Unload the stylesheet
	unloadKatexStylesheet();
	unloadStylesheet();

	ztoolkit.unregisterAll();
	addon.data.dialog?.window?.close();
	// Remove Beaver menu items
	ztoolkit.Menu.unregister("zotero-itemmenu-beaver-upsert");
	Zotero.ItemPaneManager.unregisterInfoRow('beaver-item-pane-status');
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
		// Close database connection if it exists
		if (addon.itemService) {
			await addon.itemService.closeDatabase();
		}
		// Clear item service
		addon.itemService = undefined;

		// Dispose CitationService if it exists
		if (addon.citationService) {
			addon.citationService.dispose();
			addon.citationService = undefined;
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

function onShortcuts(type: string) {
	switch (type) {
		case "larger":
		KeyExampleFactory.exampleShortcutLargerCallback();
		break;
		case "smaller":
		KeyExampleFactory.exampleShortcutSmallerCallback();
		break;
		default:
		break;
	}
}

function onDialogEvents(type: string) {
	switch (type) {
		case "dialogExample":
		HelperExampleFactory.dialogExample();
		break;
		case "clipboardExample":
		HelperExampleFactory.clipboardExample();
		break;
		case "filePickerExample":
		HelperExampleFactory.filePickerExample();
		break;
		case "progressWindowExample":
		HelperExampleFactory.progressWindowExample();
		break;
		case "vtableExample":
		HelperExampleFactory.vtableExample();
		break;
		default:
		break;
	}
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
	onStartup,
	onShutdown,
	onMainWindowLoad,
	onMainWindowUnload,
	onNotify,
	onPrefsEvent,
	onShortcuts,
	onDialogEvents,
};
