import { getString } from "../utils/locale";
import { DocumentServiceFactory } from "../services/DocumentServiceFactory";

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

                    // Create document service
                    const documentService = DocumentServiceFactory.create({
                        mode: 'local',
                        vectorStore: addon.data.vectorStore,
                        voyageClient: addon.data.voyage
                    });

                    // Process each selected item
                    for (const item of items) {
                        const metadata = {
                            title: item.getField('title') as string,
                            abstract: item.getField('abstract') as string,
                            year: parseInt(item.getField('year') as string) || undefined,
                            author: item.getCreators()[0]?.lastName || undefined,
                            publication: item.getField('publicationTitle') as string,
                            itemType: item.itemType
                        };

                        await documentService.processDocument(item.id, metadata);
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