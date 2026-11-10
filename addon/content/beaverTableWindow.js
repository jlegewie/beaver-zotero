/* eslint-disable no-undef, no-restricted-globals */
// The table window's chrome: Zotero's platform keys and text commands, the
// macOS window menu, and the hand-off of every table command and menu update
// to the plugin (src/ui/tableWindow.ts). The table itself is rendered by the
// plugin into #beaver-pane-table-window.
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

Services.scriptloader.loadSubScript("chrome://zotero/content/platformKeys.js", window);
// goDoCommand / goUpdateCommand, used by the Edit menu's text commands.
Services.scriptloader.loadSubScript("chrome://global/content/globalOverlay.js", window);
// Adds cmd_undo, cmd_copy, … and the text field context menu.
Services.scriptloader.loadSubScript("chrome://zotero/content/editMenuOverlay.js", window);
if (Zotero.isMac) {
    Services.scriptloader.loadSubScript("chrome://global/content/macWindowMenu.js", window);
}

function onCommand(id, handler) {
    document.getElementById(id).addEventListener("command", handler);
}

// Registered here rather than as on* attributes, which the chrome CSP blocks.
function registerCommands() {
    document.getElementById("beaverTableCommands").addEventListener("command", (event) => {
        const command = event.target.getAttribute("data-table-command");
        if (command) Zotero.Beaver?.hooks.onTableWindowCommand(window, command);
    });
    onCommand("cmd_close", () => window.close());
    onCommand("minimizeWindow", () => window.minimize());
    // zoomWindow() comes from macWindowMenu.js, loaded above on macOS only.
    onCommand("zoomWindow", () => {
        if (typeof zoomWindow === "function") zoomWindow();
    });

    const menubar = document.getElementById("beaver-table-menubar");
    menubar.addEventListener("popupshowing", (event) => {
        // Only the menus' own popups, not a submenu or a text field's menu.
        if (event.target.parentNode?.parentNode !== menubar) return;
        Zotero.Beaver?.hooks.onTableWindowMenuShowing(window);
        if (event.target.id === "menu_EditPopup") goUpdateGlobalEditMenuItems(true);
    });

    if (!Zotero.isMac) {
        // Window → Minimize/Zoom and the window list are macOS conventions.
        document.getElementById("windowMenu").hidden = true;
        document.getElementById("macKeyset").remove();
    }
}

async function onLoad() {
    registerCommands();
    await Zotero.initializationPromise;
    if (window.closed || !Zotero.Beaver?.data.alive) {
        window.close();
        return;
    }
    Zotero.UIProperties.registerRoot(document.getElementById("beaver-pane-table-window"));
    Zotero.Beaver.hooks.onTableWindowLoad(window);
}
window.addEventListener("load", onLoad, { once: true });
window.addEventListener(
    "unload",
    () => Zotero.Beaver?.hooks.onTableWindowUnload(window),
    { once: true },
);
