// Current schema version for migrations.
const CURRENT_SCHEMA_VERSION = 1;

// Item-level interface (matches 'items' table)
export interface ItemMetadata {
    id: string;
    item_id: number;          // Zotero item ID
    type: 'regular' | 'attachment' | 'note' | 'annotation';
    status_local: string;     // Local processing status
    status_remote: string;    // Remote processing status
    error: string | null;     // Error message if any
    context: string | null;   // Short description of item used as document-level context for chunks
    timestamp: number;        // Unix timestamp
}

// Embedding-level interface (matches 'embeddings' table)
export interface Embedding {
    id: string;
    metadata_id: string;      // references ItemMetadata.id
    type: 'chunk' | 'document';
    content: string;
    embedding: Float32Array;  // stored as BLOB in DB
    model: string;
    timestamp: number;
}

/**
* Class that manages an SQLite-based vector store using
* Zotero's DBConnection for queries and migrations.
*/
export class VectorStoreDB {
    private db: any; // Instance of Zotero.DBConnection
    
    constructor(dbConnection: any) {
        this.db = dbConnection;
    }
    
    /**
    * Initialize the database and perform migrations as needed.
    * Should be called once after constructing the class
    * 
    * Usage: await vectorStore.initDatabase().
    */
    public async initDatabase(): Promise<void> {
        // 1) Create migrations table if not exists
        await this.db.queryAsync(`
            CREATE TABLE IF NOT EXISTS migrations (
                version INTEGER NOT NULL
            );
        `);
            
        // 2) See if the migrations table has an entry
        const rows = await this.db.queryAsync(`SELECT version FROM migrations`);
        let currentVersion = 0;
        
        if (rows.length > 0) {
            currentVersion = rows[0].version;
        } else {
            // Insert row if table is empty
            await this.db.queryAsync(`INSERT INTO migrations (version) VALUES (0)`);
        }
        
        // 3) Run migrations from current version up to CURRENT_SCHEMA_VERSION
        if (currentVersion < 1) {
            await this.runMigration1();
            currentVersion = 1;
        }
        
        // Additional migrations `if (currentVersion < 2) {...}`
        
        // 4) Update migrations table with the final version
        await this.db.queryAsync(`UPDATE migrations SET version=?1`, [currentVersion]);
    }
        
    /**
    * Migration 1: Create the 'items' and 'embeddings' tables.
    */
    private async runMigration1() {
        // Items table
        await this.db.queryAsync(`
            CREATE TABLE IF NOT EXISTS items (
                id              TEXT(36) PRIMARY KEY,
                item_id         INTEGER NOT NULL,
                type            TEXT NOT NULL,
                status_local    TEXT,
                status_remote   TEXT,
                error           TEXT,
                context         TEXT,
                timestamp       INTEGER
            );
        `);
                
        // Embeddings table
        await this.db.queryAsync(`
            CREATE TABLE IF NOT EXISTS embeddings (
                id            TEXT(36) PRIMARY KEY,
                metadata_id   TEXT NOT NULL,
                type          TEXT NOT NULL,
                content       TEXT,
                embedding     BLOB,
                model         TEXT,
                timestamp     INTEGER
            );
        `);
    }

    /**
    * Close the database connection.
    */
    public async closeDatabase(): Promise<void> {
        await this.db.closeDatabase();
    }
    
    /**
    * Insert an item record into the 'items' table.
    * @param item Item data
    * @returns The new 'id' of the inserted item
    */
    public async insertItemMetadata(item: ItemMetadata): Promise<string> {
        await this.db.queryAsync(
            `INSERT INTO items (id, item_id, status_local, status_remote, error, context, type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                item.id,
                item.item_id,
                item.status_local,
                item.status_remote,
                item.error,
                item.context,
                item.type,
                item.timestamp
            ]
        );
        
        return item.id;
    }
    
    /**
    * Insert an embedding record into the 'embeddings' table.
    * @param embedding Embedding data
    * @returns The new 'id' of the inserted embedding
    */
    public async insertEmbedding(embedding: Embedding): Promise<string> {
        const blob = this.float32ToBlob(embedding.embedding);
        
        await this.db.queryAsync(
            `INSERT INTO embeddings (id, metadata_id, type, content, embedding, model, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                embedding.id,
                embedding.metadata_id,
                embedding.type,
                embedding.content,
                blob,
                embedding.model,
                embedding.timestamp
            ]
        );
        
        return embedding.id;
    }
    
    /**
    * Helper method to construct ItemMetadata from a database row
    */
    private static rowToItemMetadata(row: any): ItemMetadata {
        return {
            id: row.id,
            item_id: row.item_id,
            status_local: row.status_local,
            status_remote: row.status_remote,
            error: row.error,
            context: row.context,
            type: row.type,
            timestamp: row.timestamp
        };
    }
    
    /**
    * Retrieve an item metadata by ID.
    */
    public async getItemMetadataById(id: string): Promise<ItemMetadata | null> {
        const rows = await this.db.queryAsync(
            `SELECT * FROM items WHERE id=?1`,
            [id]
        );
        return rows.length === 0 ? null : VectorStoreDB.rowToItemMetadata(rows[0]);
    }

    /**
    * Retrieve an item metadata by Zotero item ID.
    */
    public async getItemMetadataByItemId(itemId: number): Promise<ItemMetadata | null> {
        const rows = await this.db.queryAsync(
            `SELECT * FROM items WHERE item_id=?1`,
            [itemId]
        );
        return rows.length === 0 ? null : VectorStoreDB.rowToItemMetadata(rows[0]);
    }
    
    /**
    * Retrieve an embedding by ID.
    */
    public async getEmbeddingById(id: string): Promise<Embedding | null> {
        const rows = await this.db.queryAsync(
            `SELECT * FROM embeddings WHERE id=?1`,
            [id]
        );
        if (rows.length === 0) {
            return null;
        }
        
        const row = rows[0];
        const embedding = this.blobToFloat32(row.embedding);
        
        return {
            id: row.id,
            metadata_id: row.metadata_id,
            type: row.type as 'chunk' | 'document',
            content: row.content,
            embedding: embedding,
            model: row.model,
            timestamp: row.timestamp
        } as Embedding;
    }
    
    /**
    * Update an existing item
    */
    public async updateItemMetadata(id: string, updates: Partial<ItemMetadata>): Promise<void> {
        // Define which fields can be updated
        const allowedFields: (keyof Omit<ItemMetadata, 'id'>)[] = [
            "item_id",
            "status_local",
            "status_remote",
            "error",
            "context",
            "type",
            "timestamp"
        ];

        // Build the update clauses and corresponding values dynamically.
        const fieldsToUpdate = allowedFields.filter(field => updates[field] !== undefined);

        // If nothing to update, simply return.
        if (fieldsToUpdate.length === 0) {
            return;
        }

        // Create the SET clauses, e.g., "status_local = ?, item_id = ?"
        const setClauses = fieldsToUpdate.map(field => `${field} = ?`).join(', ');

        // Gather the corresponding values in the same order.
        const values = fieldsToUpdate.map(field => updates[field]);

        // Append the id for the WHERE clause.
        values.push(id);

        // Construct and execute the query.
        const query = `UPDATE items SET ${setClauses} WHERE id = ?`;
        await this.db.queryAsync(query, values);
    }

                
    /**
    * Delete methods
    */
    public async deleteItemMetadata(id: string): Promise<void> {
        await this.db.queryAsync(
            `DELETE FROM items WHERE id=?1`,
            [id]
        );
        await this.db.queryAsync(
            `DELETE FROM embeddings WHERE item_id=?1`,
            [id]
        );
    }
    
    /**
    * Similarity search for items to a given embedding.
    * 
    * Search is done in memory by:
    * 1) Retrieving embeddings from DB
    * 2) Computing cosine distance (or 1 - similarity)
    * 
    * @param queryEmbedding The query embedding (Float16Array)
    * @param limit Max results to return
    * @returns Array of ItemMetadata, sorted by ascending distance
    */
    public async findSimilarItems(
        queryEmbedding: Float32Array,
        limit = 5
    ): Promise<ItemMetadata[]> {
        // 1) Load items joined to their 'document'-type embedding
        const rows = await this.db.queryAsync(`
            SELECT i.*, e.embedding
            FROM items i
            JOIN embeddings e ON i.id = e.metadata_id
            WHERE e.type = 'document'
        `);

        // 2) Calculate distances
        const results: Array<{ item: ItemMetadata; distance: number }> = [];
        for (const row of rows) {
            const embedding = this.blobToFloat32(row.embedding);
            const distance = this.cosineDistance(queryEmbedding, embedding);

            // Convert row → ItemMetadata (existing helper)
            const itemMetadata: ItemMetadata = VectorStoreDB.rowToItemMetadata(row);
            results.push({ item: itemMetadata, distance });
        }

        // 3) Sort by ascending distance
        results.sort((a, b) => a.distance - b.distance);

        // 4) Return top N items
        return results.slice(0, limit).map(r => r.item);
    }

    
    /**
    * Convert a Float32Array to a Uint8Array for BLOB storage.
    */
    private float32ToBlob(arr: Float32Array): Uint8Array {
        return new Uint8Array(arr.buffer);
    }
    
    /**
    * Convert a BLOB (Uint8Array) back into a Float32Array.
    */
    private blobToFloat32(blob: Uint8Array): Float32Array {
        return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    }
    
    /**
    * Calculate the cosine distance between two embeddings.
    * Cosine distance = 1 - (dot(a, b) / (|a| * |b|)).
    */
    private cosineDistance(a: Float32Array, b: Float32Array): number {
        const dot = this.dotProduct(a, b);
        const magA = Math.sqrt(this.dotProduct(a, a));
        const magB = Math.sqrt(this.dotProduct(b, b));
        const similarity = (magA && magB) ? (dot / (magA * magB)) : 0;
        return 1 - similarity;
    }
    
    /**
    * Dot product of two same-length Float32Arrays.
    */
    private dotProduct(a: Float32Array, b: Float32Array): number {
        let sum = 0;
        const length = Math.min(a.length, b.length);
        for (let i = 0; i < length; i++) {
            sum += a[i] * b[i];
        }
        return sum;
    }
}


/*  Example Usage
(async () => {

    // 1) Create or open a Zotero DBConnection.
    const myDB = new Zotero.DBConnection("myVectorStore");

    // 2) Create a VectorStoreDB instance
    const vectorStore = new VectorStoreDB(myDB);

    // 3) Test and initialize the database
    await myDB.test();                // Ensure DB opens
    await vectorStore.initDatabase(); // Run migrations

    // 4) Insert a document
    const newDocId = await vectorStore.insertItemMetadata({
        id: "1234",
        item_id: 1234,
        type: "regular" as const,
        status_local: "ready",
        status_remote: "",
        error: null,
        context: "This is a test document",
        timestamp: Date.now()
    });
    console.log("Inserted document ID:", newDocId);

    // 5) Insert a chunk
    const chunkEmbedding = new Float32Array([0.5, 0.6, 0.7, 0.8]);
    const newChunkId = await vectorStore.insertEmbedding({
        id: "5678",
        metadata_id: "1234",
        type: "chunk" as const,
        content: "Chunk content goes here...",
        embedding: chunkEmbedding,
        model: "modelA",
        timestamp: Date.now()
    });
    console.log("Inserted chunk ID:", newChunkId);

    // 6) Fetch the document or chunk by ID
    const fetchedDoc = await vectorStore.getItemMetadataById(newDocId);
    const fetchedChunk = await vectorStore.getEmbeddingById(newChunkId);
    console.log("Fetched doc:", fetchedDoc);
    console.log("Fetched chunk:", fetchedChunk);

    // 7) Similarity search for documents
    const queryEmbedding = new Float32Array([0.15, 0.25, 0.35, 0.45]);
    const similarDocs = await vectorStore.findSimilarItems(queryEmbedding, 3);
    console.log("Top 3 similar docs:", similarDocs);

})();
*/
