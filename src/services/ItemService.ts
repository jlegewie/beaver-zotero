import { ItemMetadata, Embedding, VectorStoreDB } from './vectorStore';
import { VoyageClient } from './voyage';
import { generateUUID } from '../utils/uuid';

/**
 * Simplified service to manage items (and their embeddings) directly with VectorStoreDB.
 * Handles local or remote embedding, then stores data in 'items' + 'embeddings'.
 */
export class ItemService {
    constructor(
        private db: VectorStoreDB,
        private embedClient: VoyageClient | null,
        private mode: 'local' | 'remote' = 'local'
    ) {}

    /**
     * Close the database connection.
     */
    public async closeDatabase(): Promise<void> {
        await this.db.closeDatabase();
    }

    /**
     * Get the type of a Zotero item
     */
    private getItemType(item: Zotero.Item): 'regular' | 'attachment' | 'note' | 'annotation' {
        return item.isRegularItem() ? 'regular' :
            item.isAttachment() ? 'attachment' :
            item.isNote() ? 'note' :
            item.isAnnotation() ? 'annotation' :
            'regular';
    }

    /**
     * Generate item metadata from a Zotero item
     */
    private itemMetadataFromItem(item: Zotero.Item): ItemMetadata {
        return {
            id: generateUUID(),
            item_id: item.id,
            type: this.getItemType(item),
            status_local: 'processing',
            status_remote: '',
            error: null,
            context: item.getDisplayTitle() || null,
            timestamp: Date.now()
        } as ItemMetadata;
    }

    /**
     * Generate an embedding from a Zotero item
     */
    private async generateEmbeddings(item: Zotero.Item, itemMetadata: ItemMetadata): Promise<Embedding[]> {

        const embeddings: Embedding[] = [];

        // Combine title and abstract for item-level embedding
        const combinedText = `${item.getDisplayTitle()}\n\n${item.getField('abstractNote') ?? ''}`;

        // Generate item-level embedding
        const embeddingVector = await this.embedClient?.embedDocument(combinedText);
        if (!embeddingVector) {
            throw new Error('Failed to generate item-level embedding');
        }

        // Create item-level embedding
        const itemEmbedding = {
            id: generateUUID(),
            metadata_id: itemMetadata.id,
            type: 'document',
            content: combinedText,
            embedding: new Float32Array(embeddingVector),
            model: this.embedClient?.getModel() || '',
            timestamp: Date.now()
        }  as Embedding;

        embeddings.push(itemEmbedding);

        return embeddings;
    }

    /**
     * Process an item from Zotero:
     *  1) Create or update row in 'items' table
     *  2) Generate embedding (local or remote)
     *  3) Insert a row in 'embeddings' table
     * 
     * @param item A Zotero item object
     * @returns The unique ID (UUID) used for the 'items' entry
     */
    public async processItem(item: Zotero.Item): Promise<string> {
        
        // Generate item metadata
        const itemMetadata = this.itemMetadataFromItem(item);

        // Insert (or update) the item row
        await this.db.insertItemMetadata(itemMetadata);

        // Generate embedding
        if (this.mode === 'local') {
            const embeddings = await this.generateEmbeddings(item, itemMetadata);

            // Insert the embedding row
            for (const embedding of embeddings) {
                await this.db.insertEmbedding(embedding);
            }
        }

        // Return the newly-created item ID
        return itemMetadata.id;
    }

    /**
     * Retrieve the item metadata from DB by its DB ID
     */
    public async getItemMetadataById(dbId: string): Promise<ItemMetadata | null> {
        const item = await this.db.getItemMetadataById(dbId);
        return item || null;
    }

    /**
     * Retrieve the item's local status by Zotero item ID
     */
    public async getItemStatusByZoteroId(zoteroItemId: number): Promise<string | null> {
        const itemMetadata = await this.db.getItemMetadataByItemId(zoteroItemId);
        return itemMetadata ? itemMetadata.status_local : null;
    }

    /**
     * Delete an item and its embeddings from DB
     */
    public async deleteItem(dbId: string): Promise<void> {
        await this.db.deleteItemMetadata(dbId);
    }

    /**
     * Query top-N similar items for the given text.
     *  1) Embeds the query text
     *  2) Calls vectorStore.findSimilarItems
     */
    public async query(text: string, limit: number = 5): Promise<any[]> {
        if (!this.embedClient) {
            throw new Error('Embedding client not initialized');
        }
        const queryEmbedding = await this.embedClient.embedQuery(text);
        const results = await this.db.findSimilarItems(new Float32Array(queryEmbedding), limit);
        
        // Return them as raw item metadata or transform further if you like
        return results;
    }
}