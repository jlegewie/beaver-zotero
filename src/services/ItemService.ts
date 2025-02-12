import { VectorStoreDB } from './vectorStore';
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
     * Process an item from Zotero:
     *  1) Create or update row in 'items' table
     *  2) Generate embedding (local or remote)
     *  3) Insert a row in 'embeddings' table
     * 
     * @param zoteroItem A Zotero item object, which contains fields like .title, .abstract, etc.
     * @returns The unique ID (UUID) used for the 'items' entry
     */
    public async processItem(zoteroItem: any): Promise<string> {
        // Generate a local ID for the DB 'items' table
        const itemDbId = generateUUID();

        // Decide local vs. remote embedding
        let embedding: Float32Array;
        try {
            if (this.mode === 'remote') {
                // Placeholder for future remote logic
                // e.g. embedding = await remoteApi.getEmbedding(zoteroItem);
                throw new Error('Remote embedding not yet implemented');
            }
            if (this.mode === 'local' && this.embedClient) {
                // "Local" embedding via your VoyageClient
                const combinedText = `${zoteroItem.title}\n\n${zoteroItem.abstract ?? ''}`;
                const embedArray = await this.embedClient.embedDocument(combinedText);
                embedding = new Float32Array(embedArray);
            }
            if (this.mode === 'local' && !this.embedClient) {
                throw new Error('Local embedding not yet implemented');
            }
        } catch (err) {
            // If embedding fails, store error on the item row
            await this.db.insertItemMetadata({
                id: itemDbId,
                item_id: zoteroItem.id,        // Zotero item ID
                type: zoteroItem.itemType || 'regular',
                status_local: 'error',
                status_remote: '',
                error: (err as Error).message,
                context: null,   // or you could store .title, .abstract, etc.
                timestamp: Date.now()
            });
            return itemDbId;
        }

        // 1) Insert (or update) the item row
        await this.db.insertItemMetadata({
            id: itemDbId,
            item_id: zoteroItem.id,
            type: zoteroItem.itemType || 'regular',
            status_local: 'processed',
            status_remote: '',
            error: null,
            context: zoteroItem.title || null, // optionally store some context text
            timestamp: Date.now()
        });

        // 2) Insert the embedding row
        await this.db.insertEmbedding({
            id: generateUUID(),
            metadata_id: itemDbId,
            type: 'document',       // let 'document' represent the item-level embedding
            content: zoteroItem.title || '',
            embedding: embedding,
            model: 'voyage-model',
            timestamp: Date.now()
        });

        // Return the newly-created item ID
        return itemDbId;
    }

    /**
     * Retrieve the item metadata from DB by its DB ID
     */
    public async getItemByDbId(dbId: string): Promise<any | null> {
        const item = await this.db.getItemMetadataById(dbId);
        return item || null;
    }

    /**
     * Retrieve the item’s local status by Zotero item ID
     */
    public async getItemStatusByZoteroId(zoteroItemId: number): Promise<string | null> {
        const item = await this.db.getItemMetadataByItemId(zoteroItemId);
        return item ? item.status_local : null;
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