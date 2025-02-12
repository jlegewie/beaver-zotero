import { getLocaleID, getString } from "../utils/locale";
import { getItemMetadata } from "../utils/metadata";

export class BeaverUIFactory {
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

    static registerInfoRow() {
        const rowID = Zotero.ItemPaneManager.registerInfoRow({
            rowID: 'beaver-item-pane-status',
            pluginID: addon.data.config.addonID,
            label: { l10nID: getLocaleID("item-pane-status") },
            position: 'afterCreators',
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

    static updateItemPaneStatus(itemId: number, status: string) {
        addon.data._itemStatuses.set(itemId, status);
        Zotero.ItemPaneManager.refreshInfoRow('beaver-item-pane-status');
    }
}