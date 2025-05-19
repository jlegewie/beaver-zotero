import { getLocaleID, getString } from "../utils/locale";
import { triggerToggleChat } from "./toggleChat";
import { initializeReactUI } from "../../react/ui/initialization";
import { KeyboardManager } from "../utils/keyboardManager";
import { getPref } from "../utils/prefs";

// Create a single instance of keyboard manager
const keyboardManager = new KeyboardManager();

export class BeaverUIFactory {

    static registerChatPanel(win: Window) {
        // Remove existing panel if present
        this.removeChatPanel(win);

        /**
         * Create mounting points for React components
         */
        function createMountingElement(id: string, location: 'library' | 'reader') {
            const mountPoint = win.document.createXULElement("vbox");
            mountPoint.setAttribute("id", id);
            mountPoint.setAttribute("class", "display-flex flex-1 h-full min-w-0");
            mountPoint.setAttribute("style", "min-width: 0px; display: none;");
            
            // Create a div inside the vbox as mount point for the React component
            const reactContainer = win.document.createElement("div");
            reactContainer.setAttribute("id", `beaver-react-root-${location}`);
            reactContainer.setAttribute("data-location", location);
            reactContainer.setAttribute("class", "display-flex flex-1 flex-col h-full min-w-0");
            mountPoint.appendChild(reactContainer);
            
            return { mountPoint, reactContainer };
        }

        // Create and append mounting points
        const itemPane = win.document.getElementById("zotero-item-pane");
        const contextPane = win.document.getElementById("zotero-context-pane");

        if (itemPane) {
            const { mountPoint: libraryMount } = createMountingElement("beaver-pane-library", "library");
            itemPane.appendChild(libraryMount);
        }

        if (contextPane) {
            const { mountPoint: readerMount } = createMountingElement("beaver-pane-reader", "reader");
            contextPane.appendChild(readerMount);
        }

        // Add toggle button to toolbar
        this.addToolbarButton(win);

        // Load React bundle
        const script = win.document.createElement("script");
        script.type = "text/javascript";
        script.src = "chrome://beaver/content/reactBundle.js";
        win.document.documentElement.appendChild(script);

        script.onload = () => {
            // Initialize React UI
            initializeReactUI(win);
            
            // Render React components
            const libraryRoot = win.document.getElementById("beaver-react-root-library");
            const readerRoot = win.document.getElementById("beaver-react-root-reader");
            
            if (libraryRoot) win.renderAiSidebar(libraryRoot, "library");
            if (readerRoot) win.renderAiSidebar(readerRoot, "reader");
        };
    }

    private static addToolbarButton(win: Window) {
        const toolbar = win.document.querySelector("#zotero-tabs-toolbar");
        if (!toolbar) return;

        const key = getPref("keyboardShortcut").toUpperCase() || "L";
        const shortcut = Zotero.isMac ? `⌘${key}` : `Ctrl+${key}`;
        const chatToggleBtn = win.document.createXULElement("toolbarbutton");
        chatToggleBtn.setAttribute("id", "zotero-beaver-tb-chat-toggle");
        chatToggleBtn.setAttribute("tooltiptext", `Toggle AI Chat (${shortcut})`);
        chatToggleBtn.addEventListener("command", () => triggerToggleChat(win));

        const syncButton = toolbar.querySelector("#zotero-tb-sync");
        const separator = toolbar.querySelector("div.zotero-tb-separator");

        if (syncButton) {
            toolbar.insertBefore(chatToggleBtn, syncButton);
            if (separator) {
                const clonedSeparator = separator.cloneNode(true) as HTMLElement;
                clonedSeparator.setAttribute("id", "beaver-tb-separator");
                toolbar.insertBefore(clonedSeparator, syncButton);
            }
        } else {
            toolbar.appendChild(chatToggleBtn);
        }
    }

    static removeChatPanel(win: Window) {
        const elementIds = ["beaver-pane-library", "beaver-pane-reader", "zotero-beaver-tb-chat-toggle", "beaver-tb-separator"];
        elementIds.forEach(id => win.document.getElementById(id)?.remove());
    }

    static registerExtraColumn() {
        Zotero.ItemTreeManager.registerColumn({
            pluginID: addon.data.config.addonID,
            dataKey: 'beaver-status',
            // label: getLocaleID("item-pane-status"),
            label: "Status",
            dataProvider: (item: Zotero.Item, dataKey: string) => {
                return item.id.toString();
                // return addon.data._itemStatuses.get(item.id) || '';
            }
            // iconPath: "chrome://zotero/skin/cross.png",
        });
    }

    static registerShortcuts() {
        // Always unregister all existing shortcuts first to prevent duplicates
        keyboardManager.unregisterAll();
        
        ztoolkit.log("Registering keyboard shortcuts...");

        // Register keyboard shortcut for chat panel
        const keyboardShortcut = getPref("keyboardShortcut").toLowerCase() || "l";
        keyboardManager.register(
            (ev, keyOptions) => {
                
                // Check for accel+l shortcut
                const isAccelL = (ev.key.toLowerCase() === keyboardShortcut && (ev.ctrlKey || ev.metaKey));
                
                if (isAccelL || keyOptions.keyboard?.equals(`accel,${keyboardShortcut}`)) {
                    // Prevent default behavior
                    ev.preventDefault();
                    
                    // The Reader view requires a different approach than the library view
                    let win;
                    
                    // First check if we're in a reader window
                    if (ev.target && (ev.target as HTMLElement).ownerDocument) {
                        const doc = (ev.target as HTMLElement).ownerDocument;
                        if (doc.defaultView) {
                            win = doc.defaultView;
                        }
                    }
                    
                    // If we couldn't get the window from the event target,
                    // fall back to the main window
                    if (!win) {
                        win = Zotero.getMainWindow();
                    }
                    
                    // Toggle the chat panel
                    triggerToggleChat(win);
                }
            }
        );
    }
    
    /**
     * Unregister all keyboard shortcuts 
     * Should be called during plugin shutdown or window unload
     */
    static unregisterShortcuts() {
        keyboardManager.unregisterAll();
    }

    static updateItemPaneStatus(itemId: number, status: string) {
        addon.data._itemStatuses.set(itemId, status);
        Zotero.ItemPaneManager.refreshInfoRow('beaver-item-pane-status');
    }
}