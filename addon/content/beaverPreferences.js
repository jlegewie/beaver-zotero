/* eslint-disable no-undef, no-restricted-globals */
// Get Zotero using the modern ES module import (same as Zotero's note window)
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

var BeaverReact;
var root;

async function onLoad() {
    // Wait for Zotero initialization
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;

    // Register UI properties for font size and UI density (same as main Zotero windows)
    Zotero.UIProperties.registerRoot(document.documentElement);

    // Register keyboard shortcut for closing the window (Cmd+W on Mac, Ctrl+W on Windows)
    window.addEventListener("keydown", (event) => {
        const isMacClose = Zotero.isMac && event.key === 'w' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const isWindowsClose = !Zotero.isMac && event.key === 'w' && event.ctrlKey && !event.altKey && !event.shiftKey;

        if (isMacClose || isWindowsClose) {
            event.preventDefault();
            window.close();
        }
    });

    // Read the initial tab from window arguments (if passed)
    var initialTab = null;
    try {
        if (window.arguments && window.arguments[0] && window.arguments[0].tab) {
            initialTab = window.arguments[0].tab;
        }
    } catch (e) {
        // Ignore errors reading arguments
    }

    // Use the main window's BeaverReact instance to ensure shared state (Jotai store)
    const mainWindow = Zotero.getMainWindow();

    if (mainWindow && mainWindow.BeaverReact) {
        BeaverReact = mainWindow.BeaverReact;

        if (typeof BeaverReact.renderPreferencesWindow === "function") {
            const container = document.getElementById("beaver-pane-preferences");
            if (container) {
                root = BeaverReact.renderPreferencesWindow(container, initialTab);
                Zotero.debug("Beaver: Preferences window React component mounted");
            } else {
                Zotero.debug("Beaver Error: Container element #beaver-pane-preferences not found");
            }
        } else {
            Zotero.debug("Beaver Error: renderPreferencesWindow function not found on Main Window instance");
        }
    } else {
        Zotero.debug("Beaver Error: Main Window BeaverReact instance not found for preferences window");
    }
}

function onUnload() {
    try {
        if (BeaverReact && typeof BeaverReact.unmountFromElement === "function") {
            const container = document.getElementById("beaver-pane-preferences");
            if (container) {
                BeaverReact.unmountFromElement(container);
                Zotero.debug("Beaver: Preferences window React component unmounted");
            }
        }
    } catch (e) {
        Zotero.debug("Beaver: Error unmounting preferences window: " + e);
    }

    // Clear references to help garbage collection
    BeaverReact = null;
    root = null;
}

// Set up event listeners
window.addEventListener("load", onLoad, { once: true });
window.addEventListener("unload", onUnload, { once: true });
