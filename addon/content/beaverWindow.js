/* eslint-disable no-undef, no-restricted-globals */
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

async function onLoad() {
    await Zotero.initializationPromise;
    if (window.closed || !Zotero.Beaver?.data.alive) return;
    Zotero.UIProperties.registerRoot(
        document.getElementById("beaver-pane-window"),
    );
    Zotero.Beaver.hooks.onStandaloneWindowLoad(window);
    window.addEventListener("keydown", (event) => {
        if (
            event.key === "w" &&
            (Zotero.isMac ? event.metaKey : event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey
        ) {
            event.preventDefault();
            window.close();
        }
    });
}
window.addEventListener("load", onLoad, { once: true });
window.addEventListener(
    "unload",
    () => Zotero.Beaver?.hooks.onStandaloneWindowUnload(window),
    { once: true },
);
