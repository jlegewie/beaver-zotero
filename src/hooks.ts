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
import { BeaverMenuFactory } from "./modules/ui/menu";
import { VectorStoreDB } from "./services/vectorStore";
import { VoyageClient } from "./services/voyage";
import { getPref } from "./utils/prefs";

async function createDatabase() {
	try {
		ztoolkit.log('Initializing Beaver database...');
		
		// Create database connection
		const db = new Zotero.DBConnection("beaver");
		
		// Initialize vector store
		const vectorStore = new VectorStoreDB(db);
		
		// Test connection and initialize schema
		await db.test();
		await vectorStore.initDatabase();
		
		// Store references for later use
		addon.data.db = db;
		addon.data.vectorStore = vectorStore;
		
		ztoolkit.log("Database initialized successfully");
	} catch (error) {
		ztoolkit.log("Failed to initialize database:", error);
		throw error; // Re-throw to handle in onStartup
	}
}

async function onStartup() {
	await Promise.all([
		Zotero.initializationPromise,
		Zotero.unlockPromise,
		Zotero.uiReadyPromise,
	]);
	
	initLocale();

	// Initialize database
	await createDatabase();
	
	// Initialize Voyage client
	const voyageApiKey = getPref("voyageApiKey");
	if (voyageApiKey) {
		addon.data.voyage = new VoyageClient({
			apiKey: voyageApiKey,
		});
		ztoolkit.log("Voyage client initialized");
	} else {
		ztoolkit.log("Voyage client not initialized. Please set the API key in the preferences.");
	}
	
	
	// BasicExampleFactory.registerPrefs();
	
	// BasicExampleFactory.registerNotifier();
	
	// KeyExampleFactory.registerShortcuts();
	
	// await UIExampleFactory.registerExtraColumn();
	
	// await UIExampleFactory.registerExtraColumnWithCustomCell();
	
	// UIExampleFactory.registerItemPaneCustomInfoRow();
	
	// UIExampleFactory.registerItemPaneSection();
	
	// UIExampleFactory.registerReaderItemPaneSection();
	
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

	// Register Beaver UI elements
	BeaverMenuFactory.registerMenuItems();

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
	ztoolkit.unregisterAll();
	addon.data.dialog?.window?.close();
	// Remove Beaver menu items
	ztoolkit.Menu.unregister("zotero-itemmenu-beaver-upsert");
}

async function onShutdown(): Promise<void> {
	try {
		// Close database connection if it exists
		if (addon.data.db) {
			await addon.data.db.closeDatabase(false);
		}
	} catch (error) {
		ztoolkit.log("Error closing database:", error);
	}
	
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
	// You can add your code to the corresponding notify type
	ztoolkit.log("notify", event, type, ids, extraData);
	if (
		event == "select" &&
		type == "tab" &&
		extraData[ids[0]].type == "reader"
	) {
		BasicExampleFactory.exampleNotifierCallback();
	} else {
		return;
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
