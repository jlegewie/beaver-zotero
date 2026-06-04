import { v4 as uuidv4 } from 'uuid';
import { ThreadData } from '../../react/atoms/threads';
import { getPref } from '../utils/prefs';
import { SyncMethod, SyncType } from '../../react/atoms/sync';
import {
    isExtractContentKind,
    parseCachedDocumentMetadata,
} from './documentExtraction/shared/contentKinds';
import type {
    CachedDocumentMetadata,
    DocumentCachePageLabels,
    ExtractContentKind,
} from './documentExtraction/shared/contentKinds';

export type { DocumentCachePageLabels } from './documentExtraction/shared/contentKinds';

type PdfCachedDocumentMetadata = Extract<CachedDocumentMetadata, { content_kind: 'pdf' }>;


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

export type DocumentCacheExtractionMode = 'structured' | 'markdown';
export type DocumentCachePayloadKind = 'structured' | 'markdown';

/** Authoritative error reason for a cached document; `null` marks a successful extraction. */
export type DocumentCacheErrorCode = 'encrypted' | 'invalid_pdf' | 'no_text_layer';

export interface DocumentCacheFileSignature {
    mtime_ms: number;
    size_bytes: number;
}

export interface DocumentCacheMetadataRecord {
    id: number;
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    contentKind: ExtractContentKind;
    filePath: string;
    fileSignature: DocumentCacheFileSignature;
    sourceSizeBytes: number;
    contentType: string;
    documentMetadata: CachedDocumentMetadata | null;
    pageCount: number | null;
    pageLabels: DocumentCachePageLabels | null;
    pages: PdfCachedDocumentMetadata['pages'];
    errorCode: DocumentCacheErrorCode | null;
    extractionSchemaVersion: string;
    metadataFormatVersion: number;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt: string | null;
}

export interface DocumentCachePayloadRecord {
    id: number;
    metadataId: number;
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    payloadKind: DocumentCachePayloadKind;
    contentKind: ExtractContentKind;
    sourceFilePath: string;
    sourceFileSignature: DocumentCacheFileSignature;
    sourceSizeBytes: number;
    payloadPath: string;
    payloadSizeBytes: number;
    payloadSha256: string | null;
    extractionSchemaVersion: string;
    cacheFormatVersion: number;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt: string | null;
}

export type DocumentCacheMetadataInput = Omit<
    DocumentCacheMetadataRecord,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
    | 'lastAccessedAt'
    | 'documentMetadata'
    | 'pageCount'
    | 'pageLabels'
    | 'pages'
> & {
    documentMetadata: CachedDocumentMetadata;
};

export type DocumentCachePayloadInput = Omit<
    DocumentCachePayloadRecord,
    'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt'
>;

/**
 * Background extraction job kinds. v1 only ships `hot_timeout_retry` —
 * future kinds (manual attachment add, library-wide indexing, mtime
 * change) will reuse the same row shape.
 */
export type BackgroundJobType = 'hot_timeout_retry';

/**
 * Payload carried alongside a background job. Shaped for the v1
 * timeout-retry extraction; future job types may extend this with
 * discriminated unions.
 */
export interface BackgroundJobPayload {
    maxPages: number | null;
    maxFileSizeMB: number;
    timeoutSeconds: number;
}

/**
 * Single row in `background_jobs`. Timestamps are epoch milliseconds so
 * `MIN(available_at, ?)` UPSERTs compare arithmetically.
 */
export interface BackgroundJobRecord {
    id: number;
    jobType: BackgroundJobType;
    libraryId: number;
    itemId: number | null;
    zoteroKey: string;
    mode: DocumentCacheExtractionMode;
    priority: number;
    payload: BackgroundJobPayload | null;
    enqueuedAt: number;
    availableAt: number;
    attemptCount: number;
    lastError: string | null;
}

export interface BackgroundJobInput {
    jobType: BackgroundJobType;
    libraryId: number;
    itemId?: number | null;
    zoteroKey: string;
    mode: DocumentCacheExtractionMode;
    priority?: number;
    payload?: BackgroundJobPayload | null;
    /** Epoch ms. Used for both `enqueued_at` and `available_at`. */
    now: number;
}

export interface BackgroundJobEnqueueResult {
    enqueued: boolean;
    id: number;
}

export interface BackgroundQueueStats {
    pending: number;
    available: number;
    deferred: number;
    dead: number;
    byJobType: Record<string, number>;
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

        await this.conn.queryAsync(`PRAGMA foreign_keys = ON`);

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

        await this.conn.queryAsync(`DROP TABLE IF EXISTS attachment_file_cache`);

        // Drop and recreate the document cache tables if the schema is stale
        if (await this.documentCacheSchemaIsStale()) {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS document_cache_payloads`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS document_cache_metadata`);
        }

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS document_cache_metadata (
                id                         INTEGER PRIMARY KEY,
                item_id                    INTEGER NOT NULL,
                library_id                 INTEGER NOT NULL,
                zotero_key                 TEXT NOT NULL,
                content_kind               TEXT NOT NULL,
                file_path                  TEXT NOT NULL,
                file_mtime_ms              INTEGER NOT NULL,
                file_size_bytes            INTEGER NOT NULL,
                source_size_bytes          INTEGER NOT NULL,
                content_type               TEXT NOT NULL,
                document_metadata_json     TEXT NOT NULL,
                error_code                 TEXT,
                extraction_schema_version  TEXT NOT NULL,
                metadata_format_version    INTEGER NOT NULL,
                created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                last_accessed_at           TEXT,
                UNIQUE(library_id, zotero_key)
            );
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcm_item_id
            ON document_cache_metadata(item_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcm_library
            ON document_cache_metadata(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS document_cache_payloads (
                id                         INTEGER PRIMARY KEY,
                metadata_id                INTEGER NOT NULL,
                item_id                    INTEGER NOT NULL,
                library_id                 INTEGER NOT NULL,
                zotero_key                 TEXT NOT NULL,
                payload_kind               TEXT NOT NULL,
                content_kind               TEXT NOT NULL,
                source_file_path           TEXT NOT NULL,
                source_file_mtime_ms       INTEGER NOT NULL,
                source_file_size_bytes     INTEGER NOT NULL,
                source_size_bytes          INTEGER NOT NULL,
                payload_path               TEXT NOT NULL,
                payload_size_bytes         INTEGER NOT NULL,
                payload_sha256             TEXT,
                extraction_schema_version  TEXT NOT NULL,
                cache_format_version       INTEGER NOT NULL,
                created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                last_accessed_at           TEXT,
                FOREIGN KEY (metadata_id)
                    REFERENCES document_cache_metadata(id)
                    ON DELETE CASCADE,
                UNIQUE(metadata_id, payload_kind)
            );
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_metadata_id
            ON document_cache_payloads(metadata_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_item_id
            ON document_cache_payloads(item_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_library
            ON document_cache_payloads(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_library_key_payload_kind
            ON document_cache_payloads(library_id, zotero_key, payload_kind);
        `);

        // Background job queue: one row per (library_id, zotero_key, mode).
        // Uses epoch-ms timestamps throughout so visibility-bump UPSERTs can
        // compare via MIN(available_at, ?) without string-vs-number drift.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS background_jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type        TEXT NOT NULL,
                library_id      INTEGER NOT NULL,
                item_id         INTEGER,
                zotero_key      TEXT NOT NULL,
                mode            TEXT NOT NULL,
                priority        INTEGER NOT NULL DEFAULT 100,
                payload_json    TEXT,
                enqueued_at     INTEGER NOT NULL,
                available_at    INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL DEFAULT 0,
                last_error      TEXT,
                UNIQUE(library_id, zotero_key, mode)
            );
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_background_jobs_visible
            ON background_jobs (available_at, priority);
        `);

        // Dead-letter table for jobs that exceeded MAX_ATTEMPTS. Surfaced
        // through the dev queue-stats endpoint; no automatic retry.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS background_jobs_dead (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type        TEXT NOT NULL,
                library_id      INTEGER NOT NULL,
                zotero_key      TEXT NOT NULL,
                mode            TEXT NOT NULL,
                payload_json    TEXT,
                enqueued_at     INTEGER NOT NULL,
                died_at         INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL,
                last_error      TEXT
            );
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
     * @param options.incrementExisting When true (default), existing rows have
     *   their failure_count bumped and next_retry_after pushed out per the
     *   exponential backoff schedule. Use this for "real" failures from the
     *   API or upsert path. When false, existing rows only refresh last_attempt
     *   and last_error, and new rows are inserted in an immediately retryable
     *   state so transient local failures do not start a backoff window.
     */
    public async recordFailedEmbeddingsBatch(
        items: Array<{ itemId: number; libraryId: number }>,
        error: string,
        options: { incrementExisting?: boolean } = {}
    ): Promise<void> {
        if (items.length === 0) return;

        const { incrementExisting = true } = options;

        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const itemIds = items.map(i => i.itemId);

        // Get existing failed records
        const existing = await this.getFailedEmbeddingsBatch(itemIds);
        const existingMap = new Map(existing.map(r => [r.item_id, r]));

        await this.conn.executeTransaction(async () => {
            for (const item of items) {
                const existingRecord = existingMap.get(item.itemId);

                if (existingRecord) {
                    if (incrementExisting) {
                        const newFailureCount = existingRecord.failure_count + 1;
                        const nextRetry = BeaverDB.calculateNextRetryTime(newFailureCount);

                        await this.conn.queryAsync(
                            `UPDATE failed_embeddings
                             SET failure_count = ?, last_error = ?, last_attempt = ?, next_retry_after = ?
                             WHERE item_id = ?`,
                            [newFailureCount, error, now, nextRetry, item.itemId]
                        );
                    } else {
                        // Transient mode: refresh diagnostics but preserve the
                        // existing failure_count and retry schedule. This keeps
                        // healthy items from being escalated toward permanent
                        // failure on a string of local DB errors.
                        await this.conn.queryAsync(
                            `UPDATE failed_embeddings
                             SET last_error = ?, last_attempt = ?
                             WHERE item_id = ?`,
                            [error, now, item.itemId]
                        );
                    }
                } else {
                    await this.conn.queryAsync(
                        `INSERT INTO failed_embeddings
                         (item_id, library_id, failure_count, last_error, last_attempt, next_retry_after)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            item.itemId,
                            item.libraryId,
                            incrementExisting ? 1 : 0,
                            error,
                            now,
                            incrementExisting ? BeaverDB.calculateNextRetryTime(1) : now,
                        ]
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

    // =============================================
    // Document Cache Methods
    // =============================================

    private static normalizeDocumentCacheContentKind(value: unknown): ExtractContentKind {
        return typeof value === 'string' && isExtractContentKind(value)
            ? value
            : 'snapshot';
    }

    private static rowToDocumentCacheMetadataRecord(row: any): DocumentCacheMetadataRecord {
        const contentKind = BeaverDB.normalizeDocumentCacheContentKind(row.content_kind);
        const documentMetadata = parseCachedDocumentMetadata(
            row.content_kind,
            row.document_metadata_json,
        );
        const pdfMetadata = documentMetadata?.content_kind === 'pdf'
            ? documentMetadata
            : null;
        return {
            id: row.id,
            itemId: row.item_id,
            libraryId: row.library_id,
            zoteroKey: row.zotero_key,
            contentKind,
            filePath: row.file_path,
            fileSignature: {
                mtime_ms: row.file_mtime_ms,
                size_bytes: row.file_size_bytes,
            },
            sourceSizeBytes: row.source_size_bytes,
            contentType: row.content_type,
            documentMetadata,
            pageCount: pdfMetadata?.pageCount ?? null,
            pageLabels: pdfMetadata?.pageLabels ?? null,
            pages: pdfMetadata?.pages ?? null,
            errorCode: row.error_code ?? null,
            extractionSchemaVersion: row.extraction_schema_version,
            metadataFormatVersion: row.metadata_format_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastAccessedAt: row.last_accessed_at ?? null,
        };
    }

    private static rowToDocumentCachePayloadRecord(row: any): DocumentCachePayloadRecord {
        return {
            id: row.id,
            metadataId: row.metadata_id,
            itemId: row.item_id,
            libraryId: row.library_id,
            zoteroKey: row.zotero_key,
            payloadKind: row.payload_kind,
            contentKind: BeaverDB.normalizeDocumentCacheContentKind(row.content_kind),
            sourceFilePath: row.source_file_path,
            sourceFileSignature: {
                mtime_ms: row.source_file_mtime_ms,
                size_bytes: row.source_file_size_bytes,
            },
            sourceSizeBytes: row.source_size_bytes,
            payloadPath: row.payload_path,
            payloadSizeBytes: row.payload_size_bytes,
            payloadSha256: row.payload_sha256 ?? null,
            extractionSchemaVersion: row.extraction_schema_version,
            cacheFormatVersion: row.cache_format_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastAccessedAt: row.last_accessed_at ?? null,
        };
    }

    /** Detect document-cache tables whose schema does not match the current shape. */
    private async documentCacheSchemaIsStale(): Promise<boolean> {
        const metadataColumns = new Set<string>();
        await this.conn.queryAsync(
            `SELECT name FROM pragma_table_info('document_cache_metadata')`,
            [],
            { onRow: (row: any) => metadataColumns.add(row.getResultByIndex(0)) },
        );
        if (metadataColumns.size > 0) {
            if (!metadataColumns.has('content_kind')) return true;
            if (!metadataColumns.has('document_metadata_json')) return true;
            const legacyMetadataColumns = [
                'page_count',
                'page_labels_json',
                'pages_json',
                'status',
                'has_text_layer',
                'needs_ocr',
                'is_encrypted',
                'is_invalid',
            ];
            if (legacyMetadataColumns.some((col) => metadataColumns.has(col))) {
                return true;
            }
        }

        const payloadColumns = new Set<string>();
        await this.conn.queryAsync(
            `SELECT name FROM pragma_table_info('document_cache_payloads')`,
            [],
            { onRow: (row: any) => payloadColumns.add(row.getResultByIndex(0)) },
        );
        if (payloadColumns.size > 0) {
            if (!payloadColumns.has('content_kind')) return true;
            if (!payloadColumns.has('payload_kind')) return true;
            if (payloadColumns.has('mode')) return true;
        }

        return false;
    }

    private async selectDocumentCacheMetadata(sql: string, params: any[] = []): Promise<DocumentCacheMetadataRecord[]> {
        const rows: any[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                // These indices must match the SELECT column order above.
                rows.push({
                    id: row.getResultByIndex(0),
                    item_id: row.getResultByIndex(1),
                    library_id: row.getResultByIndex(2),
                    zotero_key: row.getResultByIndex(3),
                    content_kind: row.getResultByIndex(4),
                    file_path: row.getResultByIndex(5),
                    file_mtime_ms: row.getResultByIndex(6),
                    file_size_bytes: row.getResultByIndex(7),
                    source_size_bytes: row.getResultByIndex(8),
                    content_type: row.getResultByIndex(9),
                    document_metadata_json: row.getResultByIndex(10),
                    error_code: row.getResultByIndex(11),
                    extraction_schema_version: row.getResultByIndex(12),
                    metadata_format_version: row.getResultByIndex(13),
                    created_at: row.getResultByIndex(14),
                    updated_at: row.getResultByIndex(15),
                    last_accessed_at: row.getResultByIndex(16),
                });
            },
        });
        return rows.map((row) => BeaverDB.rowToDocumentCacheMetadataRecord(row));
    }

    private async selectDocumentCachePayloads(sql: string, params: any[] = []): Promise<DocumentCachePayloadRecord[]> {
        const rows: any[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                // These indices must match the SELECT column order above.
                rows.push({
                    id: row.getResultByIndex(0),
                    metadata_id: row.getResultByIndex(1),
                    item_id: row.getResultByIndex(2),
                    library_id: row.getResultByIndex(3),
                    zotero_key: row.getResultByIndex(4),
                    payload_kind: row.getResultByIndex(5),
                    content_kind: row.getResultByIndex(6),
                    source_file_path: row.getResultByIndex(7),
                    source_file_mtime_ms: row.getResultByIndex(8),
                    source_file_size_bytes: row.getResultByIndex(9),
                    source_size_bytes: row.getResultByIndex(10),
                    payload_path: row.getResultByIndex(11),
                    payload_size_bytes: row.getResultByIndex(12),
                    payload_sha256: row.getResultByIndex(13),
                    extraction_schema_version: row.getResultByIndex(14),
                    cache_format_version: row.getResultByIndex(15),
                    created_at: row.getResultByIndex(16),
                    updated_at: row.getResultByIndex(17),
                    last_accessed_at: row.getResultByIndex(18),
                });
            },
        });
        return rows.map((row) => BeaverDB.rowToDocumentCachePayloadRecord(row));
    }

    private static documentCacheMetadataSelect(): string {
        return `SELECT id, item_id, library_id, zotero_key, content_kind,
                       file_path, file_mtime_ms, file_size_bytes,
                       source_size_bytes, content_type, document_metadata_json, error_code,
                       extraction_schema_version, metadata_format_version,
                       created_at, updated_at, last_accessed_at
                FROM document_cache_metadata`;
    }

    private static documentCachePayloadSelect(): string {
        return `SELECT id, metadata_id, item_id, library_id, zotero_key, payload_kind,
                       content_kind, source_file_path, source_file_mtime_ms, source_file_size_bytes,
                       source_size_bytes, payload_path, payload_size_bytes,
                       payload_sha256, extraction_schema_version, cache_format_version,
                       created_at, updated_at, last_accessed_at
                FROM document_cache_payloads`;
    }

    private static documentMetadataSourceChanged(
        existing: DocumentCacheMetadataRecord,
        incoming: DocumentCacheMetadataInput,
    ): boolean {
        return existing.filePath !== incoming.filePath
            || existing.fileSignature.mtime_ms !== incoming.fileSignature.mtime_ms
            || existing.fileSignature.size_bytes !== incoming.fileSignature.size_bytes
            || existing.sourceSizeBytes !== incoming.sourceSizeBytes
            || existing.extractionSchemaVersion !== incoming.extractionSchemaVersion
            || existing.metadataFormatVersion !== incoming.metadataFormatVersion;
    }

    private static documentCacheMetadataMatches(
        current: DocumentCacheMetadataRecord,
        inspected: DocumentCacheMetadataRecord,
    ): boolean {
        return current.id === inspected.id
            && current.itemId === inspected.itemId
            && current.libraryId === inspected.libraryId
            && current.zoteroKey === inspected.zoteroKey
            && current.filePath === inspected.filePath
            && current.fileSignature.mtime_ms === inspected.fileSignature.mtime_ms
            && current.fileSignature.size_bytes === inspected.fileSignature.size_bytes
            && current.sourceSizeBytes === inspected.sourceSizeBytes
            && current.contentType === inspected.contentType
            && current.contentKind === inspected.contentKind
            && JSON.stringify(current.documentMetadata) === JSON.stringify(inspected.documentMetadata)
            && current.errorCode === inspected.errorCode
            && current.extractionSchemaVersion === inspected.extractionSchemaVersion
            && current.metadataFormatVersion === inspected.metadataFormatVersion;
    }

    /** Insert or update document-cache metadata by library/key. */
    public async upsertDocumentCacheMetadata(
        record: DocumentCacheMetadataInput,
    ): Promise<{ metadata: DocumentCacheMetadataRecord; deletedPayloads: DocumentCachePayloadRecord[] }> {
        let deletedPayloads: DocumentCachePayloadRecord[] = [];
        await this.conn.executeTransaction(async () => {
            const existing = await this.getDocumentCacheMetadataByKey(record.libraryId, record.zoteroKey);
            if (existing && BeaverDB.documentMetadataSourceChanged(existing, record)) {
                deletedPayloads = await this.getDocumentCachePayloadsForMetadata(existing.id);
                await this.deleteDocumentCachePayloadRowsForMetadata(existing.id);
            }
            await this.conn.queryAsync(
                `INSERT INTO document_cache_metadata
                    (item_id, library_id, zotero_key, content_kind, file_path, file_mtime_ms,
                     file_size_bytes, source_size_bytes, content_type, document_metadata_json, error_code,
                     extraction_schema_version, metadata_format_version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(library_id, zotero_key) DO UPDATE SET
                    item_id = excluded.item_id,
                    content_kind = excluded.content_kind,
                    file_path = excluded.file_path,
                    file_mtime_ms = excluded.file_mtime_ms,
                    file_size_bytes = excluded.file_size_bytes,
                    source_size_bytes = excluded.source_size_bytes,
                    content_type = excluded.content_type,
                    document_metadata_json = excluded.document_metadata_json,
                    error_code = excluded.error_code,
                    extraction_schema_version = excluded.extraction_schema_version,
                    metadata_format_version = excluded.metadata_format_version,
                    updated_at = datetime('now')`,
                [
                    record.itemId,
                    record.libraryId,
                    record.zoteroKey,
                    record.contentKind,
                    record.filePath,
                    record.fileSignature.mtime_ms,
                    record.fileSignature.size_bytes,
                    record.sourceSizeBytes,
                    record.contentType,
                    JSON.stringify(record.documentMetadata),
                    record.errorCode,
                    record.extractionSchemaVersion,
                    record.metadataFormatVersion,
                ],
            );
        });
        const metadata = await this.getDocumentCacheMetadataByKey(record.libraryId, record.zoteroKey);
        if (!metadata) {
            throw new Error('Document cache metadata upsert failed');
        }
        return { metadata, deletedPayloads };
    }

    /** Get document-cache metadata by library/key. */
    public async getDocumentCacheMetadataByKey(
        libraryId: number,
        zoteroKey: string,
    ): Promise<DocumentCacheMetadataRecord | null> {
        const rows = await this.selectDocumentCacheMetadata(
            `${BeaverDB.documentCacheMetadataSelect()} WHERE library_id = ? AND zotero_key = ?`,
            [libraryId, zoteroKey],
        );
        return rows[0] ?? null;
    }

    /** Get document-cache metadata by primary key. */
    public async getDocumentCacheMetadataById(id: number): Promise<DocumentCacheMetadataRecord | null> {
        const rows = await this.selectDocumentCacheMetadata(
            `${BeaverDB.documentCacheMetadataSelect()} WHERE id = ?`,
            [id],
        );
        return rows[0] ?? null;
    }

    /** Get all document-cache metadata rows. */
    public async getAllDocumentCacheMetadata(): Promise<DocumentCacheMetadataRecord[]> {
        return this.selectDocumentCacheMetadata(
            `${BeaverDB.documentCacheMetadataSelect()} ORDER BY library_id, zotero_key`,
        );
    }

    /** Delete one metadata row and return its payload rows for file cleanup. */
    public async deleteDocumentCacheMetadata(
        libraryId: number,
        zoteroKey: string,
    ): Promise<DocumentCachePayloadRecord[]> {
        const metadata = await this.getDocumentCacheMetadataByKey(libraryId, zoteroKey);
        if (!metadata) return [];
        const payloads = await this.getDocumentCachePayloadsForMetadata(metadata.id);
        await this.conn.queryAsync(
            `DELETE FROM document_cache_metadata WHERE library_id = ? AND zotero_key = ?`,
            [libraryId, zoteroKey],
        );
        return payloads;
    }

    /** Delete a metadata row only if it still matches the inspected record. */
    public async deleteDocumentCacheMetadataIfUnchanged(
        metadata: DocumentCacheMetadataRecord,
    ): Promise<DocumentCachePayloadRecord[] | null> {
        let deletedPayloads: DocumentCachePayloadRecord[] | null = null;
        await this.conn.executeTransaction(async () => {
            const current = await this.getDocumentCacheMetadataById(metadata.id);
            if (!current) {
                deletedPayloads = [];
                return;
            }
            if (!BeaverDB.documentCacheMetadataMatches(current, metadata)) {
                deletedPayloads = null;
                return;
            }

            deletedPayloads = await this.getDocumentCachePayloadsForMetadata(metadata.id);
            await this.conn.queryAsync(
                `DELETE FROM document_cache_metadata WHERE id = ?`,
                [metadata.id],
            );
        });
        return deletedPayloads;
    }

    /** Delete metadata rows for a library and return payload rows for file cleanup. */
    public async deleteDocumentCacheMetadataByLibrary(libraryId: number): Promise<DocumentCachePayloadRecord[]> {
        const payloads = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE library_id = ?`,
            [libraryId],
        );
        await this.conn.queryAsync(
            `DELETE FROM document_cache_metadata WHERE library_id = ?`,
            [libraryId],
        );
        return payloads;
    }

    /** Insert or update a document-cache payload by metadata/payload kind. */
    public async upsertDocumentCachePayload(record: DocumentCachePayloadInput): Promise<DocumentCachePayloadRecord> {
        await this.conn.queryAsync(
            `INSERT INTO document_cache_payloads
                (metadata_id, item_id, library_id, zotero_key, payload_kind, content_kind,
                 source_file_path, source_file_mtime_ms, source_file_size_bytes,
                 source_size_bytes, payload_path, payload_size_bytes, payload_sha256,
                 extraction_schema_version, cache_format_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(metadata_id, payload_kind) DO UPDATE SET
                metadata_id = excluded.metadata_id,
                item_id = excluded.item_id,
                library_id = excluded.library_id,
                zotero_key = excluded.zotero_key,
                content_kind = excluded.content_kind,
                source_file_path = excluded.source_file_path,
                source_file_mtime_ms = excluded.source_file_mtime_ms,
                source_file_size_bytes = excluded.source_file_size_bytes,
                source_size_bytes = excluded.source_size_bytes,
                payload_path = excluded.payload_path,
                payload_size_bytes = excluded.payload_size_bytes,
                payload_sha256 = excluded.payload_sha256,
                extraction_schema_version = excluded.extraction_schema_version,
                cache_format_version = excluded.cache_format_version,
                updated_at = datetime('now')`,
            [
                record.metadataId,
                record.itemId,
                record.libraryId,
                record.zoteroKey,
                record.payloadKind,
                record.contentKind,
                record.sourceFilePath,
                record.sourceFileSignature.mtime_ms,
                record.sourceFileSignature.size_bytes,
                record.sourceSizeBytes,
                record.payloadPath,
                record.payloadSizeBytes,
                record.payloadSha256,
                record.extractionSchemaVersion,
                record.cacheFormatVersion,
            ],
        );
        const payload = await this.getDocumentCachePayload(record.libraryId, record.zoteroKey, record.payloadKind);
        if (!payload) {
            throw new Error('Document cache payload upsert failed');
        }
        return payload;
    }

    /** Get a payload row by library/key/payload kind. */
    public async getDocumentCachePayload(
        libraryId: number,
        zoteroKey: string,
        payloadKind: DocumentCachePayloadKind,
    ): Promise<DocumentCachePayloadRecord | null> {
        const rows = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE library_id = ? AND zotero_key = ? AND payload_kind = ?`,
            [libraryId, zoteroKey, payloadKind],
        );
        return rows[0] ?? null;
    }

    /** Get a payload row by primary key. */
    public async getDocumentCachePayloadById(id: number): Promise<DocumentCachePayloadRecord | null> {
        const rows = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE id = ?`,
            [id],
        );
        return rows[0] ?? null;
    }

    /** Get payload rows for one metadata row. */
    public async getDocumentCachePayloadsForMetadata(metadataId: number): Promise<DocumentCachePayloadRecord[]> {
        return this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE metadata_id = ?`,
            [metadataId],
        );
    }

    /** Get all payload rows. */
    public async getAllDocumentCachePayloads(): Promise<DocumentCachePayloadRecord[]> {
        return this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} ORDER BY library_id, zotero_key, payload_kind`,
        );
    }

    private async deleteDocumentCachePayloadRowsForMetadata(metadataId: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads WHERE metadata_id = ?`,
            [metadataId],
        );
    }

    /** Delete a payload row and return it for file cleanup. */
    public async deleteDocumentCachePayload(
        libraryId: number,
        zoteroKey: string,
        payloadKind: DocumentCachePayloadKind,
    ): Promise<DocumentCachePayloadRecord | null> {
        const payload = await this.getDocumentCachePayload(libraryId, zoteroKey, payloadKind);
        if (!payload) return null;
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads WHERE id = ?`,
            [payload.id],
        );
        return payload;
    }

    /** Delete a payload row only if it still matches the inspected record. */
    public async deleteDocumentCachePayloadIfUnchanged(
        payload: DocumentCachePayloadRecord,
    ): Promise<DocumentCachePayloadRecord | null> {
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads
             WHERE id = ?
               AND metadata_id = ?
               AND item_id = ?
               AND library_id = ?
               AND zotero_key = ?
               AND payload_kind = ?
               AND content_kind = ?
               AND source_file_path = ?
               AND source_file_mtime_ms = ?
               AND source_file_size_bytes = ?
               AND source_size_bytes = ?
               AND payload_path = ?
               AND payload_size_bytes = ?
               AND COALESCE(payload_sha256, '') = COALESCE(?, '')
               AND extraction_schema_version = ?
               AND cache_format_version = ?`,
            [
                payload.id,
                payload.metadataId,
                payload.itemId,
                payload.libraryId,
                payload.zoteroKey,
                payload.payloadKind,
                payload.contentKind,
                payload.sourceFilePath,
                payload.sourceFileSignature.mtime_ms,
                payload.sourceFileSignature.size_bytes,
                payload.sourceSizeBytes,
                payload.payloadPath,
                payload.payloadSizeBytes,
                payload.payloadSha256,
                payload.extractionSchemaVersion,
                payload.cacheFormatVersion,
            ],
        );

        const current = await this.getDocumentCachePayloadById(payload.id);
        if (current && (
            current.metadataId !== payload.metadataId
            || current.itemId !== payload.itemId
            || current.libraryId !== payload.libraryId
            || current.zoteroKey !== payload.zoteroKey
            || current.payloadKind !== payload.payloadKind
            || current.contentKind !== payload.contentKind
            || current.sourceFilePath !== payload.sourceFilePath
            || current.sourceFileSignature.mtime_ms !== payload.sourceFileSignature.mtime_ms
            || current.sourceFileSignature.size_bytes !== payload.sourceFileSignature.size_bytes
            || current.sourceSizeBytes !== payload.sourceSizeBytes
            || current.payloadPath !== payload.payloadPath
            || current.payloadSizeBytes !== payload.payloadSizeBytes
            || current.payloadSha256 !== payload.payloadSha256
            || current.extractionSchemaVersion !== payload.extractionSchemaVersion
            || current.cacheFormatVersion !== payload.cacheFormatVersion
        )) {
            return null;
        }
        return current ? null : payload;
    }

    /** Delete payload rows for one metadata row and return them for file cleanup. */
    public async deleteDocumentCachePayloadsForMetadata(metadataId: number): Promise<DocumentCachePayloadRecord[]> {
        const payloads = await this.getDocumentCachePayloadsForMetadata(metadataId);
        await this.deleteDocumentCachePayloadRowsForMetadata(metadataId);
        return payloads;
    }

    /** Delete all payload rows for a library and return them for file cleanup. */
    public async deleteDocumentCachePayloadsByLibrary(libraryId: number): Promise<DocumentCachePayloadRecord[]> {
        const payloads = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE library_id = ?`,
            [libraryId],
        );
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads WHERE library_id = ?`,
            [libraryId],
        );
        return payloads;
    }

    /** Mark a metadata row as accessed. */
    public async touchDocumentCacheMetadata(id: number): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE document_cache_metadata SET last_accessed_at = datetime('now') WHERE id = ?`,
            [id],
        );
    }

    /** Mark a payload row as accessed. */
    public async touchDocumentCachePayload(id: number): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE document_cache_payloads SET last_accessed_at = datetime('now') WHERE id = ?`,
            [id],
        );
    }

    /** Count document-cache metadata rows. */
    public async getDocumentCacheMetadataCount(libraryId?: number): Promise<number> {
        const rows: Array<{ count: number }> = [];
        const sql = libraryId == null
            ? `SELECT COUNT(*) FROM document_cache_metadata`
            : `SELECT COUNT(*) FROM document_cache_metadata WHERE library_id = ?`;
        await this.conn.queryAsync(sql, libraryId == null ? [] : [libraryId], {
            onRow: (row: any) => rows.push({ count: row.getResultByIndex(0) }),
        });
        return rows[0]?.count ?? 0;
    }

    /** Count document-cache payload rows. */
    public async getDocumentCachePayloadCount(libraryId?: number): Promise<number> {
        const rows: Array<{ count: number }> = [];
        const sql = libraryId == null
            ? `SELECT COUNT(*) FROM document_cache_payloads`
            : `SELECT COUNT(*) FROM document_cache_payloads WHERE library_id = ?`;
        await this.conn.queryAsync(sql, libraryId == null ? [] : [libraryId], {
            onRow: (row: any) => rows.push({ count: row.getResultByIndex(0) }),
        });
        return rows[0]?.count ?? 0;
    }

    /** Delete every document-cache metadata and payload row. */
    public async deleteAllDocumentCache(): Promise<void> {
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(`DELETE FROM document_cache_payloads`);
            await this.conn.queryAsync(`DELETE FROM document_cache_metadata`);
        });
    }

    // =====================================================================
    // Background job queue
    // =====================================================================

    /**
     * Insert a new background job, or merge with the existing row that
     * already covers `(library_id, zotero_key, mode)`. Returns the job id
     * and whether the row was newly inserted.
     *
     * Merge semantics:
     *  - `priority` lowers to `MIN(existing, input)`.
     *  - `available_at` lowers to `MIN(existing, input.now)` so an urgent
     *    re-enqueue overrides a deferred prior visibility window.
     *  - `payload_json` and `job_type` only overwrite when the incoming
     *    job has a strictly higher (lower-numbered) priority, otherwise
     *    they stay untouched.
     */
    public async enqueueBackgroundJob(
        input: BackgroundJobInput,
    ): Promise<BackgroundJobEnqueueResult> {
        const [result] = await this.enqueueBackgroundJobs([input]);
        return result;
    }

    /**
     * Enqueue a batch of background jobs in one transaction.
     *
     * Results are returned in input order. Duplicate jobs within the batch
     * or already present in the queue use the same merge semantics as
     * `enqueueBackgroundJob`.
     */
    public async enqueueBackgroundJobs(
        inputs: BackgroundJobInput[],
    ): Promise<BackgroundJobEnqueueResult[]> {
        if (inputs.length === 0) return [];

        const results: BackgroundJobEnqueueResult[] = [];

        await this.conn.executeTransaction(async () => {
            for (const input of inputs) {
                results.push(await this.enqueueBackgroundJobInTransaction(input));
            }
        });

        return results;
    }

    /**
     * Insert or merge one background job. Must be called inside an active
     * transaction so callers can choose single-job or batch atomicity.
     */
    private async enqueueBackgroundJobInTransaction(
        input: BackgroundJobInput,
    ): Promise<BackgroundJobEnqueueResult> {
        const priority = input.priority ?? 100;
        const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
        const itemId = input.itemId ?? null;

        let enqueued = false;
        let id = 0;

        await this.conn.queryAsync(
            `INSERT OR IGNORE INTO background_jobs (
                job_type, library_id, item_id, zotero_key, mode,
                priority, payload_json, enqueued_at, available_at,
                attempt_count, last_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
            [
                input.jobType,
                input.libraryId,
                itemId,
                input.zoteroKey,
                input.mode,
                priority,
                payloadJson,
                input.now,
                input.now,
            ],
        );

        const changesRows: number[] = [];
        await this.conn.queryAsync(`SELECT changes()`, [], {
            onRow: (row: any) => {
                changesRows.push(row.getResultByIndex(0));
            },
        });
        enqueued = (changesRows[0] ?? 0) === 1;

        if (!enqueued) {
            await this.conn.queryAsync(
                `UPDATE background_jobs SET
                    priority = MIN(priority, ?),
                    available_at = MIN(available_at, ?),
                    job_type = CASE WHEN ? < priority THEN ? ELSE job_type END,
                    payload_json = CASE WHEN ? < priority THEN ? ELSE payload_json END
                 WHERE library_id = ? AND zotero_key = ? AND mode = ?`,
                [
                    priority,
                    input.now,
                    priority, input.jobType,
                    priority, payloadJson,
                    input.libraryId, input.zoteroKey, input.mode,
                ],
            );
        }

        const idRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT id FROM background_jobs
             WHERE library_id = ? AND zotero_key = ? AND mode = ?`,
            [input.libraryId, input.zoteroKey, input.mode],
            {
                onRow: (row: any) => {
                    idRows.push(row.getResultByIndex(0));
                },
            },
        );
        id = idRows[0] ?? 0;

        return { enqueued, id };
    }

    /**
     * Claim the next visible job (pgmq-style): pick lowest-priority, then
     * oldest-available row whose `available_at <= now`, then bump its
     * `available_at` forward by `visibilityTimeoutMs` so a crash/abort
     * leaves the row safe to re-pick later.
     *
     * `maxPriority` is an exclusive upper bound — when provided, only rows
     * with `priority < maxPriority` are eligible. Used by the background
     * extractor to gate library-scale work (priority >= 100) behind user
     * idleness while still letting hot-path retries (priority < 100) run.
     *
     * Returns `null` when no row is visible, or when an optimistic-claim
     * race lost (currently impossible with one consumer; cheap insurance).
     */
    public async claimNextBackgroundJob(
        now: number,
        visibilityTimeoutMs: number,
        maxPriority?: number,
    ): Promise<BackgroundJobRecord | null> {
        const params: unknown[] = [now];
        let priorityClause = '';
        if (maxPriority !== undefined) {
            priorityClause = ' AND priority < ?';
            params.push(maxPriority);
        }
        const candidates = await this.selectBackgroundJobs(
            `SELECT id, job_type, library_id, item_id, zotero_key, mode,
                    priority, payload_json, enqueued_at, available_at,
                    attempt_count, last_error
             FROM background_jobs
             WHERE available_at <= ?${priorityClause}
             ORDER BY priority ASC, available_at ASC
             LIMIT 1`,
            params,
        );
        if (candidates.length === 0) return null;
        const candidate = candidates[0];

        const newAvailableAt = now + visibilityTimeoutMs;
        const changesRows: number[] = [];
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(
                `UPDATE background_jobs
                 SET available_at = ?
                 WHERE id = ? AND available_at <= ?`,
                [newAvailableAt, candidate.id, now],
            );
            await this.conn.queryAsync(`SELECT changes()`, [], {
                onRow: (row: any) => {
                    changesRows.push(row.getResultByIndex(0));
                },
            });
        });

        if ((changesRows[0] ?? 0) !== 1) return null;
        return { ...candidate, availableAt: newAvailableAt };
    }

    /** Read up to `limit` jobs (default 100) without claiming. */
    public async peekBackgroundJobs(limit = 100): Promise<BackgroundJobRecord[]> {
        return this.selectBackgroundJobs(
            `SELECT id, job_type, library_id, item_id, zotero_key, mode,
                    priority, payload_json, enqueued_at, available_at,
                    attempt_count, last_error
             FROM background_jobs
             ORDER BY priority ASC, available_at ASC
             LIMIT ?`,
            [limit],
        );
    }

    /** Mark a claimed job as completed by removing its row. */
    public async completeBackgroundJob(id: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM background_jobs WHERE id = ?`,
            [id],
        );
    }

    /**
     * Record a failed attempt. After `maxAttempts` total attempts the row
     * moves to `background_jobs_dead`. Otherwise the attempt counter
     * bumps and `available_at` slides forward by `backoffMs(attempt)`.
     */
    public async failBackgroundJob(
        id: number,
        error: string,
        opts: {
            maxAttempts: number;
            backoffMs: (attempt: number) => number;
            now: number;
        },
    ): Promise<{ dead: boolean }> {
        const rows = await this.selectBackgroundJobs(
            `SELECT id, job_type, library_id, item_id, zotero_key, mode,
                    priority, payload_json, enqueued_at, available_at,
                    attempt_count, last_error
             FROM background_jobs
             WHERE id = ?`,
            [id],
        );
        if (rows.length === 0) return { dead: false };
        const current = rows[0];
        const nextAttempt = current.attemptCount + 1;

        if (nextAttempt >= opts.maxAttempts) {
            await this.conn.executeTransaction(async () => {
                await this.conn.queryAsync(
                    `INSERT INTO background_jobs_dead (
                        job_type, library_id, zotero_key, mode, payload_json,
                        enqueued_at, died_at, attempt_count, last_error
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        current.jobType,
                        current.libraryId,
                        current.zoteroKey,
                        current.mode,
                        current.payload ? JSON.stringify(current.payload) : null,
                        current.enqueuedAt,
                        opts.now,
                        nextAttempt,
                        error,
                    ],
                );
                await this.conn.queryAsync(
                    `DELETE FROM background_jobs WHERE id = ?`,
                    [id],
                );
            });
            return { dead: true };
        }

        const nextAvailableAt = opts.now + opts.backoffMs(nextAttempt);
        await this.conn.queryAsync(
            `UPDATE background_jobs
             SET attempt_count = attempt_count + 1,
                 last_error = ?,
                 available_at = ?
             WHERE id = ?`,
            [error, nextAvailableAt, id],
        );
        return { dead: false };
    }

    /**
     * Release a claimed job without counting it as a failed attempt. Used
     * when the processor itself aborts an in-flight job (e.g. shutdown),
     * so the row can be picked again on the next start without burning an
     * attempt or recording a misleading error.
     */
    public async releaseBackgroundJob(id: number, now: number): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE background_jobs SET available_at = ? WHERE id = ?`,
            [now, id],
        );
    }

    /** Counts surfaced through the dev queue-stats endpoint. */
    public async getBackgroundQueueStats(
        now: number,
    ): Promise<BackgroundQueueStats> {
        const totalsRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*) FROM background_jobs`,
            [],
            { onRow: (row: any) => totalsRows.push(row.getResultByIndex(0)) },
        );
        const pending = totalsRows[0] ?? 0;

        const availableRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*) FROM background_jobs WHERE available_at <= ?`,
            [now],
            { onRow: (row: any) => availableRows.push(row.getResultByIndex(0)) },
        );
        const available = availableRows[0] ?? 0;
        const deferred = pending - available;

        const deadRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*) FROM background_jobs_dead`,
            [],
            { onRow: (row: any) => deadRows.push(row.getResultByIndex(0)) },
        );
        const dead = deadRows[0] ?? 0;

        const byJobType: Record<string, number> = {};
        await this.conn.queryAsync(
            `SELECT job_type, COUNT(*) FROM background_jobs GROUP BY job_type`,
            [],
            {
                onRow: (row: any) => {
                    const jobType: string = row.getResultByIndex(0);
                    const count: number = row.getResultByIndex(1);
                    byJobType[jobType] = count;
                },
            },
        );

        return { pending, available, deferred, dead, byJobType };
    }

    private async selectBackgroundJobs(
        sql: string,
        params: any[] = [],
    ): Promise<BackgroundJobRecord[]> {
        const rows: BackgroundJobRecord[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                const payloadJson = row.getResultByIndex(7);
                let payload: BackgroundJobPayload | null = null;
                if (payloadJson) {
                    try {
                        payload = JSON.parse(payloadJson) as BackgroundJobPayload;
                    } catch (_e) {
                        payload = null;
                    }
                }
                rows.push({
                    id: row.getResultByIndex(0),
                    jobType: row.getResultByIndex(1) as BackgroundJobType,
                    libraryId: row.getResultByIndex(2),
                    itemId: row.getResultByIndex(3) ?? null,
                    zoteroKey: row.getResultByIndex(4),
                    mode: row.getResultByIndex(5) as DocumentCacheExtractionMode,
                    priority: row.getResultByIndex(6),
                    payload,
                    enqueuedAt: row.getResultByIndex(8),
                    availableAt: row.getResultByIndex(9),
                    attemptCount: row.getResultByIndex(10),
                    lastError: row.getResultByIndex(11) ?? null,
                });
            },
        });
        return rows;
    }
}
