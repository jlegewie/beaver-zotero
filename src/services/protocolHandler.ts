/**
 * Protocol handler for zotero://beaver URLs.
 *
 * Supported routes:
 *   zotero://beaver/thread/{threadId}
 *   zotero://beaver/thread/{threadId}/run/{runId}
 *
 * Dispatches a "loadThread" event on the main window's __beaverEventBus
 * so the React layer can open the sidebar and load the thread.
 */

const EXTENSION_KEY = "zotero://beaver";

function doAction(uri: any): void {
    const path = uri.pathQueryRef;
    if (!path) {
        ztoolkit.log("protocolHandler: Invalid URI — no path");
        return;
    }

    const params: Record<string, string> = {};
    const router = new (Zotero as any).Router(params);

    // Longer route first — Zotero.Router matches the first route that fits
    router.add("thread/:threadId/run/:runId", () => {});
    router.add("thread/:threadId", () => {});
    router.run(path.substring(1)); // strip leading "/"

    const { threadId, runId } = params;
    if (!threadId) {
        ztoolkit.log(`protocolHandler: No threadId found in URI: ${uri.spec}`);
        return;
    }

    const win = Zotero.getMainWindow();
    if (!win) {
        ztoolkit.log("protocolHandler: No main window available");
        return;
    }

    const eventBus = win.__beaverEventBus;
    if (!eventBus) {
        ztoolkit.log("protocolHandler: No __beaverEventBus on main window");
        return;
    }

    ztoolkit.log(`protocolHandler: Loading thread ${threadId}${runId ? ` / run ${runId}` : ""}`);

    eventBus.dispatchEvent(
        new win.CustomEvent("loadThread", {
            detail: { threadId, runId },
        }),
    );
}

export function registerBeaverProtocolHandler(): void {
    const handler = (Services.io
        .getProtocolHandler("zotero") as any)
        .wrappedJSObject;

    if (!handler?._extensions) {
        ztoolkit.log("protocolHandler: Cannot access zotero protocol extensions");
        return;
    }

    handler._extensions[EXTENSION_KEY] = {
        noContent: true,
        doAction,
        newChannel(uri: any) {
            this.doAction(uri);
        },
    };

    ztoolkit.log("protocolHandler: Registered zotero://beaver handler");
}

export function unregisterBeaverProtocolHandler(): void {
    try {
        const handler = (Services.io
            .getProtocolHandler("zotero") as any)
            .wrappedJSObject;

        if (handler?._extensions?.[EXTENSION_KEY]) {
            delete handler._extensions[EXTENSION_KEY];
            ztoolkit.log("protocolHandler: Unregistered zotero://beaver handler");
        }
    } catch (error) {
        ztoolkit.log(`protocolHandler: Error during unregister: ${error}`);
    }
}
