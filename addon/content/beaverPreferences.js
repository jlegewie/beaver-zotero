/* eslint-disable no-undef, no-restricted-globals */
// Get Zotero using the modern ES module import (same as Zotero's note window)
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

var BeaverReact;
var root;

function getInitialView() {
    var initialTab = null;
    var initialActionsCategoryFilter = null;
    var initialActionId = null;
    try {
        if (window.arguments && window.arguments[0]) {
            initialTab = window.arguments[0].tab || null;
            initialActionsCategoryFilter = window.arguments[0].actionsCategoryFilter || null;
            initialActionId = window.arguments[0].actionId || null;
        }
    } catch (e) {
        // Ignore errors reading arguments
    }
    return { initialTab, initialActionsCategoryFilter, initialActionId };
}

function reconnectToBeaverReact(nextBeaverReact) {
    const container = document.getElementById("beaver-pane-preferences");
    if (!container || !nextBeaverReact ||
        typeof nextBeaverReact.renderPreferencesWindow !== "function") {
        return;
    }

    // Loading or unloading an unrelated main window must not disturb an
    // auxiliary window that is already owned by this bundle.
    if (BeaverReact === nextBeaverReact) {
        return;
    }

    // window.arguments describes only the original open request. On a real
    // bundle handoff, preserve the tab the user is viewing and do not replay
    // one-shot category/action requests from that original request.
    const view = BeaverReact
        ? {
            initialTab: typeof Zotero.__beaverGetPreferencesTab === "function"
                ? Zotero.__beaverGetPreferencesTab()
                : null,
            initialActionsCategoryFilter: null,
            initialActionId: null,
        }
        : getInitialView();

    try {
        if (BeaverReact && typeof BeaverReact.unmountFromElement === "function") {
            BeaverReact.unmountFromElement(container);
        }
    } catch (e) {
        Zotero.debug("Beaver: Error disconnecting stale preferences React root: " + e);
    }

    BeaverReact = nextBeaverReact;
    root = BeaverReact.renderPreferencesWindow(
        container,
        view.initialTab,
        view.initialActionsCategoryFilter,
        view.initialActionId
    );
    Zotero.debug("Beaver: Preferences window reconnected to Main Window React instance");
}

async function onLoad() {
    // Wait for Zotero initialization
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;

    // Apply Zotero's font-size and UI density preferences to the React mount point.
    // This mirrors how Zotero's own windows do it (e.g. zoteroPane.js calls registerRoot
    // on #zotero-pane, advancedSearch.js on #zotero-search-box-container).
    const mountContainer = document.getElementById('beaver-pane-preferences');
    if (mountContainer) {
        Zotero.UIProperties.registerRoot(mountContainer);
    }

    // Register keyboard shortcut for closing the window (Cmd+W on Mac, Ctrl+W on Windows)
    window.addEventListener("keydown", (event) => {
        const isMacClose = Zotero.isMac && event.key === 'w' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const isWindowsClose = !Zotero.isMac && event.key === 'w' && event.ctrlKey && !event.altKey && !event.shiftKey;

        if (isMacClose || isWindowsClose) {
            event.preventDefault();
            window.close();
        }
    });

    // Read the initial tab (and, for the Actions tab, an initial category filter
    // or an action to open in edit mode) from window arguments (if passed)
    // Use the main window's BeaverReact instance to ensure shared state (Jotai store)
    const mainWindow = Zotero.getMainWindow();

    if (mainWindow && mainWindow.BeaverReact) {
        reconnectToBeaverReact(mainWindow.BeaverReact);
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

window.reconnectToBeaverReact = reconnectToBeaverReact;
window.getBeaverReactInstance = () => BeaverReact;

// Set up event listeners
window.addEventListener("load", onLoad, { once: true });
window.addEventListener("unload", onUnload, { once: true });
