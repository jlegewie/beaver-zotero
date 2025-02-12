import { getString } from "../utils/locale";
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
            rowID: 'beaver-document-id',
            pluginID: 'beaver@test.com',
            label: { l10nID: 'beaver-item-pane-status' },
            position: 'start',
            multiline: false,
            nowrap: false,
            editable: false,
            onGetData({ item }) {
                // const status = await addon?.data?.documentService?.getDocumentStatusByItemId(item.id);
                return 'test';
            },
            /*
            onSetData({ rowID, item, tabType, editable, value }) {
                Zotero.debug(`Set custom info row ${rowID} of item ${item.id} to ${value}`);
            },
            */
        })
    }
}