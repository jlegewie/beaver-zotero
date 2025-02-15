import { getLocaleID, getString } from "../utils/locale";
import { getItemMetadata } from "../utils/metadata";
import { toggleChat } from "./chat";
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

        const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
        if (!itemPane) {
            ztoolkit.log("Item pane not found");
            return;
        }
        ztoolkit.log("onMainWindowLoad: item pane found");

        // 1) Initialize UI and add chat panel to item pane
        const chatPanel = win.document.createXULElement("vbox");
        chatPanel.setAttribute("id", "zotero-beaver-chat");
        chatPanel.setAttribute("flex", "1");
        chatPanel.setAttribute("hidden", "true");
        // chatPanel.innerHTML = `<description>Beaver AI Chat panel</description>`;

        itemPane?.appendChild(chatPanel);

        // Create a normal div inside that vbox as mount point for the React component
        const reactContainer = win.document.createElement("div");
        reactContainer.setAttribute("id", "beaver-react-root");
        chatPanel.appendChild(reactContainer);

        /**
        * Load the React bundle into the XUL window by injecting a <script> tag
        * This ensures that React runs in the context of the real XUL window
        */
        const script = win.document.createElement("script");
        script.type = "text/javascript";
        script.src = "chrome://beaver/content/reactBundle.js";
        win.document.documentElement.appendChild(script);
        script.onload = () => {
            win.renderChatApp(reactContainer);
        };

        // 2) Add a toggle button in the top toolbar (or from your extension logic)
        const toolbar = win.document.querySelector("#zotero-tabs-toolbar");
        if (!toolbar) {
            ztoolkit.log("Toolbar not found");
            return;
        }
        const separator = toolbar.querySelector("div.zotero-tb-separator");

        const chatToggleBtn = win.document.createXULElement("toolbarbutton");
        chatToggleBtn.setAttribute("id", "zotero-beaver-tb-chat-toggle");
        chatToggleBtn.addEventListener("command", () => {
            const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
            // @ts-ignore zotero item-pane is not typed
            const chatActive = itemPane?.dataset.beaverChatActive === "true";
            toggleChat(win, !chatActive);
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
        const chatPanel = win.document.querySelector("#zotero-beaver-chat");
        chatPanel?.remove();
        const chatToggleBtn = win.document.querySelector("#zotero-beaver-tb-chat-toggle");
        chatToggleBtn?.remove();
        const separator = win.document.querySelector("#beaver-tb-separator");
        separator?.remove();
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
        
        // Then register new ones
        ztoolkit.Keyboard.register(
            (ev, keyOptions) => {
                if (keyOptions.keyboard?.equals("shift,p")) {
                    const win = Zotero.getMainWindow();
                    windowQuickChats.get(win)?.show();
                }
            }
        );
    }

    static updateItemPaneStatus(itemId: number, status: string) {
        addon.data._itemStatuses.set(itemId, status);
        Zotero.ItemPaneManager.refreshInfoRow('beaver-item-pane-status');
    }
}