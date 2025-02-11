import { getString } from "../../utils/locale";
import { collectItemData, processAndStoreItem } from "../../services/itemProcessing";
import { VoyageClient } from "../../lib/voyage";
import { VectorStoreDB } from "../vectorStore";

export class BeaverMenuFactory {
    static registerMenuItems() {
        // Add to Beaver menu item
        ztoolkit.Menu.register("item", {
            tag: "menuitem",
            id: "zotero-itemmenu-beaver-upsert",
            label: getString("beaver-menu-upsert"),
            commandListener: async (ev) => {
                try {
                    ztoolkit.log("Upserting item to Beaver...");
                    // Get selected items
                    const items = Zotero.getActiveZoteroPane().getSelectedItems();
                    if (!items.length) {
                        ztoolkit.log("No items selected");
                        return;
                    }

                    if (!addon.data.voyage || !addon.data.vectorStore) {
                        ztoolkit.log("Voyage or vector store not initialized");
                        return;
                    }

                    // Process each selected item
                    for (const item of items) {
                        const data = await collectItemData(item);
                        await processAndStoreItem(data, addon.data.voyage, addon.data.vectorStore);
                    }

                    ztoolkit.log("Items processed successfully");
                } catch (error: any) {
                    ztoolkit.log(`Error processing items: ${error.message}`);
                    Zotero.debug(`Beaver error: ${error.stack}`);
                }
            },
        });
    }
} 