/* eslint-disable no-undef, no-restricted-globals */
// Get Zotero using the modern ES module import (same as Zotero's note window)
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

var BeaverReact;
var root;

function reconnectToBeaverReact(nextBeaverReact) {
    const container = document.getElementById("beaver-pane-window");
    if (!container || !nextBeaverReact ||
        typeof nextBeaverReact.renderWindowSidebar !== "function") {
        return;
    }

    // Loading or unloading an unrelated main window must not disturb an
    // auxiliary window that is already owned by this bundle.
    if (BeaverReact === nextBeaverReact) {
        return;
    }

    // The previous main-window bundle owns this root. Ask that exact bundle
    // to unmount it before replacing the reference; a newly loaded bundle's
    // roots map cannot see roots created by the obsolete bundle.
    try {
        if (BeaverReact && typeof BeaverReact.unmountFromElement === "function") {
            BeaverReact.unmountFromElement(container);
        }
    } catch (e) {
        Zotero.debug("Beaver: Error disconnecting stale separate-window React root: " + e);
    }

    BeaverReact = nextBeaverReact;
    root = BeaverReact.renderWindowSidebar(container);
    Zotero.debug("Beaver: Separate window reconnected to Main Window React instance");
}

async function onLoad() {
    // Wait for Zotero initialization
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;

    // Apply Zotero's font-size and UI density preferences to the React mount point.
    // This mirrors how Zotero's own windows do it (e.g. zoteroPane.js calls registerRoot
    // on #zotero-pane, advancedSearch.js on #zotero-search-box-container).
    const mountContainer = document.getElementById('beaver-pane-window');
    if (mountContainer) {
        Zotero.UIProperties.registerRoot(mountContainer);
    }

    // Register keyboard shortcut for closing the window (Cmd+W on Mac, Ctrl+W on Windows)
    window.addEventListener("keydown", (event) => {
        // Check for Cmd+W (Mac) or Ctrl+W (Windows)
        const isMacClose = Zotero.isMac && event.key === 'w' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const isWindowsClose = !Zotero.isMac && event.key === 'w' && event.ctrlKey && !event.altKey && !event.shiftKey;
        
        if (isMacClose || isWindowsClose) {
            event.preventDefault();
            window.close();
        }
    });

    // Use the main window's BeaverReact instance to ensure shared state (Jotai store)
    // This allows the separate window to share the same Atom instances and Store as the main window
    const mainWindow = Zotero.getMainWindow();
    
    if (mainWindow && mainWindow.BeaverReact) {
        reconnectToBeaverReact(mainWindow.BeaverReact);
    } else {
        Zotero.debug("Beaver Error: Main Window BeaverReact instance not found");
        
        // Fallback: If for some reason we can't get the main window instance,
        // we could try to load the bundle locally, but that causes the state split issue.
        // Better to fail and log than to show a broken login screen.
    }
}

function onUnload() {
    // Use the stored BeaverReact reference (which points to Main Window's instance)
    try {
        if (BeaverReact && typeof BeaverReact.unmountFromElement === "function") {
            const container = document.getElementById("beaver-pane-window");
            if (container) {
                BeaverReact.unmountFromElement(container);
                Zotero.debug("Beaver: Separate window React component unmounted");
            }
        }
    } catch (e) {
        Zotero.debug("Beaver: Error unmounting separate window: " + e);
    }
    
    // Clear references to help garbage collection
    BeaverReact = null;
    root = null;
}

// Expose the reconnect hook to the lifecycle bundle. Top-level functions are
// not reliably visible as window properties across all script configurations.
window.reconnectToBeaverReact = reconnectToBeaverReact;
window.getBeaverReactInstance = () => BeaverReact;

// Set up event listeners
window.addEventListener("load", onLoad, { once: true });
window.addEventListener("unload", onUnload, { once: true });
