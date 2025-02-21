import { getLocaleID, getString } from "../utils/locale";
import { getItemMetadata } from "../utils/metadata";
import { triggerToggleChat } from "./toggleChat";
import { QuickChat } from "./quickChat";

const windowQuickChats = new WeakMap<Window, QuickChat>();

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
         * Create XUL element (vbox) with a div inside as mounting point for react chat panel for a given location
         * 
         * @param id - The ID of the chat panel
         * @param location - The location of the chat panel
         * @returns The chat panel and the React container
         */
        function createMountingElement(id: string, location: 'library' | 'reader') {
            const chatPanel = win.document.createXULElement("vbox");
            chatPanel.setAttribute("id", id);
            chatPanel.setAttribute("class", "flex flex-1 h-full min-w-0");
            chatPanel.setAttribute("style", "min-width: 0px; display: none;");
            
            // Create a div inside the vbox as mount point for the React component
            const reactContainer = win.document.createElement("div");
            reactContainer.setAttribute("id", `beaver-react-root-${location}`);
            reactContainer.setAttribute("data-location", location);
            reactContainer.setAttribute("class", "flex flex-1 flex-col h-full min-w-0");
            chatPanel.appendChild(reactContainer);
            
            return { chatPanel, reactContainer };
        }

        // Create and append mounting elements to item pane (library
        const itemPane = win.document.getElementById("zotero-item-pane");
        if (!itemPane) {
            ztoolkit.log("Item pane not found");
            return;
        }
        const { chatPanel: itemChatPanel, reactContainer: itemReactContainer } = 
            createMountingElement("beaver-pane-library", "library");
        itemPane?.appendChild(itemChatPanel);

        // Create and append mounting elements to context pane (reader)
        const contextPane = win.document.getElementById("zotero-context-pane");
        if (!contextPane) {
            ztoolkit.log("Context pane not found");
            return;
        }
        const { chatPanel: contextChatPanel, reactContainer: contextReactContainer } = 
            createMountingElement("beaver-pane-reader", "reader");
        contextPane?.appendChild(contextChatPanel);

        /**
        * Load the React bundle into the XUL window by injecting a <script> tag
        * This ensures that React runs in the context of the real XUL window
        */
        const script = win.document.createElement("script");
        script.type = "text/javascript";
        script.src = "chrome://beaver/content/reactBundle.js";
        win.document.documentElement.appendChild(script);

        script.onload = () => {
            win.renderAiSidebar(itemReactContainer, "library");
            win.renderAiSidebar(contextReactContainer, "reader");
        };

        /**
         * Toggle button in the top toolbar
         */
        const toolbar = win.document.querySelector("#zotero-tabs-toolbar");
        if (!toolbar) {
            ztoolkit.log("Toolbar not found");
            return;
        }
        const separator = toolbar.querySelector("div.zotero-tb-separator");

        const chatToggleBtn = win.document.createXULElement("toolbarbutton");
        chatToggleBtn.setAttribute("id", "zotero-beaver-tb-chat-toggle");
        chatToggleBtn.addEventListener("command", () => {
            triggerToggleChat(win);
        });

        const syncButton = toolbar.querySelector("#zotero-tb-sync");
        if (syncButton) {
            toolbar.insertBefore(chatToggleBtn, syncButton);
            if (separator) {
                const clonedSeparator = separator.cloneNode(true) as HTMLElement;
                clonedSeparator.setAttribute("id", "beaver-tb-separator");
                toolbar.insertBefore(clonedSeparator, syncButton);
            }
        } else {
            toolbar.appendChild(chatToggleBtn);
            ztoolkit.log("Sync button not found, appending chat toggle button to the end of the toolbar.");
        }

    }

    static removeChatPanel(win: Window) {
        const elementIds = ["beaver-pane-library", "beaver-pane-reader", "zotero-beaver-tb-chat-toggle", "beaver-tb-separator"]
        for (const id of elementIds) {
            const element = win.document.getElementById(id);
            if (element) {
                element.remove();
            }
        }
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
        // Unregister existing shortcuts
        // ztoolkit.Keyboard.unregisterAll();
        
        // Register keyboard shortcut for quick chat
        ztoolkit.Keyboard.register(
            (ev, keyOptions) => {
                if (keyOptions.keyboard?.equals("shift,p")) {
                    const win = Zotero.getMainWindow();
                    windowQuickChats.get(win)?.show();
                }
            }
        );

        // Register keyboard shortcut for chat panel
        ztoolkit.Keyboard.register(
            (ev, keyOptions) => {
                if (keyOptions.keyboard?.equals("accel,l")) {
                    const win = Zotero.getMainWindow();
                    triggerToggleChat(win);
                    // Prevent default behavior
                    ev.preventDefault();
                }
            }
        );
    }

    static updateItemPaneStatus(itemId: number, status: string) {
        addon.data._itemStatuses.set(itemId, status);
        Zotero.ItemPaneManager.refreshInfoRow('beaver-item-pane-status');
    }
}