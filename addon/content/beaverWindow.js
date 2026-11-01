/* eslint-disable no-undef, no-restricted-globals */
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

Services.scriptloader.loadSubScript(
    "chrome://zotero/content/platformKeys.js",
    window,
);
if (Zotero.isMac) {
    Services.scriptloader.loadSubScript(
        "chrome://global/content/macWindowMenu.js",
        window,
    );
}

function onCommand(id, handler) {
    document.getElementById(id).addEventListener("command", handler);
}

function windowMenuCommand(command) {
    window.BeaverReact?.handleWindowMenuCommand(command).catch((error) => Zotero.logError(error));
}

// Registered here rather than as oncommand attributes, which the chrome CSP
// blocks. The commandset precedes this script's load event.
function registerCommands() {
    onCommand("cmd_beaverNewChat", () => windowMenuCommand("new-chat"));
    onCommand("cmd_beaverSettings", () => windowMenuCommand("settings"));
    onCommand("cmd_close", () => window.close());
    onCommand("minimizeWindow", () => window.minimize());
    // zoomWindow() comes from macWindowMenu.js, loaded above on macOS only.
    onCommand("zoomWindow", () => {
        if (typeof zoomWindow === "function") zoomWindow();
    });
}

async function onLoad() {
    registerCommands();
    if (Zotero.isWin) {
        // The Windows window exposes these actions in the chat UI and shortcuts.
        document.querySelector("menubar").hidden = true;
    }
    await Zotero.initializationPromise;
    if (window.closed || !Zotero.Beaver?.data.alive) return;
    Zotero.UIProperties.registerRoot(
        document.getElementById("beaver-pane-window"),
    );
    Zotero.Beaver.hooks.onStandaloneWindowLoad(window);
}
window.addEventListener("load", onLoad, { once: true });
window.addEventListener(
    "unload",
    () => Zotero.Beaver?.hooks.onStandaloneWindowUnload(window),
    { once: true },
);
