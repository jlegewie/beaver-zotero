/**
* Current schema version for migrations.
*/
const CURRENT_SCHEMA_VERSION = 1;

/**
* Document-level interface (matches 'documents' table)
*/
export interface DocumentTable {
    id: number;               // primary key
    item_id: number;          // Zotero attachment/item ID
    parent_id: number | null; // optional parent
    status: string;
    summary: string;
    embedding: Float32Array;  // stored in DB as BLOB, typed as Float16Array in memory
    embedding_model: string;
    timestamp: number;        // store as a numeric Unix timestamp
}

/**
* Chunk-level interface (matches 'chunks' table)
*/
export interface ChunkTable {
    id: number;               // primary key
    document_id: number;      // references DocumentTable.id
    content: string;
    page_no: number | null;
    embedding: Float32Array;  // stored as BLOB in DB
    embedding_model: string;
    timestamp: number;
}

/**
* This class manages an SQLite-based vector store using
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
    * Migration 1: Create the 'documents' and 'chunks' tables.
    */
    private async runMigration1() {
        // Documents table
        await this.db.queryAsync(`
            CREATE TABLE IF NOT EXISTS documents (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id         INTEGER NOT NULL,
                parent_id       INTEGER,
                status          TEXT,
                summary         TEXT,
                embedding       BLOB,
                embedding_model TEXT,
                timestamp       INTEGER
            );
        `);
                
        // Chunks table
        await this.db.queryAsync(`
            CREATE TABLE IF NOT EXISTS chunks (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id     INTEGER NOT NULL,
                content         TEXT,
                page_no         INTEGER,
                embedding       BLOB,
                embedding_model TEXT,
                timestamp       INTEGER
            );
        `);
    }
    
    /**
    * Insert a document record into the 'documents' table.
    * @param doc Partial document data (without 'id')
    * @returns The new 'id' (primary key) of the inserted document
    */
    public async insertDocument(doc: Omit<DocumentTable, "id">): Promise<number> {
        // Convert doc.embedding (Float16Array) to a BLOB
        const blob = this.float32ToBlob(doc.embedding);
        
        // Insert
        await this.db.queryAsync(
            `INSERT INTO documents (item_id, parent_id, status, summary, embedding, embedding_model, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                doc.item_id,
                doc.parent_id,
                doc.status,
                doc.summary,
                blob,
                doc.embedding_model,
                doc.timestamp
            ]
        );
        
        // Retrieve new row ID
        const newId = await this.db.valueQueryAsync("SELECT last_insert_rowid()");
        return Number(newId);
    }
    
    /**
    * Insert a chunk record into the 'chunks' table.
    * @param chunk Partial chunk data (without 'id')
    * @returns The new 'id' (primary key) of the inserted chunk
    */
    public async insertChunk(chunk: Omit<ChunkTable, "id">): Promise<number> {
        // Convert chunk.embedding (Float16Array) to BLOB
        const blob = this.float32ToBlob(chunk.embedding);
        
        // Insert
        await this.db.queryAsync(
            `INSERT INTO chunks (document_id, content, page_no, embedding, embedding_model, timestamp)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            [
                chunk.document_id,
                chunk.content,
                chunk.page_no,
                blob,
                chunk.embedding_model,
                chunk.timestamp
            ]
        );
        
        // Retrieve new row ID
        const newId = await this.db.valueQueryAsync("SELECT last_insert_rowid()");
        return Number(newId);
    }
    
    /**
    * Retrieve a document by ID.
    * @param id Document table primary key
    */
    public async getDocumentById(id: number): Promise<DocumentTable | null> {
        const rows = await this.db.queryAsync(
            `SELECT * FROM documents WHERE id=?1`,
            [id]
        );
        if (rows.length === 0) {
            return null;
        }
        
        const row = rows[0];
        // Convert the BLOB back into Float16Array
        const embeddingBlob = row.embedding; // typically a Uint8Array
        const embedding = this.blobToFloat32(embeddingBlob);
        
        return {
            id: row.id,
            item_id: row.item_id,
            parent_id: row.parent_id,
            status: row.status,
            summary: row.summary,
            embedding: embedding,
            embedding_model: row.embedding_model,
            timestamp: row.timestamp
        };
    }
    
    /**
    * Retrieve a chunk by ID.
    * @param id Chunks table primary key
    */
    public async getChunkById(id: number): Promise<ChunkTable | null> {
        const rows = await this.db.queryAsync(
            `SELECT * FROM chunks WHERE id=?1`,
            [id]
        );
        if (rows.length === 0) {
            return null;
        }
        
        const row = rows[0];
        // Convert BLOB back to Float16Array
        const embeddingBlob = row.embedding;
        const embedding = this.blobToFloat32(embeddingBlob);
        
        return {
            id: row.id,
            document_id: row.document_id,
            content: row.content,
            page_no: row.page_no,
            embedding: embedding,
            embedding_model: row.embedding_model,
            timestamp: row.timestamp
        };
    }
    
    /**
    * Optional: an update method if you need to change an existing document or chunk.
    * Example for documents:
    */
    public async updateDocument(doc: DocumentTable): Promise<void> {
        const blob = this.float32ToBlob(doc.embedding);
        await this.db.queryAsync(`
            UPDATE documents
            SET item_id=?1,
                parent_id=?2,
                status=?3,
                summary=?4,
                embedding=?5,
                embedding_model=?6,
                timestamp=?7
            WHERE id=?8`,
            [
                doc.item_id,
                doc.parent_id,
                doc.status,
                doc.summary,
                blob,
                doc.embedding_model,
                doc.timestamp,
                doc.id
            ]
        );
    }
                
    /**
    * Delete methods
    */
    public async deleteDocument(id: number): Promise<void> {
        await this.db.queryAsync(
            `DELETE FROM documents WHERE id=?1`,
            [id]
        );
        await this.db.queryAsync(
            `DELETE FROM chunks WHERE document_id=?1`,
            [id]
        );
    }
    
    public async deleteChunk(id: number): Promise<void> {
        await this.db.queryAsync(
            `DELETE FROM chunks WHERE id=?1`,
            [id]
        );
    }

    /**
    * Similarity search for documents to a given embedding.
    * 
    * Search is done in memory by:
    * 1) Retrieving embeddings from DB
    * 2) Computing cosine distance (or 1 - similarity)
    * 
    * @param queryEmbedding The query embedding (Float16Array)
    * @param limit Max results to return
    * @returns Array of DocumentTable, sorted by ascending distance
    */
    public async findSimilarDocuments(
        queryEmbedding: Float32Array,
        limit = 5
    ): Promise<DocumentTable[]> {
        // 1) Load all documents
        const rows = await this.db.queryAsync(`SELECT * FROM documents`);
        
        // 2) Calculate distances
        const results: Array<{ doc: DocumentTable; distance: number }> = [];
        
        for (const row of rows) {
            const embedding = this.blobToFloat32(row.embedding);
            const distance = this.cosineDistance(queryEmbedding, embedding);
            results.push({
                doc: {
                    id: row.id,
                    item_id: row.item_id,
                    parent_id: row.parent_id,
                    status: row.status,
                    summary: row.summary,
                    embedding: embedding,
                    embedding_model: row.embedding_model,
                    timestamp: row.timestamp
                },
                distance,
            });
        }
        
        // 3) Sort by ascending distance (lowest distance = most similar)
        results.sort((a, b) => a.distance - b.distance);
        
        // 4) Take top N
        return results.slice(0, limit).map(item => item.doc);
    }
    
    /**
    * Find similar chunks to a given embedding.
    * @param queryEmbedding The query embedding (Float16Array)
    * @param limit Max results
    * @returns Array of ChunkTable, sorted by ascending distance
    */
    public async findSimilarChunks(
        queryEmbedding: Float32Array,
        limit = 5
    ): Promise<ChunkTable[]> {
        // 1) Load all chunks
        const rows = await this.db.queryAsync(`SELECT * FROM chunks`);
        
        // 2) Calculate distances
        const results: Array<{ chunk: ChunkTable; distance: number }> = [];
        
        for (const row of rows) {
            const embedding = this.blobToFloat32(row.embedding);
            const distance = this.cosineDistance(queryEmbedding, embedding);
            results.push({
                chunk: {
                    id: row.id,
                    document_id: row.document_id,
                    content: row.content,
                    page_no: row.page_no,
                    embedding: embedding,
                    embedding_model: row.embedding_model,
                    timestamp: row.timestamp
                },
                distance,
            });
        }
        
        // 3) Sort by ascending distance
        results.sort((a, b) => a.distance - b.distance);
        
        // 4) Return top N
        return results.slice(0, limit).map(item => item.chunk);
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
    const docEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const newDocId = await vectorStore.insertDocument({
        item_id: 1234,
        parent_id: null,
        status: "ready",
        summary: "This is a test document",
        embedding: docEmbedding,
        embedding_model: "modelA",
        timestamp: Date.now()
    });
    console.log("Inserted document ID:", newDocId);

    // 5) Insert a chunk
    const chunkEmbedding = new Float32Array([0.5, 0.6, 0.7, 0.8]);
    const newChunkId = await vectorStore.insertChunk({
        document_id: newDocId,
        content: "Chunk content goes here...",
        page_no: 1,
        embedding: chunkEmbedding,
        embedding_model: "modelA",
        timestamp: Date.now()
    });
    console.log("Inserted chunk ID:", newChunkId);

    // 6) Fetch the document or chunk by ID
    const fetchedDoc = await vectorStore.getDocumentById(newDocId);
    const fetchedChunk = await vectorStore.getChunkById(newChunkId);
    console.log("Fetched doc:", fetchedDoc);
    console.log("Fetched chunk:", fetchedChunk);

    // 7) Similarity search for documents
    const queryEmbedding = new Float32Array([0.15, 0.25, 0.35, 0.45]);
    const similarDocs = await vectorStore.findSimilarDocuments(queryEmbedding, 3);
    console.log("Top 3 similar docs:", similarDocs);

    // 8) Similarity search for chunks
    const similarChunks = await vectorStore.findSimilarChunks(queryEmbedding, 3);
    console.log("Top 3 similar chunks:", similarChunks);

})();
*/
