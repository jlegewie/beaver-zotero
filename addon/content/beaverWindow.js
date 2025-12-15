/* eslint-disable no-undef */
// Get Zotero using the modern ES module import (same as Zotero's note window)
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

var BeaverReact;
var root;

async function onLoad() {
    // Wait for Zotero initialization
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;

    // Register UI properties for font size and UI density (same as main Zotero windows)
    // This applies the user's preferred font size and UI density settings
    Zotero.UIProperties.registerRoot(document.documentElement);

    // Use the main window's BeaverReact instance to ensure shared state (Jotai store)
    // This allows the separate window to share the same Atom instances and Store as the main window
    const mainWindow = Zotero.getMainWindow();
    
    if (mainWindow && mainWindow.BeaverReact) {
        BeaverReact = mainWindow.BeaverReact;
        
        if (typeof BeaverReact.renderWindowSidebar === "function") {
            // Note: We use "beaver-pane-window" to match the CSS selectors in beaver.css
            const container = document.getElementById("beaver-pane-window");
            if (container) {
                // Render into this window's container using the main window's React instance
                root = BeaverReact.renderWindowSidebar(container);
                Zotero.debug("Beaver: Separate window React component mounted using Main Window instance");
            } else {
                Zotero.debug("Beaver Error: Container element #beaver-pane-window not found");
            }
        } else {
            Zotero.debug("Beaver Error: renderWindowSidebar function not found on Main Window instance");
        }
    } else {
        Zotero.debug("Beaver Error: Main Window BeaverReact instance not found");
        
        // Fallback: If for some reason we can't get the main window instance,
        // we could try to load the bundle locally, but that causes the state split issue.
        // Better to fail and log than to show a broken login screen.
    }
}

function onUnload() {
    // Use the stored BeaverReact reference (which points to Main Window's instance)
    if (BeaverReact && typeof BeaverReact.unmountFromElement === "function") {
        const container = document.getElementById("beaver-pane-window");
        if (container) {
            BeaverReact.unmountFromElement(container);
            Zotero.debug("Beaver: Separate window React component unmounted");
        }
    }
}

// Set up event listeners
window.addEventListener("load", onLoad);
window.addEventListener("unload", onUnload);
