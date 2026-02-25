/**
 * Protocol handler for zotero://beaver URLs.
 *
 * Supported routes:
 *   zotero://beaver/thread/{threadId}
 *   zotero://beaver/thread/{threadId}/run/{runId}
 *   zotero://beaver/sidebar
 *   zotero://beaver/preferences
 *   zotero://beaver/preferences/{tab}
 *
 * Thread routes dispatch a "loadThread" event on the main window's
 * __beaverEventBus so the React layer can open the sidebar and load the thread.
 * Sidebar route dispatches a "toggleChat" event with forceOpen.
 * Preferences route opens the Beaver preferences window.
 */

import { openPreferencesWindow } from "../ui/openPreferencesWindow";
import { PreferencePageTab } from "../../react/atoms/ui";

const EXTENSION_KEY = "zotero://beaver";

const VALID_PREFERENCE_TABS = new Set<PreferencePageTab>([
    "general", "sync", "permissions", "models", "prompts", "advanced", "account",
]);

function doAction(uri: any): void {
    const path = uri.pathQueryRef;
    if (!path) {
        ztoolkit.log("protocolHandler: Invalid URI — no path");
        return;
    }

    const params: Record<string, string> = {};
    const router = new (Zotero as any).Router(params);

    // Longer routes first — Zotero.Router matches the first route that fits
    router.add("thread/:threadId/run/:runId", () => {});
    router.add("thread/:threadId", () => {});
    router.add("preferences/:tab", () => {});
    router.add("preferences", () => {});
    router.add("sidebar", () => {});
    router.run(path.substring(1)); // strip leading "/"

    const stripped = path.substring(1); // without leading "/"

    // --- Sidebar route ---
    if (stripped === "sidebar") {
        handleSidebar();
        return;
    }

    // --- Preferences route ---
    if (stripped === "preferences" || stripped.startsWith("preferences/")) {
        handlePreferences(params.tab);
        return;
    }

    // --- Thread route ---
    const { threadId, runId } = params;
    if (!threadId) {
        ztoolkit.log(`protocolHandler: Unrecognised URI: ${uri.spec}`);
        return;
    }

    handleThread(threadId, runId);
}

function handleSidebar(): void {
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

    ztoolkit.log("protocolHandler: Opening sidebar");
    eventBus.dispatchEvent(
        new win.CustomEvent("toggleChat", {
            detail: { forceOpen: true },
        }),
    );
}

function handlePreferences(tab?: string): void {
    const win = Zotero.getMainWindow();
    if (!win) {
        ztoolkit.log("protocolHandler: No main window available");
        return;
    }

    const resolvedTab = tab && VALID_PREFERENCE_TABS.has(tab as PreferencePageTab)
        ? (tab as PreferencePageTab)
        : undefined;

    ztoolkit.log(`protocolHandler: Opening preferences${resolvedTab ? ` (tab: ${resolvedTab})` : ""}`);
    openPreferencesWindow(resolvedTab);
}

function handleThread(threadId: string, runId?: string): void {
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
