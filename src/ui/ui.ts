import { getLocaleID, getString } from "../utils/locale";
import { getItemMetadata } from "../utils/metadata";
import { triggerToggleChat } from "./toggleChat";
import { QuickChat } from "./quickChat";
import { initializeReactUI } from "../../react/ui/initialization";
import { KeyboardManager } from "../utils/keyboardManager";

const windowQuickChats = new WeakMap<Window, QuickChat>();

// Create a single instance of keyboard manager
const keyboardManager = new KeyboardManager();

export class BeaverUIFactory {
    static registerQuickChat(win: Window) {
        // Remove existing QuickChat if present
        this.removeQuickChat(win);
        
        const quickChat = new QuickChat(win, {
            deepSearch: () => {
                ztoolkit.log("Performing deep search...");
            },
            send: () => {
                ztoolkit.log("Sending message...");
            }
        });
        windowQuickChats.set(win, quickChat);
    }

    static removeQuickChat(win: Window) {
        const quickChat = windowQuickChats.get(win);
        if (quickChat) {
            quickChat.hide();
            windowQuickChats.delete(win);
        }
    }

    static registerChatPanel(win: Window) {
        // Remove existing panel if present
        this.removeChatPanel(win);

        /**
         * Create mounting points for React components
         */
        function createMountingElement(id: string, location: 'library' | 'reader') {
            const mountPoint = win.document.createXULElement("vbox");
            mountPoint.setAttribute("id", id);
            mountPoint.setAttribute("class", "flex flex-1 h-full min-w-0");
            mountPoint.setAttribute("style", "min-width: 0px; display: none;");
            
            // Create a div inside the vbox as mount point for the React component
            const reactContainer = win.document.createElement("div");
            reactContainer.setAttribute("id", `beaver-react-root-${location}`);
            reactContainer.setAttribute("data-location", location);
            reactContainer.setAttribute("class", "flex flex-1 flex-col h-full min-w-0");
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

        const chatToggleBtn = win.document.createXULElement("toolbarbutton");
        chatToggleBtn.setAttribute("id", "zotero-beaver-tb-chat-toggle");
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

    static registerMenuItems() {
        // Add to Beaver menu item
        ztoolkit.Menu.register("item", {
            tag: "menuitem",
            id: "zotero-itemmenu-beaver-upsert",
            label: getString("beaver-menu-upsert"),
            commandListener: async (ev: any) => {
                try {
                    ztoolkit.log("Processing items...");

                    // Get selected items
                    const items = Zotero.getActiveZoteroPane().getSelectedItems();
                    if (!items.length) {
                        ztoolkit.log("No items selected");
                        return;
                    }

                    if (!addon.itemService) {
                        ztoolkit.log("Item service not initialized");
                        return;
                    }

                    // Process each selected item
                    for (const item of items) {
                        await addon.itemService.processItem(item);
                    }

                    ztoolkit.log("Items processed successfully");
                } catch (error: any) {
                    ztoolkit.log(`Error processing items: ${error.message}`);
                    Zotero.debug(`Beaver error: ${error.stack}`);
                }
            },
        });
    }

    static registerSearchCommand() {
        ztoolkit.Prompt.register([
            {
                name: "Semantic Search",
                label: "Beaver",
                callback(prompt) {
                    addon.itemService?.query(prompt.inputNode.value, 1)
                        .then(items => {
                            ztoolkit.log("Search results:", items.map((item: Zotero.Item) => item.getDisplayTitle()));
                        })
                        .catch(error => {
                            ztoolkit.log("Search error:", error);
                        });
                },
            },
        ]);
    }

    static registerInfoRow() {
        const rowID = Zotero.ItemPaneManager.registerInfoRow({
            rowID: 'beaver-item-pane-status',
            pluginID: addon.data.config.addonID,
            label: { l10nID: getLocaleID("item-pane-status") },
            position: 'start',
            multiline: false,
            nowrap: false,
            editable: false,
            onGetData({ item }) {
                
                // Check cache first
                if (addon.data._itemStatuses.has(item.id)) {
                    ztoolkit.log(`Returning status for item ${item.id}: ${addon.data._itemStatuses.get(item.id)}`);
                    return addon.data._itemStatuses.get(item.id) || '';
                }
                // Set initial loading state
                addon.data._itemStatuses.set(item.id, 'Loading...');

                // Fetch status asynchronously
                addon.itemService?.getItemStatusByZoteroId(item.id)
                    .then(status => {
                        BeaverUIFactory.updateItemPaneStatus(item.id, status || 'Not in database');
                    });
                
                return 'Loading...';
            },
        })
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
        
        // Register keyboard shortcut for quick chat
        keyboardManager.register(
            (ev, keyOptions) => {                
                if (keyOptions.keyboard?.equals("shift,p")) {
                    // Prevent default behavior
                    ev.preventDefault();
                    ztoolkit.log("Shift+P shortcut triggered");
                    
                    const win = Zotero.getMainWindow();
                    windowQuickChats.get(win)?.show();
                }
            }
        );

        // Register keyboard shortcut for chat panel
        keyboardManager.register(
            (ev, keyOptions) => {
                
                // Check for accel+l shortcut
                const isAccelL = (ev.key.toLowerCase() === 'l' && (ev.ctrlKey || ev.metaKey));
                
                if (isAccelL || keyOptions.keyboard?.equals("accel,l")) {
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