import { v4 as uuidv4 } from 'uuid';
import { AttachmentStatusPagedResponse, AttachmentStatusResponse, UploadStatus } from './attachmentsService';
import { logger } from '../utils/logger';
import type { MessageModel } from '../../react/types/chat/apiTypes';
import { ThreadData } from '../../react/types/chat/uiTypes';
import { getPref } from '../utils/prefs';


/* 
 * Interface for the 'attachments' table row
 * 
 * Table stores the current syncing state of a zotero attachment
 * and upload status of the attachment file.
 * 
 */
export interface AttachmentRecord {
    user_id: string;
    library_id: number;
    zotero_key: string;

    // File hash and upload status
    file_hash: string | null;  // processed file hash (can differ from current file hash)
    upload_status: UploadStatus | null;
}

/* 
 * Interface for the 'upload_queue' table row
 * 
 * Table stores upload queue for each unique file hash with visibility,
 * attempt count and reference to representative attachment record.
 * 
 */
export interface UploadQueueRecord {
    file_hash: string;
    user_id: string;
    queue_visibility: string; 
    attempt_count: number;
    
    // Reference to representative attachment record
    library_id: number;
    zotero_key: string;
}

// Add a new interface for queue item input that allows optional file_hash
export interface UploadQueueInput {
    file_hash?: string | null;  // Allow optional/null for input
    queue_visibility?: string | null;
    attempt_count?: number;
    library_id: number;
    zotero_key: string;
}

// Upload statistics for a user
export interface AttachmentUploadStatistics {
    total: number;
    pending: number;
    completed: number;
    failed: number;
    skipped: number;
}

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
 * Interface for the 'messages' table row
 * 
 * Table stores chat messages for threads, mirroring the backend postgres structure
 * JSON fields are stored as stringified JSON in SQLite.
 * Corresponds to the MessageModel and messages table in the backend.
 * 
 */
export interface MessageRecord {
    id: string;
    user_id: string;
    thread_id: string;
    
    // OpenAI-message fields
    role: 'user' | 'assistant' | 'system';
    content: string | null;
    reasoning_content: string | null;
    tool_calls: string | null; // JSON string of ToolCall[]
    
    // reader state and attachments  
    reader_state: string | null; // JSON string of ReaderState
    attachments: string | null; // JSON string of MessageAttachment[]
    
    // User-initiated tool requests
    tool_request: string | null; // JSON string of ToolRequest
    
    // Message metadata
    status: 'in_progress' | 'completed' | 'canceled' | 'error';
    created_at: string;
    metadata: string | null; // JSON string of Record<string, any>
    error: string | null;
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
        if (previousVersion.startsWith('0.1')) {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS items`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS attachments`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS upload_queue`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS threads`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS messages`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS library_sync_state`);
        }

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS attachments (
                user_id                  TEXT(36) NOT NULL,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                file_hash                TEXT,
                upload_status            TEXT,
                PRIMARY KEY(user_id, library_id, zotero_key)
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS upload_queue (
                file_hash                TEXT NOT NULL,
                user_id                  TEXT(36) NOT NULL,
                queue_visibility         TEXT, 
                attempt_count            INTEGER DEFAULT 0 NOT NULL,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                PRIMARY KEY (user_id, file_hash),
                UNIQUE(user_id, file_hash)
            );
        `);

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
            CREATE INDEX IF NOT EXISTS idx_attachments_user_status
            ON attachments(user_id, upload_status);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_attachments_user_hash
            ON attachments(user_id, file_hash);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_upload_queue_read
            ON upload_queue(user_id, attempt_count, queue_visibility);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_thread_created
            ON messages(user_id, thread_id, created_at);
        `);
    }

    /**
     * Close the database connection.
     */
    public async closeDatabase(): Promise<void> {
        await this.conn.closeDatabase();
    }

    /**
     * Insert a record into the 'attachments' table.
     * @param user_id User ID for the attachment
     * @param attachment Data for the new attachment.
     */
    public async insertAttachment(
        user_id: string,
        attachment: Omit<AttachmentRecord, 'user_id'>
    ): Promise<void> {
        await this.conn.queryAsync(
            `INSERT INTO attachments (user_id, library_id, zotero_key, file_hash, upload_status)
             VALUES (?, ?, ?, ?, ?)`,
            [
                user_id,
                attachment.library_id,
                attachment.zotero_key,
                attachment.file_hash,
                attachment.upload_status
            ]
        );
    }

    /**
     * Helper to build and execute update queries safely.
     * @param table The table to update ('attachments').
     * @param user_id The user_id to match.
     * @param libraryId The library_id to match.
     * @param zoteroKey The zotero_key to match.
     * @param updates An object containing field-value pairs to update.
     * @param allowedFields List of fields allowed to be updated.
     */
    private async executeUpdate<T extends AttachmentRecord>(
        table: 'attachments',
        user_id: string,
        libraryId: number,
        zoteroKey: string,
        updates: Partial<Omit<T, 'user_id' | 'library_id' | 'zotero_key'>>,
        allowedFields: (keyof T)[]
    ): Promise<void> {
        const fieldsToUpdate = allowedFields.filter(field => (updates as Partial<T>)[field] !== undefined);

        if (fieldsToUpdate.length === 0) {
            return; // Nothing to update
        }

        const setClauses = fieldsToUpdate.map(field => `${String(field)} = ?`).join(', ');
        // Explicitly type values as any[] to allow mixing types for the query
        const values: any[] = fieldsToUpdate.map(field => (updates as Partial<T>)[field]);

        // Add user_id, library_id and zotero_key for the WHERE clause
        values.push(user_id, libraryId, zoteroKey);

        const query = `UPDATE ${table} SET ${setClauses} WHERE user_id = ? AND library_id = ? AND zotero_key = ?`;
        await this.conn.queryAsync(query, values);
    }

    /**
     * Update an existing attachment record identified by user_id, library_id and zotero_key.
     * @param user_id The user_id of the attachment.
     * @param libraryId The library_id of the attachment.
     * @param zoteroKey The zotero_key of the attachment.
     * @param updates An object containing the fields to update.
     */
    public async updateAttachment(
        user_id: string,
        libraryId: number,
        zoteroKey: string,
        updates: Partial<Omit<AttachmentRecord, 'user_id' | 'library_id' | 'zotero_key'>>
    ): Promise<void> {
        const allowedFields: (keyof AttachmentRecord)[] = [
            'file_hash',
            'upload_status'
        ];
        await this.executeUpdate<AttachmentRecord>('attachments', user_id, libraryId, zoteroKey, updates, allowedFields);
    }

    /**
    * Helper method to construct AttachmentRecord from a database row
    */
    private static rowToAttachmentRecord(row: any): AttachmentRecord {
         return {
            user_id: row.user_id,
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            file_hash: row.file_hash,
            upload_status: row.upload_status as UploadStatus,
        };
    }

    /**
     * Retrieve an attachment record by its user_id, library_id and zotero_key.
     * @param user_id The user_id of the attachment.
     * @param libraryId The library_id of the attachment.
     * @param zoteroKey The zotero_key of the attachment.
     * @returns The AttachmentRecord if found, otherwise null.
     */
    public async getAttachmentByZoteroKey(user_id: string, libraryId: number, zoteroKey: string): Promise<AttachmentRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ?1 AND library_id = ?2 AND zotero_key = ?3`,
            [user_id, libraryId, zoteroKey]
        );
         return rows.length === 0 ? null : BeaverDB.rowToAttachmentRecord(rows[0]);
    }

    /**
     * Retrieve an upload queue record by its user_id, library_id and zotero_key.
     * @param user_id The user_id of the queue item.
     * @param libraryId The library_id of the representative attachment.
     * @param zoteroKey The zotero_key of the representative attachment.
     * @returns The UploadQueueRecord if found, otherwise null.
     */
    public async getUploadQueueRecordByZoteroKey(user_id: string, libraryId: number, zoteroKey: string): Promise<UploadQueueRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM upload_queue WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
            [user_id, libraryId, zoteroKey]
        );
        return rows.length === 0 ? null : BeaverDB.rowToUploadQueueRecord(rows[0]);
    }

    /**
     * Retrieve an upload queue record by its user_id and file_hash.
     * @param user_id The user_id of the queue item.
     * @param file_hash The file_hash of the queue item.
     * @returns The UploadQueueRecord if found, otherwise null.
     */
    public async getUploadQueueRecordByFileHash(user_id: string, file_hash: string): Promise<UploadQueueRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM upload_queue WHERE user_id = ? AND file_hash = ?`,
            [user_id, file_hash]
        );
        return rows.length === 0 ? null : BeaverDB.rowToUploadQueueRecord(rows[0]);
    }

    /**
     * Upsert multiple attachment records in a single transaction.
     * Inserts attachments that don't exist, updates attachments where fields have changed.
     * @param user_id User ID for the attachments
     * @param attachments An array of attachment data.
     */
    public async upsertAttachmentsBatch(
        user_id: string, 
        attachments: Omit<AttachmentRecord, 'user_id'>[]
    ): Promise<void> {
        if (attachments.length === 0) {
            return;
        }

        // Single prepared statement for performance
        const insertSQL = `
            INSERT INTO attachments (
                user_id,
                library_id,
                zotero_key,
                file_hash,
                upload_status
            ) VALUES (
                ?, ?, ?, ?, ?
            )
            ON CONFLICT(user_id, library_id, zotero_key) DO UPDATE SET
                file_hash = excluded.file_hash,
                upload_status = excluded.upload_status;
        `;

        await this.conn.executeTransaction(async () => {
            for (const attachment of attachments) {
                const params = [
                    user_id,
                    attachment.library_id,
                    attachment.zotero_key,
                    attachment.file_hash,
                    attachment.upload_status ?? null
                ];
                
                await this.conn.queryAsync(insertSQL, params);
            }
        });
    }

    /**
     * Delete an attachment record by user_id, library_id and zotero_key.
     * @param user_id The user_id of the attachment to delete.
     * @param libraryId The library_id of the attachment to delete.
     * @param zoteroKey The zotero_key of the attachment to delete.
     */
    public async deleteAttachment(user_id: string, libraryId: number, zoteroKey: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
            [user_id, libraryId, zoteroKey]
        );
    }

    /**
     * Delete a record from attachments table by user_id, library_id and zotero_key.
     * Use this method when you don't know which table contains the record.
     * @param user_id The user_id of the record to delete.
     * @param libraryId The library_id of the record to delete.
     * @param zoteroKey The zotero_key of the record to delete.
     */
    public async deleteByLibraryAndKey(user_id: string, libraryId: number, zoteroKey: string): Promise<void> {
        // Execute both delete operations in a transaction for atomicity
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(
                `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                [user_id, libraryId, zoteroKey]
            );
        });
    }

    /**
     * Delete multiple records from attachments table by user_id, library_id and zotero_keys.
     * Use this method when you don't know which table contains the records.
     * @param user_id The user_id of the records to delete.
     * @param libraryId The library_id of the records to delete.
     * @param zoteroKeys Array of zotero_keys of the records to delete.
     */
    public async deleteByLibraryAndKeys(user_id: string, libraryId: number, zoteroKeys: string[]): Promise<void> {
        if (zoteroKeys.length === 0) {
            return;
        }

        // Execute both delete operations in a transaction for atomicity
        await this.conn.executeTransaction(async () => {
            const placeholders = zoteroKeys.map(() => '?').join(',');
            await this.conn.queryAsync(
                `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key IN (${placeholders})`,
                [user_id, libraryId, ...zoteroKeys]
            );
        });
    }

    /**
     * Retrieve multiple attachment records by their user_id, library_id and zotero_keys.
     * @param user_id The user_id of the attachments.
     * @param libraryId The library_id of the attachments.
     * @param zoteroKeys Array of zotero_keys to retrieve.
     * @returns Array of AttachmentRecord objects found, empty array if none found.
     */
    public async getAttachmentsByZoteroKeys(user_id: string, libraryId: number, zoteroKeys: string[]): Promise<AttachmentRecord[]> {
        if (zoteroKeys.length === 0) {
            return [];
        }
        
        const placeholders = zoteroKeys.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key IN (${placeholders})`,
            [user_id, libraryId, ...zoteroKeys]
        );
        
        return rows.map((row: any) => BeaverDB.rowToAttachmentRecord(row));
    }

    /**
     * Helper method to construct UploadQueueRecord from a database row
     */
    private static rowToUploadQueueRecord(row: any): UploadQueueRecord {
        return {
            file_hash: row.file_hash,
            user_id: row.user_id,
            queue_visibility: row.queue_visibility,
            attempt_count: row.attempt_count,
            library_id: row.library_id,
            zotero_key: row.zotero_key,
        };
    }

    /**
     * Get comprehensive upload statistics
     * @param user_id User ID
     * @returns Upload statistics
     */
    public async getAttachmentUploadStatistics(user_id: string): Promise<AttachmentUploadStatistics> {
        // Execute all queries in parallel for performance
        const [
            totalResult,
            pendingResult,
            completedResult,
            failedResult,
            planLimitResult,
            // aggregatesResult
        ] = await Promise.all([
            this.conn.queryAsync(
                'SELECT COUNT(*) as count FROM attachments WHERE user_id = ? AND file_hash IS NOT NULL',
                [user_id]
            ),
            this.conn.queryAsync(
                'SELECT COUNT(*) as count FROM attachments WHERE user_id = ? AND file_hash IS NOT NULL AND upload_status = "pending"',
                [user_id]
            ),
            this.conn.queryAsync(
                'SELECT COUNT(*) as count FROM attachments WHERE user_id = ? AND file_hash IS NOT NULL AND upload_status = "completed"',
                [user_id]
            ),
            this.conn.queryAsync(
                'SELECT COUNT(*) as count FROM attachments WHERE user_id = ? AND file_hash IS NOT NULL AND upload_status = "failed"',
                [user_id]
            ),
            this.conn.queryAsync(
                'SELECT COUNT(*) as count FROM attachments WHERE user_id = ? AND file_hash IS NOT NULL AND upload_status = "plan_limit"',
                [user_id]
            )
            // this.conn.queryAsync(
            // 'SELECT SUM(page_count) as totalPages, SUM(file_size) as totalSize FROM attachments WHERE user_id = ?',
            // [user_id]
            // )
        ]);
        
        return {
            total: totalResult[0]?.count || 0,
            pending: pendingResult[0]?.count || 0,
            completed: completedResult[0]?.count || 0,
            failed: failedResult[0]?.count || 0,
            skipped: planLimitResult[0]?.count || 0,
            // totalPages: aggregatesResult[0]?.totalPages || 0,
            // totalSize: aggregatesResult[0]?.totalSize || 0
        } as AttachmentUploadStatistics;
    }

    /**
     * Get the next batch of items from the upload queue and claim them for processing.
     * @param user_id User ID
     * @param limit Maximum number of items to return
     * @param maxAttempts Maximum upload attempts before an item is no longer considered for upload via this method
     * @param visibilityTimeoutMinutes How long to claim the items for (in minutes)
     * @returns Array of upload queue records ready for processing
     */
    public async readQueueItems(
        user_id: string,
        limit: number = 5,
        maxAttempts: number = 3,
        visibilityTimeoutMinutes: number = 5
    ): Promise<UploadQueueRecord[]> {
        return await this.conn.executeTransaction(async () => {
            const now = 'datetime(\'now\')'; // SQLite function for current UTC time
            const visibilityTimestamp = `datetime('now', '+${visibilityTimeoutMinutes} minutes')`;

            // Select items that:
            // 1. Are for the given user_id
            // 2. `queue_visibility` is NULL (never processed) or in the past (processing timed out)
            // 3. `attempt_count` is less than `maxAttempts`
            const rows = await this.conn.queryAsync(
                `SELECT * FROM upload_queue
                 WHERE user_id = ?
                   AND (queue_visibility IS NULL OR queue_visibility <= ${now})
                   AND attempt_count < ?
                 ORDER BY attempt_count ASC, file_hash ASC -- Prioritize items with fewer attempts
                 LIMIT ?`,
                [user_id, maxAttempts, limit]
            );

            const itemsToProcess = rows.map((row: any) => BeaverDB.rowToUploadQueueRecord(row));

            if (itemsToProcess.length > 0) {
                const fileHashes = itemsToProcess.map((item: UploadQueueRecord) => item.file_hash);
                const placeholders = fileHashes.map(() => '?').join(',');

                // Update queue_visibility and increment attempt_count for the selected items
                await this.conn.queryAsync(
                    `UPDATE upload_queue
                     SET queue_visibility = ${visibilityTimestamp},
                         attempt_count = attempt_count + 1
                     WHERE user_id = ? AND file_hash IN (${placeholders})`,
                    [user_id, ...fileHashes]
                );
            }
            return itemsToProcess;
        });
    }

    /**
     * Mark an item in the upload queue as completed.
     * This involves deleting it from 'upload_queue' and updating 'attachments'.
     * @param user_id User ID
     * @param file_hash The file_hash of the completed item
     * @returns boolean indicating whether the queue item was found and processed
     */
    public async completeQueueItem(user_id: string, file_hash: string): Promise<boolean> {
        await this.conn.executeTransaction(async () => {
            // Delete from upload_queue
            await this.conn.queryAsync(
                `DELETE FROM upload_queue WHERE user_id = ? AND file_hash = ?`,
                [user_id, file_hash]
            );
        
            // Update all attachments with this file_hash to 'completed'
            await this.conn.queryAsync(
                `UPDATE attachments
                    SET upload_status = 'completed'
                    WHERE user_id = ? AND file_hash = ?`,
                [user_id, file_hash]
            );
        });
        return true;
    }

    /**
     * Mark an item in the upload queue as failed.
     * This involves deleting it from 'upload_queue' and updating 'attachments'.
     * @param user_id User ID
     * @param file_hash The file_hash of the failed item
     * @param status The status to update the upload to. Defaults to 'failed'.
     */
    public async failQueueItem(user_id: string, file_hash: string, status: UploadStatus = 'failed'): Promise<void> {
        await this.conn.executeTransaction(async () => {
            // Delete from upload_queue
            await this.conn.queryAsync(
                `DELETE FROM upload_queue WHERE user_id = ? AND file_hash = ?`,
                [user_id, file_hash]
            );

            // Update all attachments with this file_hash to 'failed'
            await this.conn.queryAsync(
                `UPDATE attachments
                 SET upload_status = ?
                 WHERE user_id = ? AND file_hash = ?`,
                [status, user_id, file_hash]
            );
        });
    }

    /**
     * Mark multiple items in the upload queue as failed.
     * This involves deleting them from 'upload_queue' and updating 'attachments'.
     * @param user_id User ID
     * @param file_hashes Array of file_hashes of the failed items
     * @param status The status to update the upload to. Defaults to 'failed'.
     */
    public async failQueueItems(user_id: string, file_hashes: string[], status: UploadStatus = 'failed'): Promise<void> {
        if (file_hashes.length === 0) {
            return;
        }

        // Filter out any invalid file_hashes
        const validHashes = file_hashes.filter(hash => hash && hash.trim() !== '');
        if (validHashes.length === 0) {
            return;
        }

        await this.conn.executeTransaction(async () => {
            const placeholders = validHashes.map(() => '?').join(',');
            
            // Delete from upload_queue
            await this.conn.queryAsync(
                `DELETE FROM upload_queue WHERE user_id = ? AND file_hash IN (${placeholders})`,
                [user_id, ...validHashes]
            );

            // Update all attachments with these file_hashes to the specified status
            await this.conn.queryAsync(
                `UPDATE attachments
                 SET upload_status = ?
                 WHERE user_id = ? AND file_hash IN (${placeholders})`,
                [status, user_id, ...validHashes]
            );
        });
    }

    /**
     * Upsert a single record into the 'upload_queue' table.
     * If a record with the same user_id and file_hash exists, it's updated. Otherwise, a new record is inserted.
     * For inserts: queue_visibility defaults to current time, attempt_count defaults to 0 if not provided.
     * For updates: queue_visibility and attempt_count are only updated if they are explicitly provided.
     * @param user_id User ID for the queue item.
     * @param item Data for the upload_queue record.
     */
    public async upsertQueueItem(user_id: string, item: UploadQueueInput): Promise<void> {
        const { file_hash, library_id, zotero_key } = item;
        
        if (!file_hash?.trim()) {
            throw new Error('file_hash is required and cannot be empty');
        }
        if (!library_id || !zotero_key?.trim()) {
            throw new Error('library_id and zotero_key are required');
        }
        
        // Build the update clauses dynamically based on what fields are provided
        const updateClauses = [
            'library_id = excluded.library_id',
            'zotero_key = excluded.zotero_key'
        ];
        
        // Only update queue_visibility and attempt_count if they are explicitly provided
        if (item.queue_visibility !== undefined) {
            updateClauses.push('queue_visibility = excluded.queue_visibility');
        }
        
        if (item.attempt_count !== undefined) {
            updateClauses.push('attempt_count = excluded.attempt_count');
        }
        
        await this.conn.queryAsync(
            `INSERT INTO upload_queue (user_id, file_hash, queue_visibility, attempt_count, library_id, zotero_key)
             VALUES (?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), ?, ?)
             ON CONFLICT(user_id, file_hash) DO UPDATE SET ${updateClauses.join(', ')}`,
            [
                user_id, 
                file_hash, 
                item.queue_visibility ?? null,
                item.attempt_count ?? null,
                library_id, 
                zotero_key
            ]
        );
    }

    /**
     * Upsert multiple upload_queue records in a single transaction.
     * Items without a valid file_hash will be filtered out before insertion.
     * For inserts: queue_visibility defaults to current time, attempt_count defaults to 0 if not provided.
     * For updates: queue_visibility and attempt_count are only updated if they are explicitly provided.
     * @param user_id User ID for the queue items
     * @param items An array of queue item data.
     */
    public async upsertQueueItemsBatch(user_id: string, items: UploadQueueInput[]): Promise<void> {
        if (items.length === 0) {
            return;
        }
        
        // Filter out items that don't have a valid file_hash since database requires it
        const validItems = items.filter(item => item.file_hash && item.file_hash.trim() !== '');
        
        if (validItems.length === 0) {
            return; // No valid items to process
        }
        
        await this.conn.executeTransaction(async () => {
            for (const item of validItems) {
                const { file_hash, queue_visibility, attempt_count, library_id, zotero_key } = item;
                
                // Build the update clauses dynamically based on what fields are provided
                const updateClauses = [
                    'library_id = excluded.library_id',
                    'zotero_key = excluded.zotero_key'
                ];
                
                // Only update queue_visibility and attempt_count if they are explicitly provided
                if (queue_visibility !== undefined) {
                    updateClauses.push('queue_visibility = excluded.queue_visibility');
                }
                
                if (attempt_count !== undefined) {
                    updateClauses.push('attempt_count = excluded.attempt_count');
                }
                
                await this.conn.queryAsync(
                    `INSERT INTO upload_queue (user_id, file_hash, queue_visibility, attempt_count, library_id, zotero_key)
                     VALUES (?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), ?, ?)
                     ON CONFLICT(user_id, file_hash) DO UPDATE SET ${updateClauses.join(', ')}`,
                    [
                        user_id, 
                        file_hash!, // We know this is valid because of the filter above
                        queue_visibility ?? null,
                        attempt_count ?? null,
                        library_id, 
                        zotero_key
                    ]
                );
            }
        });
    }

    /**
     * Reset uploads by setting their status to pending and adding them back to the upload queue.
     * @param user_id User ID
     * @param items Array of UploadQueueInput objects containing file_hash, library_id, and zotero_key
     */
    public async resetUploads(user_id: string, items: UploadQueueInput[]): Promise<void> {
        if (items.length === 0) {
            return;
        }

        await this.conn.executeTransaction(async () => {
            // 1. Update attachments table: set upload_status to "pending" for all file_hashes
            const fileHashes = items.map(item => item.file_hash).filter(hash => hash); // Ensure hashes are not null/undefined
            if (fileHashes.length === 0) {
                // No valid file hashes to process
                return;
            }
            const placeholders = fileHashes.map(() => '?').join(',');
            
            await this.conn.queryAsync(
                `UPDATE attachments 
                 SET upload_status = 'pending' 
                 WHERE user_id = ? AND file_hash IN (${placeholders})`,
                [user_id, ...fileHashes]
            );

            // 2. Upsert each item to upload_queue with reset values
            for (const item of items) {
                // Skip if file_hash is missing, as it's crucial for the queue logic
                if (!item.file_hash) {
                    logger(`Beaver DB: Skipping reset for item without file_hash. Library ID: ${item.library_id}, Zotero Key: ${item.zotero_key}`, 1);
                    continue;
                }

                const queueItem: UploadQueueInput = {
                    file_hash: item.file_hash,
                    queue_visibility: null,
                    attempt_count: 0,
                    library_id: item.library_id,
                    zotero_key: item.zotero_key
                };  

                // Use the existing upsert logic inline since we're already in a transaction
                const { file_hash, queue_visibility, attempt_count, library_id, zotero_key } = queueItem;
                
                const updateClauses = [
                    'library_id = excluded.library_id',
                    'zotero_key = excluded.zotero_key',
                    'queue_visibility = excluded.queue_visibility',  // Explicitly reset
                    'attempt_count = excluded.attempt_count'         // Explicitly reset
                ];
                
                await this.conn.queryAsync(
                    `INSERT INTO upload_queue (user_id, file_hash, queue_visibility, attempt_count, library_id, zotero_key)
                     VALUES (?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), ?, ?)
                     ON CONFLICT(user_id, file_hash) DO UPDATE SET ${updateClauses.join(', ')}`,
                    [
                        user_id, 
                        file_hash!, 
                        queue_visibility,
                        attempt_count,
                        library_id, 
                        zotero_key
                    ]
                );
            }
        });
    }

    /**
     * Get the total number of unique files in the upload queue for a user
     * This represents the total work for an upload session
     * @param user_id User ID
     * @returns Number of unique file hashes in upload queue
     */
    public async getTotalQueueItems(user_id: string): Promise<number> {
        try {
            const result = await this.conn.queryAsync(
                'SELECT COUNT(DISTINCT file_hash) as count FROM upload_queue WHERE user_id = ?',
                [user_id]
            );
            return result[0]?.count || 0;
        } catch (error: any) {
            logger(`Beaver DB: Error getting upload session total: ${error.message}`, 1);
            return 0;
        }
    }

    /**
     * Set visibility timeout for a queue items
     * @param user_id User ID
     * @param file_hash File hash of the item
     * @param timeoutMinutes Timeout in minutes
     */
    public async setQueueItemTimeout(
        user_id: string, 
        file_hash: string, 
        timeoutMinutes: number
    ): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE upload_queue 
             SET queue_visibility = datetime('now', '+' || ? || ' minutes')
             WHERE user_id = ? AND file_hash = ?`,
            [timeoutMinutes, user_id, file_hash]
        );
    }

    /**
     * Get all attachments with failed upload status for a user
     * @param user_id User ID
     * @returns Array of AttachmentRecord objects with failed upload status
     */
    public async getFailedAttachments(user_id: string): Promise<AttachmentRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ? AND upload_status = 'failed'
             ORDER BY library_id, zotero_key`,
            [user_id]
        );
        
        return rows.map((row: any) => BeaverDB.rowToAttachmentRecord(row));
    }

    /**
     * Get a paginated list of attachments with failed upload status for a user.
     * @param user_id User ID
     * @param limit Number of items per page
     * @param offset Number of items to skip
     * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
     */
    public async getFailedAttachmentsPaginated(
        user_id: string,
        limit: number,
        offset: number
    ): Promise<{ attachments: AttachmentRecord[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments 
             WHERE user_id = ? AND upload_status = 'failed'
             ORDER BY library_id, zotero_key
             LIMIT ? OFFSET ?`,
            [user_id, limit + 1, offset] // Fetch one extra to check if there are more
        );

        const attachments = rows
            .slice(0, limit)
            .map((row: any) => BeaverDB.rowToAttachmentRecord(row));
        
        return {
            attachments,
            has_more: rows.length > limit,
        };
    }

    /**
     * Get all attachments by upload status for a user
     * @param user_id User ID
     * @param status Upload status to filter by
     * @returns Array of AttachmentRecord objects
     */
    public async getAttachmentsByUploadStatus(user_id: string, status: UploadStatus): Promise<AttachmentRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ? AND upload_status = ?
             ORDER BY library_id, zotero_key`,
            [user_id, status]
        );
        return rows.map((row: any) => BeaverDB.rowToAttachmentRecord(row));
    }

    /**
     * Get a paginated list of attachments by upload status for a user.
     * @param user_id User ID
     * @param status Upload status to filter by
     * @param limit Number of items per page
     * @param offset Number of items to skip
     * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
     */
    public async getAttachmentsByUploadStatusPaginated(
        user_id: string,
        status: UploadStatus,
        limit: number,
        offset: number
    ): Promise<AttachmentStatusPagedResponse> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments 
             WHERE user_id = ? AND upload_status = ?
             ORDER BY library_id, zotero_key
             LIMIT ? OFFSET ?`,
            [user_id, status, limit + 1, offset]
        );

        const attachments = rows
            .slice(0, limit)
            .map((row: any) => BeaverDB.rowToAttachmentRecord(row))
            .map((attachment: AttachmentRecord) => ({
                library_id: attachment.library_id,
                zotero_key: attachment.zotero_key,
                file_hash: attachment.file_hash,
                upload_status: attachment.upload_status,
            } as AttachmentStatusResponse));
        
        return {
            items: attachments,
            page: offset,
            page_size: limit,
            has_more: rows.length > limit,
        } as AttachmentStatusPagedResponse;
    }

    /**
     * Fix integrity issue: Find pending attachments that don't have corresponding upload_queue entries
     * and add them to the upload_queue table.
     * @param user_id User ID
     * @returns Number of attachments fixed
     */
    public async fixPendingAttachmentsWithoutQueue(user_id: string): Promise<number> {
        try {
            // Find pending attachments whose file_hash is not in upload_queue
            const orphanedAttachments = await this.conn.queryAsync(
                `SELECT DISTINCT a.file_hash, a.library_id, a.zotero_key
                 FROM attachments a
                 LEFT JOIN upload_queue uq ON a.user_id = uq.user_id AND a.file_hash = uq.file_hash
                 WHERE a.user_id = ?
                   AND a.upload_status = 'pending'
                   AND a.file_hash IS NOT NULL
                   AND uq.file_hash IS NULL`, // This condition selects attachments not in upload_queue
                [user_id]
            );

            if (orphanedAttachments.length === 0) {
                return 0;
            }

            logger(`Beaver DB: Found ${orphanedAttachments.length} pending attachments without queue entries, fixing...`, 2);

            // Add these attachments to the upload queue
            const queueItems: UploadQueueInput[] = orphanedAttachments.map((row: any) => ({
                file_hash: row.file_hash,
                library_id: row.library_id,
                zotero_key: row.zotero_key,
                // Other fields will use defaults: queue_visibility = now, attempt_count = 0
            }));

            await this.upsertQueueItemsBatch(user_id, queueItems);

            logger(`Beaver DB: Successfully added ${orphanedAttachments.length} orphaned attachments to upload queue`, 3);
            return orphanedAttachments.length;

        } catch (error: any) {
            logger(`Beaver DB: Error fixing pending attachments without queue entries: ${error.message}`, 1);
            return 0;
        }
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
     * Helper method to construct MessageRecord from a database row
     */
    private static rowToMessageRecord(row: any): MessageRecord {
        return {
            id: row.id,
            user_id: row.user_id,
            thread_id: row.thread_id,
            role: row.role as 'user' | 'assistant' | 'system',
            content: row.content,
            reasoning_content: row.reasoning_content,
            tool_calls: row.tool_calls,
            reader_state: row.reader_state,
            attachments: row.attachments,
            tool_request: row.tool_request,
            status: row.status as 'in_progress' | 'completed' | 'canceled' | 'error',
            created_at: row.created_at,
            metadata: row.metadata,
            error: row.error,
        };
    }

    private static messageRecordToModel(record: MessageRecord): MessageModel {
        return {
            id: record.id,
            thread_id: record.thread_id,
            role: record.role,
            content: record.content || undefined,
            reasoning_content: record.reasoning_content || undefined,
            tool_calls: record.tool_calls ? JSON.parse(record.tool_calls) : undefined,
            reader_state: record.reader_state ? JSON.parse(record.reader_state) : undefined,
            attachments: record.attachments ? JSON.parse(record.attachments) : undefined,
            tool_request: record.tool_request ? JSON.parse(record.tool_request) : undefined,
            status: record.status,
            created_at: record.created_at,
            metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
            error: record.error || undefined,
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

    // --- Message Methods ---

    /**
     * Retrieve all messages from a specific thread, ordered by creation date.
     * @param user_id The user_id of the thread
     * @param threadId The ID of the thread
     * @returns An array of MessageModel objects
     */
    public async getMessagesFromThread(user_id: string, threadId: string): Promise<MessageModel[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY created_at ASC`,
            [user_id, threadId]
        );
        return rows.map((row: any) => {
            const record = BeaverDB.rowToMessageRecord(row);
            return BeaverDB.messageRecordToModel(record);
        });
    }

    /**
     * Deletes the specified message and all subsequent messages in a thread.
     * @param user_id The user_id of the thread
     * @param thread_id ID of the thread to modify
     * @param message_id ID of the message to reset from
     * @param messages List of messages to operate on
     * @param keep_message If true, keeps the message with message_id and deletes only subsequent messages
     * @returns A list of the remaining messages in the thread
     */
    public async resetFromMessage(
        user_id: string,
        thread_id: string,
        message_id: string,
        messages: MessageModel[],
        keep_message: boolean = false
    ): Promise<MessageModel[]> {
        if (!messages || messages.length === 0) {
            return [];
        }

        // Find the index of the message to reset from
        const messageIndex = messages.findIndex(msg => msg.id === message_id);

        if (messageIndex === -1) {
            return messages;
        }

        // Determine the slice of messages to delete
        const deleteStartIndex = keep_message ? messageIndex + 1 : messageIndex;
        const messagesToDelete = messages.slice(deleteStartIndex);
        
        if (messagesToDelete.length > 0) {
            const messageIdsToDelete = messagesToDelete.map(msg => msg.id);
            await this.deleteMessagesBatch(user_id, messageIdsToDelete);

            // Also update thread's updated_at timestamp
            await this.updateThread(user_id, thread_id, { 
                updatedAt: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
            });
        }

        // Return the remaining messages
        return messages.slice(0, deleteStartIndex);
    }

    /**
     * Upsert a message in the database.
     * Inserts a new message or updates an existing one based on the message ID.
     * @param user_id The user_id of the message
     * @param message The complete message object to upsert
     */
    public async upsertMessage(user_id: string, message: MessageModel): Promise<void> {
        // Validate required fields
        if (!message.id) {
            throw new Error('Message ID is required');
        }
        if (!message.thread_id) {
            throw new Error('Thread ID is required');
        }
        if (!message.role) {
            throw new Error('Message role is required');
        }

        const record = {
            ...message,
            tool_calls: message.tool_calls ? JSON.stringify(message.tool_calls) : null,
            reader_state: message.reader_state ? JSON.stringify(message.reader_state) : null,
            attachments: message.attachments ? JSON.stringify(message.attachments) : null,
            tool_request: message.tool_request ? JSON.stringify(message.tool_request) : null,
            metadata: message.metadata ? JSON.stringify(message.metadata) : null,
        };

        // Ensure required fields have values with defaults if needed
        const {
            id,
            thread_id,
            role,
            content = null,
            reasoning_content = null,
            tool_calls,
            reader_state,
            attachments,
            tool_request,
            status = 'completed',
            created_at = null,
            metadata,
            error = null
        } = record;

        await this.conn.queryAsync(
            `INSERT INTO messages (id, user_id, thread_id, role, content, reasoning_content, tool_calls, reader_state, attachments, tool_request, status, created_at, metadata, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                user_id = excluded.user_id,
                thread_id = excluded.thread_id,
                role = excluded.role,
                content = excluded.content,
                reasoning_content = excluded.reasoning_content,
                tool_calls = excluded.tool_calls,
                reader_state = excluded.reader_state,
                attachments = excluded.attachments,
                tool_request = excluded.tool_request,
                status = excluded.status,
                metadata = excluded.metadata,
                error = excluded.error`,
            [id, user_id, thread_id, role, content, reasoning_content, tool_calls, reader_state, attachments, tool_request, status, created_at, metadata, error]
        );
    }

    /**
     * Update an existing message.
     * @param user_id The user_id of the message
     * @param id The ID of the message to update
     * @param updates A partial message object with fields to update
     */
    public async updateMessage(user_id: string, id: string, updates: Partial<MessageModel>): Promise<void> {
        const recordUpdates: any = { ...updates };

        if (updates.tool_calls !== undefined) recordUpdates.tool_calls = JSON.stringify(updates.tool_calls);
        if (updates.reader_state !== undefined) recordUpdates.reader_state = JSON.stringify(updates.reader_state);
        if (updates.attachments !== undefined) recordUpdates.attachments = JSON.stringify(updates.attachments);
        if (updates.tool_request !== undefined) recordUpdates.tool_request = JSON.stringify(updates.tool_request);
        if (updates.metadata !== undefined) recordUpdates.metadata = JSON.stringify(updates.metadata);

        const fieldsToUpdate = Object.keys(recordUpdates).filter(key => key !== 'id' && key !== 'user_id' && key !== 'thread_id' && key !== 'created_at');

        if (fieldsToUpdate.length === 0) {
            return; // Nothing to update
        }

        const setClauses = fieldsToUpdate.map(field => `${field} = ?`).join(', ');
        const values = fieldsToUpdate.map(field => (recordUpdates as any)[field]);
        values.push(user_id, id);

        const query = `UPDATE messages SET ${setClauses} WHERE user_id = ? AND id = ?`;
        await this.conn.queryAsync(query, values);
    }

    /**
     * Delete a message by its ID.
     * @param user_id The user_id of the message
     * @param id The ID of the message to delete
     */
    public async deleteMessage(user_id: string, id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM messages WHERE user_id = ? AND id = ?`,
            [user_id, id]
        );
    }

    /**
     * Delete multiple messages by their IDs in a single transaction.
     * @param user_id The user_id of the messages
     * @param ids The IDs of the messages to delete
     */
    private async deleteMessagesBatch(user_id: string, ids: string[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }

        const placeholders = ids.map(() => '?').join(',');
        
        await this.conn.queryAsync(
            `DELETE FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
            [user_id, ...ids]
        );
    }

    /**
     * Retrieve a message by its ID.
     * @param user_id The user_id of the message
     * @param id The ID of the message to retrieve
     * @returns The MessageModel if found, otherwise null
     */
    public async getMessage(user_id: string, id: string): Promise<MessageModel | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM messages WHERE user_id = ? AND id = ?`,
            [user_id, id]
        );
        if (rows.length === 0) {
            return null;
        }
        const record = BeaverDB.rowToMessageRecord(rows[0]);
        return BeaverDB.messageRecordToModel(record);
    }

}

/* Example Usage:
(async () => {
    // Assume 'beaverCacheDB' is an initialized Zotero.DBConnection("beaver")
    // const beaverCacheDB = new Zotero.DBConnection("beaver");
    // await beaverCacheDB.test(); // Ensure DB connection is working

    const db = new BeaverDB(beaverCacheDB);
    await db.initDatabase(); // Create tables if they don't exist

    // --- Item Operations ---
    const newItemData = {
        library_id: 1,
        zotero_key: "ITEMKEY123",
        item_metadata_hash: "hash1"
    };
    const itemId = await db.insertItem(newItemData);
    console.log("Inserted item id:", itemId);

    const fetchedItem = await db.getItemByZoteroKey(1, "ITEMKEY123");
    console.log("Fetched item:", fetchedItem);

    await db.updateItem(1, "ITEMKEY123", { item_metadata_hash: "hash2" });
    const updatedItem = await db.getItemByZoteroKey(1, "ITEMKEY123");
    console.log("Updated item:", updatedItem);

    // --- Attachment Operations ---
    const newAttachmentData = {
        library_id: 1,
        zotero_key: "ATTACHKEY456",
        attachment_metadata_hash: "attachHash1",
        file_hash: "fileHash1" // Optional
    };
    const attachmentId = await db.insertAttachment(newAttachmentData);
    console.log("Inserted attachment id:", attachmentId);

    const fetchedAttachment = await db.getAttachmentByZoteroKey(1, "ATTACHKEY456");
    console.log("Fetched attachment:", fetchedAttachment);

    await db.updateAttachment(1, "ATTACHKEY456", { upload_status: "completed", file_hash: "fileHashUpdated" });
    const updatedAttachment = await db.getAttachmentByZoteroKey(1, "ATTACHKEY456");
    console.log("Updated attachment:", updatedAttachment);

    // await db.closeDatabase(); // Close when done
})();
*/ 