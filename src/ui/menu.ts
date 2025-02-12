import { getString } from "../utils/locale";
import { getItemMetadata } from "../utils/metadata";

export class BeaverMenuFactory {
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

                    if (!addon.data.documentService) {
                        ztoolkit.log("Document service not initialized");
                        return;
                    }

                    // Process each selected item
                    for (const item of items) {
                        const metadata = getItemMetadata(item);
                        await addon.data.documentService.processDocument(item.id, metadata);
                    }

                    // set item status to processing
                    // ...

                    ztoolkit.log("Items processed successfully");
                } catch (error: any) {
                    ztoolkit.log(`Error processing items: ${error.message}`);
                    Zotero.debug(`Beaver error: ${error.stack}`);
                }
            },
        });
    }
}