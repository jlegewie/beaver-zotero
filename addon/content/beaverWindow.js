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

async function onLoad() {
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
