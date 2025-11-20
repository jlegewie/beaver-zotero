import { logger } from "../utils/logger";

const BeaverProtocolHandler = {
    // 'loadAsChrome: true' allows access to chrome:// resources if returning HTML
    // Set to false if you are just performing an action
    loadAsChrome: false,

    // The entry point called by ZoteroProtocolHandler
    newChannel: function (uri: any, loadInfo: any) {
        // Parse the URI: zotero://beaver/thread/<UUID>
        // uri.pathQueryRef gives you /beaver/thread/<UUID> (or /thread/<UUID> depending on how it's registered)
        // Actually, for zotero://beaver, the pathQueryRef starts with /
        
        return new Zotero.Server.AsyncChannel(uri, loadInfo, async function () {
            try {
                // 1. Parse the path
                let path = uri.pathQueryRef; // e.g., "/thread/12345"
                
                // Remove leading slash if present
                if (path.startsWith('/')) {
                    path = path.substring(1);
                }
                
                // Check for thread action
                if (path.startsWith("thread/")) {
                    const threadId = path.substring("thread/".length);
                    
                    if (!threadId) {
                        return "Invalid URL: Missing Thread UUID";
                    }

                    // 2. Perform action: Open the thread
                    // We need to dispatch an event to the React UI
                    const win = Zotero.getMainWindow();
                    if (win && win.__beaverEventBus) {
                        // Focus the window
                        win.focus();
                        
                        // Dispatch event
                        const event = new win.CustomEvent('openThread', { 
                            detail: { threadId } 
                        });
                        win.__beaverEventBus.dispatchEvent(event);
                        
                        return "Thread opened successfully.";
                    } else {
                         return "Error: Main window or event bus not available.";
                    }
                }

                return "Invalid URL: Unknown action";

            } catch (e) {
                Zotero.logError(e);
                return "Error handling beaver protocol: " + (e as Error).message;
            }
        });
    },
};

export function registerProtocolHandler() {
    try {
        const handler = Services.io.getProtocolHandler("zotero").wrappedJSObject;
        handler._extensions["zotero://beaver"] = BeaverProtocolHandler;
        ztoolkit.log("Registered zotero://beaver protocol handler");
    } catch (e) {
        ztoolkit.log("Failed to register protocol handler", e);
    }
}

export function unregisterProtocolHandler() {
    try {
        const handler = Services.io.getProtocolHandler("zotero").wrappedJSObject;
        delete handler._extensions["zotero://beaver"];
        ztoolkit.log("Unregistered zotero://beaver protocol handler");
    } catch (e) {
        ztoolkit.log("Failed to unregister protocol handler", e);
    }
}

