import { getString } from "../utils/locale";


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

                    // Process each selected item using the initialized service
                    for (const item of items) {
                        const metadata = {
                            title: item.getField('title') as string,
                            abstract: item.getField('abstract') as string,
                            year: parseInt(item.getField('year') as string) || undefined,
                            author: item.getCreators()[0]?.lastName || undefined,
                            publication: item.getField('publicationTitle') as string,
                            itemType: item.itemType
                        };

                        await addon.data.documentService.processDocument(item.id, metadata);
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