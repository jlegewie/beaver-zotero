import { v4 as uuidv4 } from 'uuid';
import { ThreadData } from '../../react/atoms/threads';
import { getPref } from '../utils/prefs';
import { SyncMethod, SyncType } from '../../react/atoms/sync';


/* 
 * Interface for the 'embeddings' table row
 * 
 * Table stores paper embeddings for semantic search.
 * Embeddings are generated from title + abstract text.
 */
export interface EmbeddingRecord {
    item_id: number;                    // Zotero item ID
    library_id: number;                 // Zotero library ID
    zotero_key: string;                 // Zotero item key
    version: number;                    // Zotero item version at embedding time
    client_date_modified: string;       // Item's clientDateModified at embedding time
    content_hash: string;               // Hash of title+abstract for change detection
    embedding: Uint8Array;              // Int8 embedding stored as BLOB
    dimensions: number;                 // Embedding dimensions (256 or 512)
    model_id: string;                   // Model identifier (e.g., "voyage-3-int8-512")
    indexed_at: string;                 // When the embedding was created
}

/**
 * Interface for the 'embedding_index_state' table row
 * 
 * Tracks the state of the embedding index for each library.
 * Used to optimize startup by skipping full diff when nothing changed.
 */
export interface EmbeddingIndexStateRecord {
    library_id: number;                  // Zotero library ID
    last_scan_timestamp: string;         // When we last ran a full scan (ISO string)
    max_client_date_modified: string;    // MAX(clientDateModified) from Zotero at last scan
    item_count: number;                  // Count of regular items in Zotero at last scan
    embedding_count: number;             // Count of embeddings at last scan
}

/**
 * Interface for the 'failed_embeddings' table row
 * 
 * Tracks items that failed to embed, with retry backoff logic.
 * Items are retried with exponential backoff based on failure_count.
 */
export interface FailedEmbeddingRecord {
    item_id: number;                     // Zotero item ID
    library_id: number;                  // Zotero library ID
    failure_count: number;               // Number of consecutive failures
    last_error: string;                  // Last error message
    last_attempt: string;                // When the last attempt was made (ISO string)
    next_retry_after: string;            // Don't retry before this time (ISO string)
}

/**
 * Maximum number of failures before an item is considered permanently failed.
 * After this many failures, the item won't be retried automatically.
 */
export const MAX_EMBEDDING_FAILURES = 5;

/**
 * Base delay for retry backoff in milliseconds.
 * Actual delay = BASE_DELAY * 2^(failure_count - 1)
 * So delays are: 1h, 2h, 4h, 8h, 16h
 */
export const EMBEDDING_RETRY_BASE_DELAY_MS = 60 * 60 * 1000; // 1 hour


/* 
 * Interface for the 'threads' table row
 * 
 * Table stores chat threads, mirroring the backend postgres structure.
 * Corresponds to the ThreadModel and threads table in the backend.
 * 
 */
export interface ThreadRecord {
    id: string;
    user_id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
}

/* 
 * Interface for the 'sync_logs' table row
 *
 * Table stores the sync logs for each sync session.
 */
export interface SyncLogsRecord {
    id: string; // Primary key
    session_id: string;
    user_id: string;
    sync_type: SyncType;
    method: SyncMethod;
    zotero_local_id: string;
    zotero_user_id?: string | null;
    library_id: number;
    total_upserts: number;
    total_deletions: number;
    library_version: number;
    library_date_modified: string;
    timestamp: string;
}

/**
 * Manages the beaver SQLite database using Zotero's DBConnection.
 */
export class BeaverDB {
    private conn: any; // Instance of Zotero.DBConnection

    /**
     * @param dbConnection An initialized Zotero.DBConnection instance for 'beaver'.
     */
    constructor(dbConnection: any) {
        if (!dbConnection) {
            throw new Error("BeaverDB requires a valid Zotero.DBConnection instance.");
        }
        this.conn = dbConnection;
    }

    /**
     * Initialize the database by creating tables if they don't exist.
     * Should be called once after constructing the class.
     */
    public async initDatabase(pluginVersion: string): Promise<void> {
        const previousVersion = getPref('installedVersion') || '0.1';

        // Delete all tables in test versions
        if (previousVersion.startsWith('0.1') || previousVersion == '0.2.4') {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS items`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS attachments`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS upload_queue`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS threads`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS messages`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS library_sync_state`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS sync_logs`);
        }

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS threads (
                id                       TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                name                     TEXT,
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS messages (
                id                       TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                thread_id                TEXT(36) NOT NULL,
                role                     TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                content                  TEXT,
                reasoning_content        TEXT,
                tool_calls               TEXT,
                reader_state             TEXT,
                attachments              TEXT,
                tool_request             TEXT,
                status                   TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'canceled', 'error')),
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                metadata                 TEXT,
                error                    TEXT,
                FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS sync_logs (
                id                       TEXT(36) PRIMARY KEY,
                session_id               TEXT(36) NOT NULL,
                user_id                  TEXT(36) NOT NULL,
                sync_type                TEXT NOT NULL,
                method                   TEXT NOT NULL,
                zotero_local_id          TEXT NOT NULL,
                zotero_user_id           TEXT,
                library_id               INTEGER NOT NULL,
                total_upserts            INTEGER NOT NULL DEFAULT 0,
                total_deletions          INTEGER NOT NULL DEFAULT 0,
                library_version          INTEGER NOT NULL,
                library_date_modified    TEXT NOT NULL,
                timestamp                TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS embeddings (
                item_id                  INTEGER NOT NULL,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                version                  INTEGER NOT NULL,
                client_date_modified     TEXT NOT NULL,
                content_hash             TEXT NOT NULL,
                embedding                BLOB NOT NULL,
                dimensions               INTEGER NOT NULL,
                model_id                 TEXT NOT NULL,
                indexed_at               TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (item_id)
            );
        `);

        // Table for tracking embedding index state per library
        // Used to optimize startup by skipping full diff when nothing changed
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS embedding_index_state (
                library_id               INTEGER PRIMARY KEY,
                last_scan_timestamp      TEXT NOT NULL,
                max_client_date_modified TEXT NOT NULL,
                item_count               INTEGER NOT NULL,
                embedding_count          INTEGER NOT NULL
            );
        `);

        // Table for tracking failed embedding attempts
        // Items are retried with exponential backoff
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS failed_embeddings (
                item_id                  INTEGER PRIMARY KEY,
                library_id               INTEGER NOT NULL,
                failure_count            INTEGER NOT NULL DEFAULT 1,
                last_error               TEXT NOT NULL,
                last_attempt             TEXT NOT NULL DEFAULT (datetime('now')),
                next_retry_after         TEXT NOT NULL
            );
        `);

        // DB indexes
        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_thread
            ON messages(user_id, thread_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_threads_user_updated
            ON threads(user_id, updated_at DESC);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_thread_created
            ON messages(user_id, thread_id, created_at);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_user_library
            ON sync_logs(user_id, library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_user_library_version
            ON sync_logs(user_id, library_id, library_version DESC);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_user_library_date
            ON sync_logs(user_id, library_id, library_date_modified DESC);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_session
            ON sync_logs(session_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_embeddings_library
            ON embeddings(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash
            ON embeddings(content_hash);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_embeddings_zotero_key
            ON embeddings(zotero_key);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_failed_embeddings_library
            ON failed_embeddings(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_failed_embeddings_retry
            ON failed_embeddings(next_retry_after);
        `);
    }

    /**
     * Close the database connection.
     */
    public async closeDatabase(): Promise<void> {
        await this.conn.closeDatabase();
    }

    /**
     * Helper method to construct ThreadRecord from a database row
     */
    private static rowToThreadRecord(row: any): ThreadRecord {
        return {
            id: row.id,
            user_id: row.user_id,
            name: row.name,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    /**
     * Convert ThreadRecord to ThreadData (application-facing format)
     */
    private static threadRecordToData(record: ThreadRecord): ThreadData {
        return {
            id: record.id,
            name: record.name || '', // Convert null to empty string
            createdAt: record.created_at,
            updatedAt: record.updated_at,
        };
    }

    /**
     * Convert ThreadData to ThreadRecord format (for database operations)
     */
    private static threadDataToRecord(data: Partial<ThreadData>): Partial<ThreadRecord> {
        const record: Partial<ThreadRecord> = {};
        
        if (data.id !== undefined) record.id = data.id;
        if (data.name !== undefined) record.name = data.name || null; // Convert empty string to null for database
        if (data.createdAt !== undefined) record.created_at = data.createdAt;
        if (data.updatedAt !== undefined) record.updated_at = data.updatedAt;
        
        return record;
    }

    /**
     * Helper method to construct SyncLogsRecord from a database row
     */
    private static rowToSyncLogsRecord(row: any): SyncLogsRecord {
        return {
            id: row.id,
            session_id: row.session_id,
            user_id: row.user_id,
            sync_type: row.sync_type as SyncType,
            method: row.method as SyncMethod,
            zotero_local_id: row.zotero_local_id,
            zotero_user_id: row.zotero_user_id,
            library_id: row.library_id,
            total_upserts: row.total_upserts,
            total_deletions: row.total_deletions,
            library_version: row.library_version,
            library_date_modified: row.library_date_modified,
            timestamp: row.timestamp,
        };
    }

    // --- Thread Methods ---

    /**
     * Create a new chat thread.
     * @param user_id The user_id of the thread
     * @param name Optional name for the thread
     * @returns The complete ThreadData for the newly created thread
     */
    public async createThread(user_id: string, name: string = ''): Promise<ThreadData> {
        const id = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const dbName = name || null; // Convert empty string to null for database
        
        await this.conn.queryAsync(
            `INSERT INTO threads (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [id, user_id, dbName, now, now]
        );
        
        return {
            id,
            name,
            createdAt: now,
            updatedAt: now,
        };
    }

    /**
     * Retrieve a thread by its ID.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to retrieve
     * @returns The ThreadData if found, otherwise null
     */
    public async getThread(user_id: string, id: string): Promise<ThreadData | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads WHERE user_id = ? AND id = ?`,
            [user_id, id]
        );
        if (rows.length === 0) {
            return null;
        }
        const record = BeaverDB.rowToThreadRecord(rows[0]);
        return BeaverDB.threadRecordToData(record);
    }

    /**
     * Get a paginated list of threads.
     * @param user_id The user_id of the threads
     * @param limit Number of threads per page
     * @param offset Number of threads to skip
     * @returns Object containing an array of ThreadData objects and a boolean indicating if there are more items
     */
    public async getThreadsPaginated(
        user_id: string,
        limit: number,
        offset: number
    ): Promise<{ threads: ThreadData[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
            [user_id, limit + 1, offset]
        );

        const threads = rows
            .slice(0, limit)
            .map((row: any) => {
                const record = BeaverDB.rowToThreadRecord(row);
                return BeaverDB.threadRecordToData(record);
            });

        return {
            threads,
            has_more: rows.length > limit,
        };
    }

    /**
     * Delete a thread and all its messages.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to delete
     */
    public async deleteThread(user_id: string, id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM threads WHERE user_id = ? AND id = ?`,
            [user_id, id]
        );
    }

    /**
     * Rename a thread.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to rename
     * @param name The new name for the thread
     */
    public async renameThread(user_id: string, id: string, name: string): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE threads SET name = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?`,
            [name, user_id, id]
        );
    }

    /**
     * Update a thread. Currently only supports renaming.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to update
     * @param updates An object containing the fields to update (using ThreadData format)
     */
    public async updateThread(
        user_id: string,
        id: string,
        updates: Partial<Omit<ThreadData, 'id' | 'createdAt'>>
    ): Promise<void> {
        const fieldsToUpdate: string[] = [];
        const values: any[] = [];

        if (updates.name !== undefined) {
            fieldsToUpdate.push('name = ?');
            values.push(updates.name || null); // Convert empty string to null for database
        }

        if (updates.updatedAt !== undefined) {
            fieldsToUpdate.push('updated_at = ?');
            values.push(updates.updatedAt);
        } else if (fieldsToUpdate.length > 0) {
            // Auto-update updated_at if we're making other changes
            fieldsToUpdate.push('updated_at = datetime(\'now\')');
        }

        if (fieldsToUpdate.length === 0) {
            return; // Nothing to update
        }

        values.push(user_id, id);
        
        await this.conn.queryAsync(
            `UPDATE threads SET ${fieldsToUpdate.join(', ')} WHERE user_id = ? AND id = ?`,
            values
        );
    }

    // --- Sync Logs Methods ---

    /**
     * Insert a new sync log record.
     * @param syncLog The sync log data to insert (without id, which will be generated)
     * @returns The complete SyncLogsRecord with generated id
     */
    public async insertSyncLog(syncLog: Omit<SyncLogsRecord, 'id' | 'timestamp'>): Promise<SyncLogsRecord> {
        // Validate required fields
        const requiredFields = ['session_id', 'user_id', 'sync_type', 'method', 'zotero_local_id', 'library_id', 'library_version', 'library_date_modified'] as const;
        for (const field of requiredFields) {
            if (syncLog[field] === undefined || syncLog[field] === null) {
                throw new Error(`insertSyncLog: Required field '${field}' is ${syncLog[field]}. Full syncLog: ${JSON.stringify(syncLog)}`);
            }
        }
        
        const id = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        await this.conn.queryAsync(
            `INSERT INTO sync_logs (id, session_id, user_id, sync_type, method, zotero_local_id, zotero_user_id, library_id, total_upserts, total_deletions, library_version, library_date_modified, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                syncLog.session_id,
                syncLog.user_id,
                syncLog.sync_type,
                syncLog.method,
                syncLog.zotero_local_id,
                syncLog.zotero_user_id ?? null,
                syncLog.library_id,
                syncLog.total_upserts,
                syncLog.total_deletions,
                syncLog.library_version,
                syncLog.library_date_modified,
                now
            ]
        );
        
        return {
            id,
            ...syncLog,
            timestamp: now,
        };
    }

    /**
     * Get sync log record for library_id and user_id with the highest library_version.
     * @param user_id The user_id to filter by
     * @param library_id The library_id to filter by
     * @returns The SyncLogsRecord with highest library_version, or null if not found
     */
    public async getSyncLogWithHighestVersion(user_id: string, library_id: number): Promise<SyncLogsRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs 
             WHERE user_id = ? AND library_id = ? 
             ORDER BY library_version DESC 
             LIMIT 1`,
            [user_id, library_id]
        );
        
        if (rows.length === 0) {
            return null;
        }
        
        return BeaverDB.rowToSyncLogsRecord(rows[0]);
    }

    /**
     * Get sync log record for library_id and user_id with the most recent library_date_modified.
     * @param user_id The user_id to filter by
     * @param library_id The library_id to filter by
     * @returns The SyncLogsRecord with most recent library_date_modified, or null if not found
     */
    public async getSyncLogWithMostRecentDate(user_id: string, library_id: number): Promise<SyncLogsRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs 
             WHERE user_id = ? AND library_id = ? 
             ORDER BY library_date_modified DESC 
             LIMIT 1`,
            [user_id, library_id]
        );
        
        if (rows.length === 0) {
            return null;
        }
        
        return BeaverDB.rowToSyncLogsRecord(rows[0]);
    }

    /**
     * Get all sync log records for specific library_id and user_id.
     * @param user_id The user_id to filter by
     * @param library_id The library_id to filter by
     * @param orderBy Optional ordering field ('timestamp', 'library_version', 'library_date_modified')
     * @param orderDirection Optional order direction ('ASC' or 'DESC')
     * @returns Array of SyncLogsRecord objects
     */
    public async getAllSyncLogsForLibrary(
        user_id: string, 
        library_id: number,
        orderBy: 'timestamp' | 'library_version' | 'library_date_modified' = 'timestamp',
        orderDirection: 'ASC' | 'DESC' = 'DESC'
    ): Promise<SyncLogsRecord[]> {
        const validOrderBy = ['timestamp', 'library_version', 'library_date_modified'];
        const validDirection = ['ASC', 'DESC'];
        
        if (!validOrderBy.includes(orderBy)) {
            throw new Error(`Invalid orderBy field: ${orderBy}`);
        }
        
        if (!validDirection.includes(orderDirection)) {
            throw new Error(`Invalid order direction: ${orderDirection}`);
        }
        
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs 
             WHERE user_id = ? AND library_id = ? 
             ORDER BY ${orderBy} ${orderDirection}`,
            [user_id, library_id]
        );
        
        return rows.map((row: any) => BeaverDB.rowToSyncLogsRecord(row));
    }

    public async getMostRecentSyncLogForLibraries(user_id: string, library_ids: number[]): Promise<SyncLogsRecord | null> {
        if (!library_ids || library_ids.length === 0) return null;

        const placeholders = library_ids.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs
             WHERE user_id = ? AND library_id IN (${placeholders})
             ORDER BY timestamp DESC
             LIMIT 1`,
            [user_id, ...library_ids]
        );

        if (rows.length === 0) {
            return null;
        }
        return BeaverDB.rowToSyncLogsRecord(rows[0]);
    }

    /**
     * Deletes all sync log records for a specific library.
     * @param user_id The user_id to filter by
     * @param library_ids The library_ids to delete logs for
     */
    public async deleteSyncLogsForLibraryIds(user_id: string, library_ids: number[]): Promise<void> {
        if (library_ids.length === 0) {
            return;
        }

        const placeholders = library_ids.map(() => '?').join(',');
        await this.conn.queryAsync(
            `DELETE FROM sync_logs WHERE user_id = ? AND library_id IN (${placeholders})`,
            [user_id, ...library_ids]
        );
    }

    /**
     * Deletes all sync log records for a user.
     * Used during onboarding to ensure fresh sync state (e.g., after plan transitions).
     * @param user_id The user_id to delete logs for
     */
    public async deleteAllSyncLogsForUser(user_id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM sync_logs WHERE user_id = ?`,
            [user_id]
        );
    }

    // --- Embedding Methods ---

    /**
     * Helper method to construct EmbeddingRecord from a database row
     */
    private static rowToEmbeddingRecord(row: any): EmbeddingRecord {
        return {
            item_id: row.item_id,
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            version: row.version,
            client_date_modified: row.client_date_modified,
            content_hash: row.content_hash,
            embedding: new Uint8Array(row.embedding),
            dimensions: row.dimensions,
            model_id: row.model_id,
            indexed_at: row.indexed_at,
        };
    }

    /**
     * Convert Int8Array embedding to Uint8Array for BLOB storage.
     * SQLite stores BLOBs as raw bytes; Int8Array and Uint8Array share the same buffer layout.
     */
    public static embeddingToBlob(embedding: Int8Array): Uint8Array {
        return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    }

    /**
     * Convert BLOB (Uint8Array) back to Int8Array for similarity computation.
     */
    public static blobToEmbedding(blob: Uint8Array): Int8Array {
        return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    }

    /**
     * Compute a hash for content change detection.
     * Uses a simple but fast DJB2-style hash suitable for detecting text changes.
     * @param text The text content to hash (title + abstract)
     * @returns Hash string
     */
    public static computeContentHash(text: string): string {
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            const char = text.charCodeAt(i);
            hash = ((hash << 5) + hash) ^ char;
        }
        // Convert to unsigned 32-bit and then to base36 for compact representation
        return (hash >>> 0).toString(36);
    }

    /**
     * Insert or update an embedding record.
     * @param embedding The embedding data to store
     */
    public async upsertEmbedding(embedding: Omit<EmbeddingRecord, 'indexed_at'> & { indexed_at?: string }): Promise<void> {
        const now = embedding.indexed_at || new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        await this.conn.queryAsync(
            `INSERT OR REPLACE INTO embeddings 
             (item_id, library_id, zotero_key, version, client_date_modified, 
              content_hash, embedding, dimensions, model_id, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                embedding.item_id,
                embedding.library_id,
                embedding.zotero_key,
                embedding.version,
                embedding.client_date_modified,
                embedding.content_hash,
                embedding.embedding,
                embedding.dimensions,
                embedding.model_id,
                now
            ]
        );
    }

    /**
     * Insert or update multiple embedding records in a batch.
     * @param embeddings Array of embedding data to store
     */
    public async upsertEmbeddingsBatch(embeddings: Array<Omit<EmbeddingRecord, 'indexed_at'> & { indexed_at?: string }>): Promise<void> {
        if (embeddings.length === 0) return;

        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

        // Use a transaction for batch insert
        await this.conn.executeTransaction(async () => {
            for (const embedding of embeddings) {
                const indexedAt = embedding.indexed_at || now;
                await this.conn.queryAsync(
                    `INSERT OR REPLACE INTO embeddings 
                     (item_id, library_id, zotero_key, version, client_date_modified, 
                      content_hash, embedding, dimensions, model_id, indexed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        embedding.item_id,
                        embedding.library_id,
                        embedding.zotero_key,
                        embedding.version,
                        embedding.client_date_modified,
                        embedding.content_hash,
                        embedding.embedding,
                        embedding.dimensions,
                        embedding.model_id,
                        indexedAt
                    ]
                );
            }
        });
    }

    /**
     * Get an embedding record by item ID.
     * @param itemId The Zotero item ID
     * @returns The embedding record or null if not found
     */
    public async getEmbedding(itemId: number): Promise<EmbeddingRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings WHERE item_id = ?`,
            [itemId]
        );
        
        if (rows.length === 0) {
            return null;
        }
        
        return BeaverDB.rowToEmbeddingRecord(rows[0]);
    }

    /**
     * Get embedding records for multiple item IDs.
     * @param itemIds Array of Zotero item IDs
     * @returns Map of item ID to embedding record
     */
    public async getEmbeddingsBatch(itemIds: number[]): Promise<Map<number, EmbeddingRecord>> {
        if (itemIds.length === 0) return new Map();

        const result = new Map<number, EmbeddingRecord>();
        const chunkSize = 500;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            
            const rows = await this.conn.queryAsync(
                `SELECT * FROM embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
            
            for (const row of rows) {
                result.set(row.item_id, BeaverDB.rowToEmbeddingRecord(row));
            }
        }

        return result;
    }

    /**
     * Get all embeddings for a library.
     * @param libraryId The Zotero library ID
     * @returns Array of embedding records
     */
    public async getEmbeddingsByLibrary(libraryId: number): Promise<EmbeddingRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings WHERE library_id = ?`,
            [libraryId]
        );
        
        return rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row));
    }

    /**
     * Get all embeddings across all libraries.
     * @returns Array of embedding records
     */
    public async getAllEmbeddings(): Promise<EmbeddingRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings ORDER BY library_id, item_id`
        );
        
        return rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row));
    }

    /**
     * Get embeddings for multiple libraries.
     * @param libraryIds Array of library IDs
     * @returns Array of embedding records
     */
    public async getEmbeddingsByLibraries(libraryIds: number[]): Promise<EmbeddingRecord[]> {
        if (libraryIds.length === 0) return [];

        const placeholders = libraryIds.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings WHERE library_id IN (${placeholders})`,
            libraryIds
        );
        
        return rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row));
    }

    /**
     * Get content hashes for items to check what needs re-indexing.
     * @param itemIds Array of Zotero item IDs
     * @returns Map of item ID to content hash
     */
    public async getContentHashes(itemIds: number[]): Promise<Map<number, string>> {
        if (itemIds.length === 0) return new Map();

        const result = new Map<number, string>();
        const chunkSize = 500;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            
            const rows = await this.conn.queryAsync(
                `SELECT item_id, content_hash FROM embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
            
            for (const row of rows) {
                result.set(row.item_id, row.content_hash);
            }
        }

        return result;
    }

    /**
     * Delete an embedding by item ID.
     * @param itemId The Zotero item ID
     */
    public async deleteEmbedding(itemId: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM embeddings WHERE item_id = ?`,
            [itemId]
        );
    }

    /**
     * Delete embeddings for multiple item IDs.
     * @param itemIds Array of Zotero item IDs
     */
    public async deleteEmbeddingsBatch(itemIds: number[]): Promise<void> {
        if (itemIds.length === 0) return;

        const chunkSize = 500;
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            await this.conn.queryAsync(
                `DELETE FROM embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
        }
    }

    /**
     * Delete all embeddings for a library.
     * @param libraryId The Zotero library ID
     */
    public async deleteEmbeddingsByLibrary(libraryId: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM embeddings WHERE library_id = ?`,
            [libraryId]
        );
    }

    /**
     * Get the count of embeddings for a library.
     * @param libraryId The Zotero library ID
     * @returns Number of embeddings
     */
    public async getEmbeddingCount(libraryId?: number): Promise<number> {
        let sql = 'SELECT COUNT(*) as count FROM embeddings';
        const params: any[] = [];

        if (libraryId !== undefined) {
            sql += ' WHERE library_id = ?';
            params.push(libraryId);
        }

        const rows = await this.conn.queryAsync(sql, params);
        return rows[0]?.count || 0;
    }

    /**
     * Get item IDs that have embeddings in a library.
     * @param libraryId The Zotero library ID
     * @returns Array of item IDs
     */
    public async getEmbeddedItemIds(libraryId?: number): Promise<number[]> {
        let sql = 'SELECT item_id FROM embeddings';
        const params: any[] = [];

        if (libraryId !== undefined) {
            sql += ' WHERE library_id = ?';
            params.push(libraryId);
        }

        const rows = await this.conn.queryAsync(sql, params);
        return rows.map((row: any) => row.item_id);
    }

    /**
     * Get distinct library IDs that have embeddings.
     * Used to find libraries that may need cleanup when sync settings change.
     * @returns Array of library IDs
     */
    public async getEmbeddedLibraryIds(): Promise<number[]> {
        const rows = await this.conn.queryAsync(
            'SELECT DISTINCT library_id FROM embeddings'
        );
        return rows.map((row: any) => row.library_id);
    }

    /**
     * Get all content hashes for embeddings, optionally filtered by library.
     * More efficient than getContentHashes for full-database scans.
     * @param libraryId Optional library ID to filter by
     * @returns Map of item ID to content hash
     */
    public async getEmbeddingContentHashMap(libraryId?: number): Promise<Map<number, string>> {
        let sql = 'SELECT item_id, content_hash FROM embeddings';
        const params: any[] = [];

        if (libraryId !== undefined) {
            sql += ' WHERE library_id = ?';
            params.push(libraryId);
        }

        const rows = await this.conn.queryAsync(sql, params);
        const result = new Map<number, string>();
        
        for (const row of rows) {
            result.set(row.item_id, row.content_hash);
        }

        return result;
    }

    // =============================================
    // Embedding Index State Methods
    // =============================================

    /**
     * Get the embedding index state for a library.
     * @param libraryId The Zotero library ID
     * @returns The state record or null if not found
     */
    public async getEmbeddingIndexState(libraryId: number): Promise<EmbeddingIndexStateRecord | null> {
        const sql = 'SELECT * FROM embedding_index_state WHERE library_id = ?';
        const rows = await this.conn.queryAsync(sql, [libraryId]);
        
        if (rows.length === 0) return null;
        
        const row = rows[0];
        return {
            library_id: row.library_id,
            last_scan_timestamp: row.last_scan_timestamp,
            max_client_date_modified: row.max_client_date_modified,
            item_count: row.item_count,
            embedding_count: row.embedding_count,
        };
    }

    /**
     * Update the embedding index state for a library.
     * @param state The state to save
     */
    public async upsertEmbeddingIndexState(state: EmbeddingIndexStateRecord): Promise<void> {
        const sql = `
            INSERT INTO embedding_index_state 
                (library_id, last_scan_timestamp, max_client_date_modified, item_count, embedding_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(library_id) DO UPDATE SET
                last_scan_timestamp = excluded.last_scan_timestamp,
                max_client_date_modified = excluded.max_client_date_modified,
                item_count = excluded.item_count,
                embedding_count = excluded.embedding_count
        `;
        
        await this.conn.queryAsync(sql, [
            state.library_id,
            state.last_scan_timestamp,
            state.max_client_date_modified,
            state.item_count,
            state.embedding_count,
        ]);
    }

    /**
     * Delete the embedding index state for a library.
     * @param libraryId The Zotero library ID
     */
    public async deleteEmbeddingIndexState(libraryId: number): Promise<void> {
        await this.conn.queryAsync(
            'DELETE FROM embedding_index_state WHERE library_id = ?',
            [libraryId]
        );
    }

    /**
     * Get MAX(client_date_modified) from embeddings for a library.
     * @param libraryId The Zotero library ID
     * @returns The max date or null if no embeddings exist
     */
    public async getEmbeddingsMaxClientDateModified(libraryId: number): Promise<string | null> {
        const sql = 'SELECT MAX(client_date_modified) as max_date FROM embeddings WHERE library_id = ?';
        const rows = await this.conn.queryAsync(sql, [libraryId]);
        return rows[0]?.max_date || null;
    }

    // =============================================
    // Failed Embeddings Methods
    // =============================================

    /**
     * Helper method to construct FailedEmbeddingRecord from a database row
     */
    private static rowToFailedEmbeddingRecord(row: any): FailedEmbeddingRecord {
        return {
            item_id: row.item_id,
            library_id: row.library_id,
            failure_count: row.failure_count,
            last_error: row.last_error,
            last_attempt: row.last_attempt,
            next_retry_after: row.next_retry_after,
        };
    }

    /**
     * Calculate the next retry time based on failure count.
     * Uses exponential backoff: 1h, 2h, 4h, 8h, 16h
     * @param failureCount Number of consecutive failures
     * @returns ISO string of next retry time
     */
    private static calculateNextRetryTime(failureCount: number): string {
        const delayMs = EMBEDDING_RETRY_BASE_DELAY_MS * Math.pow(2, failureCount - 1);
        const nextRetry = new Date(Date.now() + delayMs);
        return nextRetry.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }

    /**
     * Record a failed embedding attempt for an item.
     * If the item already has failures, increments the counter.
     * @param itemId The Zotero item ID
     * @param libraryId The Zotero library ID
     * @param error The error message
     */
    public async recordFailedEmbedding(itemId: number, libraryId: number, error: string): Promise<void> {
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        // Check if already exists
        const existing = await this.getFailedEmbedding(itemId);
        
        if (existing) {
            // Increment failure count
            const newFailureCount = existing.failure_count + 1;
            const nextRetry = BeaverDB.calculateNextRetryTime(newFailureCount);
            
            await this.conn.queryAsync(
                `UPDATE failed_embeddings 
                 SET failure_count = ?, last_error = ?, last_attempt = ?, next_retry_after = ?
                 WHERE item_id = ?`,
                [newFailureCount, error, now, nextRetry, itemId]
            );
        } else {
            // Insert new record
            const nextRetry = BeaverDB.calculateNextRetryTime(1);
            
            await this.conn.queryAsync(
                `INSERT INTO failed_embeddings 
                 (item_id, library_id, failure_count, last_error, last_attempt, next_retry_after)
                 VALUES (?, ?, 1, ?, ?, ?)`,
                [itemId, libraryId, error, now, nextRetry]
            );
        }
    }

    /**
     * Record multiple failed embedding attempts in a batch.
     * @param items Array of {itemId, libraryId} pairs
     * @param error The error message (same for all items in batch)
     */
    public async recordFailedEmbeddingsBatch(
        items: Array<{ itemId: number; libraryId: number }>,
        error: string
    ): Promise<void> {
        if (items.length === 0) return;

        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const itemIds = items.map(i => i.itemId);
        
        // Get existing failed records
        const existing = await this.getFailedEmbeddingsBatch(itemIds);
        const existingMap = new Map(existing.map(r => [r.item_id, r]));

        await this.conn.executeTransaction(async () => {
            for (const item of items) {
                const existingRecord = existingMap.get(item.itemId);
                
                if (existingRecord) {
                    const newFailureCount = existingRecord.failure_count + 1;
                    const nextRetry = BeaverDB.calculateNextRetryTime(newFailureCount);
                    
                    await this.conn.queryAsync(
                        `UPDATE failed_embeddings 
                         SET failure_count = ?, last_error = ?, last_attempt = ?, next_retry_after = ?
                         WHERE item_id = ?`,
                        [newFailureCount, error, now, nextRetry, item.itemId]
                    );
                } else {
                    const nextRetry = BeaverDB.calculateNextRetryTime(1);
                    
                    await this.conn.queryAsync(
                        `INSERT INTO failed_embeddings 
                         (item_id, library_id, failure_count, last_error, last_attempt, next_retry_after)
                         VALUES (?, ?, 1, ?, ?, ?)`,
                        [item.itemId, item.libraryId, error, now, nextRetry]
                    );
                }
            }
        });
    }

    /**
     * Get a failed embedding record by item ID.
     * @param itemId The Zotero item ID
     * @returns The failed embedding record or null
     */
    public async getFailedEmbedding(itemId: number): Promise<FailedEmbeddingRecord | null> {
        const rows = await this.conn.queryAsync(
            'SELECT * FROM failed_embeddings WHERE item_id = ?',
            [itemId]
        );
        
        if (rows.length === 0) return null;
        return BeaverDB.rowToFailedEmbeddingRecord(rows[0]);
    }

    /**
     * Get failed embedding records for multiple item IDs.
     * @param itemIds Array of Zotero item IDs
     * @returns Array of failed embedding records
     */
    public async getFailedEmbeddingsBatch(itemIds: number[]): Promise<FailedEmbeddingRecord[]> {
        if (itemIds.length === 0) return [];

        const results: FailedEmbeddingRecord[] = [];
        const chunkSize = 500;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            
            const rows = await this.conn.queryAsync(
                `SELECT * FROM failed_embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
            
            for (const row of rows) {
                results.push(BeaverDB.rowToFailedEmbeddingRecord(row));
            }
        }

        return results;
    }

    /**
     * Get all items that are ready for retry.
     * Returns items where next_retry_after < now AND failure_count < MAX_EMBEDDING_FAILURES.
     * @param libraryId Optional library ID to filter by
     * @returns Array of item IDs ready for retry
     */
    public async getItemsReadyForRetry(libraryId?: number): Promise<number[]> {
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        let sql = `SELECT item_id FROM failed_embeddings 
                   WHERE next_retry_after <= ? AND failure_count < ?`;
        const params: any[] = [now, MAX_EMBEDDING_FAILURES];
        
        if (libraryId !== undefined) {
            sql += ' AND library_id = ?';
            params.push(libraryId);
        }
        
        const rows = await this.conn.queryAsync(sql, params);
        return rows.map((row: any) => row.item_id);
    }

    /**
     * Get all permanently failed items (failure_count >= MAX_EMBEDDING_FAILURES).
     * @param libraryId Optional library ID to filter by
     * @returns Array of failed embedding records
     */
    public async getPermanentlyFailedItems(libraryId?: number): Promise<FailedEmbeddingRecord[]> {
        let sql = `SELECT * FROM failed_embeddings WHERE failure_count >= ?`;
        const params: any[] = [MAX_EMBEDDING_FAILURES];
        
        if (libraryId !== undefined) {
            sql += ' AND library_id = ?';
            params.push(libraryId);
        }
        
        const rows = await this.conn.queryAsync(sql, params);
        return rows.map((row: any) => BeaverDB.rowToFailedEmbeddingRecord(row));
    }

    /**
     * Remove a failed embedding record (call after successful indexing).
     * @param itemId The Zotero item ID
     */
    public async removeFailedEmbedding(itemId: number): Promise<void> {
        await this.conn.queryAsync(
            'DELETE FROM failed_embeddings WHERE item_id = ?',
            [itemId]
        );
    }

    /**
     * Remove multiple failed embedding records in a batch.
     * @param itemIds Array of Zotero item IDs
     */
    public async removeFailedEmbeddingsBatch(itemIds: number[]): Promise<void> {
        if (itemIds.length === 0) return;

        const chunkSize = 500;
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            await this.conn.queryAsync(
                `DELETE FROM failed_embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
        }
    }

    /**
     * Delete all failed embedding records for a library.
     * @param libraryId The Zotero library ID
     */
    public async deleteFailedEmbeddingsByLibrary(libraryId: number): Promise<void> {
        await this.conn.queryAsync(
            'DELETE FROM failed_embeddings WHERE library_id = ?',
            [libraryId]
        );
    }

    /**
     * Remove failed embedding records for items that no longer exist.
     * @param itemIds Array of item IDs that should be removed
     */
    public async cleanupDeletedFailedEmbeddings(itemIds: number[]): Promise<void> {
        await this.removeFailedEmbeddingsBatch(itemIds);
    }

    /**
     * Get count of failed embeddings.
     * @param libraryId Optional library ID to filter by
     * @returns Number of failed embedding records
     */
    public async getFailedEmbeddingCount(libraryId?: number): Promise<number> {
        let sql = 'SELECT COUNT(*) as count FROM failed_embeddings';
        const params: any[] = [];

        if (libraryId !== undefined) {
            sql += ' WHERE library_id = ?';
            params.push(libraryId);
        }

        const rows = await this.conn.queryAsync(sql, params);
        return rows[0]?.count || 0;
    }

}
