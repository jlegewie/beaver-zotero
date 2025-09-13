import { v4 as uuidv4 } from 'uuid';
import type { MessageModel } from '../../react/types/chat/apiTypes';
import { ThreadData } from '../../react/types/chat/uiTypes';
import { getPref } from '../utils/prefs';
import { SyncMethod, SyncType } from '../../react/atoms/sync';


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
    zotero_user_id?: string;
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

    // --- Sync Logs Methods ---

    /**
     * Insert a new sync log record.
     * @param syncLog The sync log data to insert (without id, which will be generated)
     * @returns The complete SyncLogsRecord with generated id
     */
    public async insertSyncLog(syncLog: Omit<SyncLogsRecord, 'id' | 'timestamp'>): Promise<SyncLogsRecord> {
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
                syncLog.zotero_user_id,
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
     * @param library_id The library_id to delete logs for
     */
    public async deleteSyncLogsForLibrary(user_id: string, library_id: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM sync_logs WHERE user_id = ? AND library_id = ?`,
            [user_id, library_id]
        );
    }

}
