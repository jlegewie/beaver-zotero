import { v4 as uuidv4 } from 'uuid';
import { ProcessingStatus, UploadStatus } from './attachmentsService';
import { logger } from '../utils/logger';
import type { MessageModel } from '../../react/types/chat/apiTypes';
import { ThreadData } from '../../react/types/chat/uiTypes';

/* 
 * Interface for the 'items' table row
 * 
 * Table stores the current syncing state of a zotero item
 * Items are only stored with a metadata hash after they have been synced
 * 
 */
export interface ItemRecord {
    id: string;
    user_id: string;
    library_id: number;
    zotero_key: string;
    item_metadata_hash: string;
}

/* 
 * Interface for the 'attachments' table row
 * 
 * Table stores the current state of a zotero attachment. This includes
 * the syncing state (file metadata), upload status and processing status.
 * 
 */
export interface AttachmentRecord {
    id: string;
    user_id: string;
    library_id: number;
    zotero_key: string;
    attachment_metadata_hash: string;
    file_hash: string | null;

    // Processing status
    can_upload: boolean | null;
    upload_status: UploadStatus | null;
    md_status: ProcessingStatus | null;
    docling_status: ProcessingStatus | null;
    text_status: ProcessingStatus | null;
    md_error_code: string | null;
    docling_error_code: string | null;
    text_error_code: string | null;
}

/* 
 * Interface for the 'upload_queue' table row
 * 
 * Table stores upload queue for each unique file hash with visibility,
 * attempt count, file metadata and reference to representative attachment record.
 * 
 */
export interface UploadQueueRecord {
    file_hash: string;
    user_id: string;
    page_count: number | null;
    file_size: number | null;
    queue_visibility: string; 
    attempt_count: number;
    
    // Reference to representative attachment record
    library_id: number;
    zotero_key: string;
}

// Add a new interface for queue item input that allows optional file_hash
export interface UploadQueueInput {
    file_hash?: string | null;  // Allow optional/null for input
    page_count?: number | null;
    file_size?: number | null;
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
    public async initDatabase(): Promise<void> {
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS items (
                id                       TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                item_metadata_hash       TEXT NOT NULL,
                UNIQUE(user_id, library_id, zotero_key)
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS attachments (
                id                       TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                attachment_metadata_hash TEXT NOT NULL,
                file_hash                TEXT,
                can_upload               BOOLEAN,
                upload_status            TEXT,
                md_status                TEXT,
                docling_status           TEXT,
                text_status              TEXT,
                md_error_code            TEXT,
                docling_error_code       TEXT,
                text_error_code          TEXT,
                UNIQUE(user_id, library_id, zotero_key)
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS upload_queue (
                file_hash                TEXT NOT NULL,
                user_id                  TEXT(36) NOT NULL,
                page_count               INTEGER,
                file_size                INTEGER,
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
                name                     TEXT,
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS messages (
                id                       TEXT(36) PRIMARY KEY,
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
            CREATE INDEX IF NOT EXISTS idx_messages_thread_id 
            ON messages(thread_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_threads_updated 
            ON threads(updated_at DESC);
        `);
    }

    /**
     * Close the database connection.
     */
    public async closeDatabase(): Promise<void> {
        await this.conn.closeDatabase();
    }

    /**
     * Insert a record into the 'items' table.
     * @param user_id User ID for the item
     * @param item Data for the new item record. 'id' will be generated.
     * @returns The generated 'id' of the inserted item.
     */
    public async insertItem(user_id: string, item: Omit<ItemRecord, 'id' | 'user_id'>): Promise<string> {
        const id = uuidv4();
        await this.conn.queryAsync(
            `INSERT INTO items (id, user_id, library_id, zotero_key, item_metadata_hash)
             VALUES (?, ?, ?, ?, ?)`,
            [
                id,
                user_id,
                item.library_id,
                item.zotero_key,
                item.item_metadata_hash
            ]
        );
        return id;
    }

    /**
     * Insert multiple records into the 'items' table in a single transaction.
     * @param user_id User ID for the items
     * @param items An array of item data. 'id' will be generated for each.
     * @returns An array of the generated 'id's for the inserted items.
     */
    public async insertItemsBatch(user_id: string, items: Omit<ItemRecord, 'id' | 'user_id'>[]): Promise<string[]> {
        if (items.length === 0) {
            return [];
        }

        const generatedIds: string[] = items.map(() => uuidv4());
        const placeholders = items.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const values: any[] = [];
        items.forEach((item, index) => {
            values.push(
                generatedIds[index],
                user_id,
                item.library_id,
                item.zotero_key,
                item.item_metadata_hash
            );
        });

        const query = `INSERT INTO items (id, user_id, library_id, zotero_key, item_metadata_hash) VALUES ${placeholders}`;

        // Using executeTransaction ensures atomicity
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(query, values);
        });

        return generatedIds;
    }

    /**
     * Insert a record into the 'attachments' table.
     * Optional fields default to initial states ('pending', 'unavailable', null).
     * @param user_id User ID for the attachment
     * @param attachment Data for the new attachment. 'id' will be generated.
     *                   Requires 'library_id', 'zotero_key', 'attachment_metadata_hash'.
     * @returns The generated 'id' of the inserted attachment.
     */
    public async insertAttachment(
        user_id: string,
        attachment: Pick<AttachmentRecord, 'library_id' | 'zotero_key' | 'attachment_metadata_hash'> & Partial<Omit<AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key' | 'attachment_metadata_hash'>>
    ): Promise<string> {
        const id = uuidv4();
        const defaults: Partial<AttachmentRecord> = {
            file_hash: null,
            can_upload: null,
            upload_status: null,
            md_status: null,
            docling_status: null,
            text_status: null,
            md_error_code: null,
            docling_error_code: null,
            text_error_code: null,
        };
        const finalAttachment = { ...defaults, ...attachment };

        await this.conn.queryAsync(
            `INSERT INTO attachments (id, user_id, library_id, zotero_key, attachment_metadata_hash, file_hash, can_upload, upload_status, md_status, docling_status, text_status, md_error_code, docling_error_code, text_error_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                user_id,
                finalAttachment.library_id,
                finalAttachment.zotero_key,
                finalAttachment.attachment_metadata_hash,
                finalAttachment.file_hash,
                finalAttachment.can_upload,
                finalAttachment.upload_status,
                finalAttachment.md_status,
                finalAttachment.docling_status,
                finalAttachment.text_status,
                finalAttachment.md_error_code,
                finalAttachment.docling_error_code,
                finalAttachment.text_error_code
            ]
        );
        return id;
    }

    /**
     * Helper to build and execute update queries safely.
     * @param table The table to update ('items' or 'attachments').
     * @param user_id The user_id to match.
     * @param libraryId The library_id to match.
     * @param zoteroKey The zotero_key to match.
     * @param updates An object containing field-value pairs to update.
     * @param allowedFields List of fields allowed to be updated.
     */
    private async executeUpdate<T extends object>(
        table: 'items' | 'attachments',
        user_id: string,
        libraryId: number,
        zoteroKey: string,
        updates: Partial<T>,
        allowedFields: (keyof T)[]
    ): Promise<void> {
        const fieldsToUpdate = allowedFields.filter(field => updates[field] !== undefined);

        if (fieldsToUpdate.length === 0) {
            return; // Nothing to update
        }

        const setClauses = fieldsToUpdate.map(field => `${String(field)} = ?`).join(', ');
        // Explicitly type values as any[] to allow mixing types for the query
        const values: any[] = fieldsToUpdate.map(field => updates[field]);

        // Add user_id, library_id and zotero_key for the WHERE clause
        values.push(user_id, libraryId, zoteroKey);

        const query = `UPDATE ${table} SET ${setClauses} WHERE user_id = ? AND library_id = ? AND zotero_key = ?`;
        await this.conn.queryAsync(query, values);
    }

    /**
     * Update an existing item record identified by user_id, library_id and zotero_key.
     * Only 'item_metadata_hash' can be updated.
     * @param user_id The user_id of the item.
     * @param libraryId The library_id of the item.
     * @param zoteroKey The zotero_key of the item.
     * @param updates An object containing the fields to update.
     */
    public async updateItem(
        user_id: string,
        libraryId: number,
        zoteroKey: string,
        updates: Partial<Pick<ItemRecord, 'item_metadata_hash'>>
    ): Promise<void> {
        const allowedFields: (keyof ItemRecord)[] = ['item_metadata_hash'];
        await this.executeUpdate<ItemRecord>('items', user_id, libraryId, zoteroKey, updates, allowedFields);
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
        updates: Partial<Omit<AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key'>>
    ): Promise<void> {
        const allowedFields: (keyof AttachmentRecord)[] = [
            'attachment_metadata_hash',
            'file_hash',
            'can_upload',
            'upload_status',
            'md_status',
            'docling_status',
            'text_status',
            'md_error_code',
            'docling_error_code',
            'text_error_code'
        ];
        await this.executeUpdate<AttachmentRecord>('attachments', user_id, libraryId, zoteroKey, updates, allowedFields);
    }

    /**
     * Update an existing item record or insert a new one if it doesn't exist.
     * @param user_id User ID for the item
     * @param item Data for the item record. Requires 'library_id', 'zotero_key', 'item_metadata_hash'.
     * @returns The internal 'id' of the upserted item.
     */
    public async upsertItem(user_id: string, item: Omit<ItemRecord, 'id' | 'user_id'>): Promise<string> {
        const existingItem = await this.getItemByZoteroKey(user_id, item.library_id, item.zotero_key);
        if (existingItem) {
            // Only update if the hash is different to avoid unnecessary writes
            if (existingItem.item_metadata_hash !== item.item_metadata_hash) {
                 await this.updateItem(user_id, item.library_id, item.zotero_key, { item_metadata_hash: item.item_metadata_hash });
            }
            return existingItem.id;
        } else {
            const newId = await this.insertItem(user_id, item);
            return newId;
        }
    }

    /**
     * Upsert multiple item records in a single transaction.
     * Inserts items that don't exist, updates items where 'item_metadata_hash' has changed.
     * @param user_id User ID for the items
     * @param items An array of item data. Requires 'library_id', 'zotero_key', 'item_metadata_hash'.
     * @returns An array of the internal 'id's corresponding to the input items (either existing or newly inserted).
     */
    public async upsertItemsBatch(user_id: string, items: Omit<ItemRecord, 'id' | 'user_id'>[]): Promise<string[]> {
        if (items.length === 0) {
            return [];
        }

        const finalIds: string[] = [];
        const itemsToInsert: (Omit<ItemRecord, 'id' | 'user_id'> & { generatedId: string })[] = [];
        const itemsToUpdate: { libraryId: number; zoteroKey: string; item_metadata_hash: string }[] = [];
        const itemMap = new Map<string, Omit<ItemRecord, 'id' | 'user_id'>>(); // Key: "libraryId-zoteroKey"
        items.forEach(item => itemMap.set(`${item.library_id}-${item.zotero_key}`, item));

        // 1. Fetch existing items matching the batch
        const keys = items.map(item => [item.library_id, item.zotero_key]);
        // Construct IN clause placeholders: ((?,?), (?,?), ...)
        const placeholders = keys.map(() => '(?,?)').join(',');
        const values = [user_id, ...keys.flat()];
        const query = `SELECT * FROM items WHERE user_id = ? AND (library_id, zotero_key) IN (VALUES ${placeholders})`;
        const existingRows = await this.conn.queryAsync(query, values);
        const existingItemsMap = new Map<string, ItemRecord>(); // Key: "libraryId-zoteroKey"
        existingRows.forEach((row: any) => {
            const record = BeaverDB.rowToItemRecord(row);
            existingItemsMap.set(`${record.library_id}-${record.zotero_key}`, record);
        });

        // 2. Determine inserts vs updates
        for (const item of items) {
            const key = `${item.library_id}-${item.zotero_key}`;
            const existing = existingItemsMap.get(key);
            if (existing) {
                finalIds.push(existing.id); // Use existing ID
                if (existing.item_metadata_hash !== item.item_metadata_hash) {
                    itemsToUpdate.push({
                        libraryId: item.library_id,
                        zoteroKey: item.zotero_key,
                        item_metadata_hash: item.item_metadata_hash,
                    });
                }
            } else {
                const newId = uuidv4();
                finalIds.push(newId); // Use newly generated ID
                itemsToInsert.push({ ...item, generatedId: newId });
            }
        }

        // 3. Execute within a transaction
        await this.conn.executeTransaction(async () => {
            // Batch Insert
            if (itemsToInsert.length > 0) {
                const insertPlaceholders = itemsToInsert.map(() => '(?, ?, ?, ?, ?)').join(', ');
                const insertValues: any[] = [];
                itemsToInsert.forEach(item => {
                    insertValues.push(
                        item.generatedId,
                        user_id,
                        item.library_id,
                        item.zotero_key,
                        item.item_metadata_hash
                    );
                });
                const insertQuery = `INSERT INTO items (id, user_id, library_id, zotero_key, item_metadata_hash) VALUES ${insertPlaceholders}`;
                await this.conn.queryAsync(insertQuery, insertValues);
            }

            // Updates (individually within the transaction)
            for (const update of itemsToUpdate) {
                 await this.conn.queryAsync(
                     `UPDATE items SET item_metadata_hash = ? WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                     [update.item_metadata_hash, user_id, update.libraryId, update.zoteroKey]
                 );
             }
        });

        return finalIds;
    }

    /**
    * Helper method to construct ItemRecord from a database row
    */
    private static rowToItemRecord(row: any): ItemRecord {
        return {
            id: row.id,
            user_id: row.user_id,
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            item_metadata_hash: row.item_metadata_hash,
        };
    }

    /**
     * Retrieve an item record by its user_id, library_id and zotero_key.
     * @param user_id The user_id of the item.
     * @param libraryId The library_id of the item.
     * @param zoteroKey The zotero_key of the item.
     * @returns The ItemRecord if found, otherwise null.
     */
    public async getItemByZoteroKey(user_id: string, libraryId: number, zoteroKey: string): Promise<ItemRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM items WHERE user_id = ?1 AND library_id = ?2 AND zotero_key = ?3`,
            [user_id, libraryId, zoteroKey]
        );
        return rows.length === 0 ? null : BeaverDB.rowToItemRecord(rows[0]);
    }

    /**
    * Helper method to construct AttachmentRecord from a database row
    */
    private static rowToAttachmentRecord(row: any): AttachmentRecord {
         return {
            id: row.id,
            user_id: row.user_id,
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            attachment_metadata_hash: row.attachment_metadata_hash,
            file_hash: row.file_hash,
            can_upload: typeof row.can_upload === 'number' ? Boolean(row.can_upload) : row.can_upload,
            upload_status: row.upload_status as UploadStatus,
            md_status: row.md_status as ProcessingStatus,
            docling_status: row.docling_status as ProcessingStatus,
            text_status: row.text_status as ProcessingStatus,
            md_error_code: row.md_error_code,
            docling_error_code: row.docling_error_code,
            text_error_code: row.text_error_code,
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
     * @param attachments An array of attachment data. Requires 'library_id', 'zotero_key', 'attachment_metadata_hash'.
     * @returns An array of the internal 'id's corresponding to the input attachments (either existing or newly inserted).
     */
    public async upsertAttachmentsBatch(
        user_id: string, 
        attachments: (Pick<AttachmentRecord, 'library_id' | 'zotero_key' | 'attachment_metadata_hash'> & Partial<Omit<AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key' | 'attachment_metadata_hash'>>)[]
    ): Promise<string[]> {
        if (attachments.length === 0) {
            return [];
        }

        const defaults: Partial<AttachmentRecord> = {
            file_hash: null,
            can_upload: null,
            // TODO: Should they be set to null as a default?
            upload_status: 'pending',
            md_status: 'unavailable',
            docling_status: 'unavailable',
            text_status: 'unavailable',
            md_error_code: null,
            docling_error_code: null,
            text_error_code: null,
        };

        const finalIds: string[] = [];
        const attachmentsToInsert: (Omit<AttachmentRecord, 'id' | 'user_id'> & { generatedId: string })[] = [];
        const attachmentsToUpdate: { libraryId: number; zoteroKey: string; updates: Partial<Omit<AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key'>> }[] = [];
        const attachmentMap = new Map<string, typeof attachments[0]>(); // Key: "libraryId-zoteroKey"
        attachments.forEach(attachment => {
            const finalAttachment = { ...defaults, ...attachment };
            attachmentMap.set(`${finalAttachment.library_id}-${finalAttachment.zotero_key}`, finalAttachment);
        });

        // 1. Fetch existing attachments matching the batch
        const keys = attachments.map(attachment => [attachment.library_id, attachment.zotero_key]);
        // Construct IN clause placeholders: ((?,?), (?,?), ...)
        const placeholders = keys.map(() => '(?,?)').join(',');
        const values = [user_id, ...keys.flat()];
        const query = `SELECT * FROM attachments WHERE user_id = ? AND (library_id, zotero_key) IN (VALUES ${placeholders})`;
        const existingRows = await this.conn.queryAsync(query, values);
        const existingAttachmentsMap = new Map<string, AttachmentRecord>(); // Key: "libraryId-zoteroKey"
        existingRows.forEach((row: any) => {
            const record = BeaverDB.rowToAttachmentRecord(row);
            existingAttachmentsMap.set(`${record.library_id}-${record.zotero_key}`, record);
        });

        // 2. Determine inserts vs updates
        for (const attachment of attachments) {
            const finalAttachment = { ...defaults, ...attachment };
            const key = `${finalAttachment.library_id}-${finalAttachment.zotero_key}`;
            const existing = existingAttachmentsMap.get(key);
            
            if (existing) {
                finalIds.push(existing.id); // Use existing ID
                
                // Check which fields need updating
                const updates: Partial<Omit<AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key'>> = {};
                let hasChanges = false;
                
                if (existing.attachment_metadata_hash !== finalAttachment.attachment_metadata_hash) {
                    updates.attachment_metadata_hash = finalAttachment.attachment_metadata_hash;
                    hasChanges = true;
                }
                
                // Check all other fields for changes
                const fieldsToCheck: (keyof Omit<AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key' | 'attachment_metadata_hash'>)[] = [
                    'file_hash', 'can_upload', 'upload_status', 'md_status', 'docling_status', 'text_status', 'md_error_code', 'docling_error_code', 'text_error_code'
                ];
                
                fieldsToCheck.forEach(field => {
                    if (finalAttachment[field] !== undefined && existing[field] !== finalAttachment[field]) {
                        updates[field] = finalAttachment[field] as any;
                        hasChanges = true;
                    }
                });
                
                if (hasChanges) {
                    attachmentsToUpdate.push({
                        libraryId: finalAttachment.library_id,
                        zoteroKey: finalAttachment.zotero_key,
                        updates
                    });
                }
            } else {
                const newId = uuidv4();
                finalIds.push(newId); // Use newly generated ID
                attachmentsToInsert.push({ 
                    ...finalAttachment, 
                    generatedId: newId 
                } as any);
            }
        }

        // 3. Execute within a transaction
        await this.conn.executeTransaction(async () => {
            // Batch Insert
            if (attachmentsToInsert.length > 0) {
                const insertPlaceholders = attachmentsToInsert.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
                const insertValues: any[] = [];
                attachmentsToInsert.forEach(attachment => {
                    insertValues.push(
                        attachment.generatedId,
                        user_id,
                        attachment.library_id,
                        attachment.zotero_key,
                        attachment.attachment_metadata_hash,
                        attachment.file_hash,
                        attachment.can_upload,
                        attachment.upload_status,
                        attachment.md_status,
                        attachment.docling_status,
                        attachment.text_status,
                        attachment.md_error_code,
                        attachment.docling_error_code,
                        attachment.text_error_code
                    );
                });
                const insertQuery = `INSERT INTO attachments (id, user_id, library_id, zotero_key, attachment_metadata_hash, file_hash, can_upload, upload_status, md_status, docling_status, text_status, md_error_code, docling_error_code, text_error_code) VALUES ${insertPlaceholders}`;
                await this.conn.queryAsync(insertQuery, insertValues);
            }

            // Updates (individually within the transaction)
            for (const update of attachmentsToUpdate) {
                const setClauses = Object.keys(update.updates).map(field => `${field} = ?`).join(', ');
                const updateValues = [...Object.values(update.updates), user_id, update.libraryId, update.zoteroKey];
                await this.conn.queryAsync(
                    `UPDATE attachments SET ${setClauses} WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                    updateValues
                );
            }
        });

        return finalIds;
    }

    /**
     * Delete an item record by user_id, library_id and zotero_key.
     * @param user_id The user_id of the item to delete.
     * @param libraryId The library_id of the item to delete.
     * @param zoteroKey The zotero_key of the item to delete.
     */
    public async deleteItem(user_id: string, libraryId: number, zoteroKey: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM items WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
            [user_id, libraryId, zoteroKey]
        );
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
     * Delete a record from either items or attachments table by user_id, library_id and zotero_key.
     * Use this method when you don't know which table contains the record.
     * @param user_id The user_id of the record to delete.
     * @param libraryId The library_id of the record to delete.
     * @param zoteroKey The zotero_key of the record to delete.
     */
    public async deleteByLibraryAndKey(user_id: string, libraryId: number, zoteroKey: string): Promise<void> {
        // Execute both delete operations in a transaction for atomicity
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(
                `DELETE FROM items WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                [user_id, libraryId, zoteroKey]
            );

            await this.conn.queryAsync(
                `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                [user_id, libraryId, zoteroKey]
            );
        });
    }

    /**
     * Delete multiple records from either items or attachments table by user_id, library_id and zotero_keys.
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
                `DELETE FROM items WHERE user_id = ? AND library_id = ? AND zotero_key IN (${placeholders})`,
                [user_id, libraryId, ...zoteroKeys]
            );

            await this.conn.queryAsync(
                `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key IN (${placeholders})`,
                [user_id, libraryId, ...zoteroKeys]
            );
        });
    }

    /**
     * Retrieve multiple item records by their user_id, library_id and zotero_keys.
     * @param user_id The user_id of the items.
     * @param libraryId The library_id of the items.
     * @param zoteroKeys Array of zotero_keys to retrieve.
     * @returns Array of ItemRecord objects found, empty array if none found.
     */
    public async getItemsByZoteroKeys(user_id: string, libraryId: number, zoteroKeys: string[]): Promise<ItemRecord[]> {
        if (zoteroKeys.length === 0) {
            return [];
        }
        
        const placeholders = zoteroKeys.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT * FROM items WHERE user_id = ? AND library_id = ? AND zotero_key IN (${placeholders})`,
            [user_id, libraryId, ...zoteroKeys]
        );
        
        return rows.map((row: any) => BeaverDB.rowToItemRecord(row));
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
            page_count: row.page_count,
            file_size: row.file_size,
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
            skippedResult,
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
                'SELECT COUNT(*) as count FROM attachments WHERE user_id = ? AND file_hash IS NOT NULL AND upload_status = "skipped"',
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
            skipped: skippedResult[0]?.count || 0,
            // totalPages: aggregatesResult[0]?.totalPages || 0,
            // totalSize: aggregatesResult[0]?.totalSize || 0
        };
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
     */
    public async failQueueItem(user_id: string, file_hash: string): Promise<void> {
        await this.conn.executeTransaction(async () => {
            // Delete from upload_queue
            await this.conn.queryAsync(
                `DELETE FROM upload_queue WHERE user_id = ? AND file_hash = ?`,
                [user_id, file_hash]
            );

            // Update all attachments with this file_hash to 'failed'
            await this.conn.queryAsync(
                `UPDATE attachments
                 SET upload_status = 'failed'
                 WHERE user_id = ? AND file_hash = ?`,
                [user_id, file_hash]
            );
        });
    }

    /**
     * Upsert a single record into the 'upload_queue' table.
     * If a record with the same user_id and file_hash exists, it's updated. Otherwise, a new record is inserted.
     * For inserts: queue_visibility defaults to current time, attempt_count defaults to 0 if not provided.
     * For updates: queue_visibility and attempt_count are only updated if explicitly provided.
     * @param user_id User ID for the queue item.
     * @param item Data for the upload_queue record.
     */
    public async upsertQueueItem(
        user_id: string,
        item: UploadQueueInput
    ): Promise<void> {
        const { file_hash, page_count, file_size, queue_visibility, attempt_count, library_id, zotero_key } = item;
        
        // Validate that file_hash is provided and not empty
        if (!file_hash || file_hash.trim() === '') {
            throw new Error('file_hash is required and cannot be empty');
        }
        
        // Build the update clauses dynamically based on what fields are provided
        const updateClauses = [
            'page_count = excluded.page_count',
            'file_size = excluded.file_size',
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
            `INSERT INTO upload_queue (user_id, file_hash, page_count, file_size, queue_visibility, attempt_count, library_id, zotero_key)
             VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), ?, ?)
             ON CONFLICT(user_id, file_hash) DO UPDATE SET ${updateClauses.join(', ')}`,
            [
                user_id, 
                file_hash, 
                page_count ?? null,
                file_size ?? null,
                queue_visibility ?? null,
                attempt_count ?? null,
                library_id, 
                zotero_key
            ]
        );
    }

    /**
     * Upsert multiple upload_queue records in a single transaction.
     * Items without a valid file_hash will be filtered out before insertion.
     * For inserts: queue_visibility defaults to current time, attempt_count defaults to 0 if not provided.
     * For updates: queue_visibility and attempt_count are only updated if explicitly provided.
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
                const { file_hash, page_count, file_size, queue_visibility, attempt_count, library_id, zotero_key } = item;
                
                // Build the update clauses dynamically based on what fields are provided
                const updateClauses = [
                    'page_count = excluded.page_count',
                    'file_size = excluded.file_size',
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
                    `INSERT INTO upload_queue (user_id, file_hash, page_count, file_size, queue_visibility, attempt_count, library_id, zotero_key)
                     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), ?, ?)
                     ON CONFLICT(user_id, file_hash) DO UPDATE SET ${updateClauses.join(', ')}`,
                    [
                        user_id, 
                        file_hash!, // We know this is valid because of the filter above
                        page_count ?? null, 
                        file_size ?? null, 
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
                    page_count: null,
                    file_size: null,
                    queue_visibility: null, // Changed from undefined to null
                    attempt_count: 0,
                    library_id: item.library_id,
                    zotero_key: item.zotero_key
                };  

                // Use the existing upsert logic inline since we're already in a transaction
                const { file_hash, page_count, file_size, queue_visibility, attempt_count, library_id, zotero_key } = queueItem;
                
                const updateClauses = [
                    'page_count = excluded.page_count',
                    'file_size = excluded.file_size',
                    'library_id = excluded.library_id',
                    'zotero_key = excluded.zotero_key',
                    'queue_visibility = excluded.queue_visibility',  // Explicitly reset
                    'attempt_count = excluded.attempt_count'         // Explicitly reset
                ];
                
                await this.conn.queryAsync(
                    `INSERT INTO upload_queue (user_id, file_hash, page_count, file_size, queue_visibility, attempt_count, library_id, zotero_key)
                     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), ?, ?)
                     ON CONFLICT(user_id, file_hash) DO UPDATE SET ${updateClauses.join(', ')}`,
                    [
                        user_id, 
                        file_hash!, 
                        page_count, 
                        file_size, 
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
    ): Promise<{ attachments: AttachmentRecord[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments 
             WHERE user_id = ? AND upload_status = ?
             ORDER BY library_id, zotero_key
             LIMIT ? OFFSET ?`,
            [user_id, status, limit + 1, offset]
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
     * Get all attachments by text status for a user
     * @param user_id User ID
     * @param status text status to filter by
     * @returns Array of AttachmentRecord objects
     */
    public async getAttachmentsByTextStatus(user_id: string, status: ProcessingStatus): Promise<AttachmentRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ? AND text_status = ?
             ORDER BY library_id, zotero_key`,
            [user_id, status]
        );
        return rows.map((row: any) => BeaverDB.rowToAttachmentRecord(row));
    }

    /**
     * Get a paginated list of attachments by text status for a user.
     * @param user_id User ID
     * @param status text status to filter by
     * @param limit Number of items per page
     * @param offset Number of items to skip
     * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
     */
    public async getAttachmentsByTextStatusPaginated(
        user_id: string,
        status: ProcessingStatus,
        limit: number,
        offset: number
    ): Promise<{ attachments: AttachmentRecord[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments 
             WHERE user_id = ? AND text_status = ?
             ORDER BY library_id, zotero_key
             LIMIT ? OFFSET ?`,
            [user_id, status, limit + 1, offset]
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
     * Get all attachments by MD status for a user
     * @param user_id User ID
     * @param status MD status to filter by
     * @returns Array of AttachmentRecord objects
     */
    public async getAttachmentsByMdStatus(user_id: string, status: ProcessingStatus): Promise<AttachmentRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ? AND md_status = ?
             ORDER BY library_id, zotero_key`,
            [user_id, status]
        );
        return rows.map((row: any) => BeaverDB.rowToAttachmentRecord(row));
    }

    /**
     * Get a paginated list of attachments by MD status for a user.
     * @param user_id User ID
     * @param status MD status to filter by
     * @param limit Number of items per page
     * @param offset Number of items to skip
     * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
     */
    public async getAttachmentsByMdStatusPaginated(
        user_id: string,
        status: ProcessingStatus,
        limit: number,
        offset: number
    ): Promise<{ attachments: AttachmentRecord[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments 
             WHERE user_id = ? AND md_status = ?
             ORDER BY library_id, zotero_key
             LIMIT ? OFFSET ?`,
            [user_id, status, limit + 1, offset]
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
     * Get all attachments by Docling status for a user
     * @param user_id User ID
     * @param status Docling status to filter by
     * @returns Array of AttachmentRecord objects
     */
    public async getAttachmentsByDoclingStatus(user_id: string, status: ProcessingStatus): Promise<AttachmentRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE user_id = ? AND docling_status = ?
             ORDER BY library_id, zotero_key`,
            [user_id, status]
        );
        return rows.map((row: any) => BeaverDB.rowToAttachmentRecord(row));
    }

    /**
     * Get a paginated list of attachments by Docling status for a user.
     * @param user_id User ID
     * @param status Docling status to filter by
     * @param limit Number of items per page
     * @param offset Number of items to skip
     * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
     */
    public async getAttachmentsByDoclingStatusPaginated(
        user_id: string,
        status: ProcessingStatus,
        limit: number,
        offset: number
    ): Promise<{ attachments: AttachmentRecord[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments 
             WHERE user_id = ? AND docling_status = ?
             ORDER BY library_id, zotero_key
             LIMIT ? OFFSET ?`,
            [user_id, status, limit + 1, offset]
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
        if (data.name !== undefined) record.name = data.name || null; // Convert empty string to null
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
     * @param name Optional name for the thread
     * @returns The complete ThreadData for the newly created thread
     */
    public async createThread(name: string = ''): Promise<ThreadData> {
        const id = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const dbName = name || null; // Convert empty string to null for database
        
        await this.conn.queryAsync(
            `INSERT INTO threads (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            [id, dbName, now, now]
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
     * @param id The ID of the thread to retrieve
     * @returns The ThreadData if found, otherwise null
     */
    public async getThread(id: string): Promise<ThreadData | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads WHERE id = ?`,
            [id]
        );
        if (rows.length === 0) {
            return null;
        }
        const record = BeaverDB.rowToThreadRecord(rows[0]);
        return BeaverDB.threadRecordToData(record);
    }

    /**
     * Get a paginated list of threads.
     * @param limit Number of threads per page
     * @param offset Number of threads to skip
     * @returns Object containing an array of ThreadData objects and a boolean indicating if there are more items
     */
    public async getThreadsPaginated(
        limit: number,
        offset: number
    ): Promise<{ threads: ThreadData[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
            [limit + 1, offset]
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
     * @param id The ID of the thread to delete
     */
    public async deleteThread(id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM threads WHERE id = ?`,
            [id]
        );
    }

    /**
     * Rename a thread.
     * @param id The ID of the thread to rename
     * @param name The new name for the thread
     */
    public async renameThread(id: string, name: string): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE threads SET name = ?, updated_at = datetime('now') WHERE id = ?`,
            [name, id]
        );
    }

    /**
     * Update a thread. Currently only supports renaming.
     * @param id The ID of the thread to update
     * @param updates An object containing the fields to update (using ThreadData format)
     */
    public async updateThread(
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

        values.push(id);
        
        await this.conn.queryAsync(
            `UPDATE threads SET ${fieldsToUpdate.join(', ')} WHERE id = ?`,
            values
        );
    }

    // --- Message Methods ---

    /**
     * Retrieve all messages from a specific thread, ordered by creation date.
     * @param threadId The ID of the thread
     * @returns An array of MessageModel objects
     */
    public async getMessagesFromThread(threadId: string): Promise<MessageModel[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`,
            [threadId]
        );
        return rows.map((row: any) => {
            const record = BeaverDB.rowToMessageRecord(row);
            return BeaverDB.messageRecordToModel(record);
        });
    }

    /**
     * Deletes the specified message and all subsequent messages in a thread.
     * @param thread_id ID of the thread to modify
     * @param message_id ID of the message to reset from
     * @param messages List of messages to operate on
     * @param keep_message If true, keeps the message with message_id and deletes only subsequent messages
     * @returns A list of the remaining messages in the thread
     */
    public async resetFromMessage(
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
            await this.deleteMessagesBatch(messageIdsToDelete);

            // Also update thread's updated_at timestamp
            await this.updateThread(thread_id, { 
                updatedAt: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
            });
        }

        // Return the remaining messages
        return messages.slice(0, deleteStartIndex);
    }

    /**
     * Upsert a message in the database.
     * Inserts a new message or updates an existing one based on the message ID.
     * @param message The complete message object to upsert
     */
    public async upsertMessage(message: MessageModel): Promise<void> {
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
            `INSERT INTO messages (id, thread_id, role, content, reasoning_content, tool_calls, reader_state, attachments, tool_request, status, created_at, metadata, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
             ON CONFLICT(id) DO UPDATE SET
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
            [id, thread_id, role, content, reasoning_content, tool_calls, reader_state, attachments, tool_request, status, created_at, metadata, error]
        );
    }

    /**
     * Update an existing message.
     * @param id The ID of the message to update
     * @param updates A partial message object with fields to update
     */
    public async updateMessage(id: string, updates: Partial<MessageModel>): Promise<void> {
        const recordUpdates: any = { ...updates };

        if (updates.tool_calls !== undefined) recordUpdates.tool_calls = JSON.stringify(updates.tool_calls);
        if (updates.reader_state !== undefined) recordUpdates.reader_state = JSON.stringify(updates.reader_state);
        if (updates.attachments !== undefined) recordUpdates.attachments = JSON.stringify(updates.attachments);
        if (updates.tool_request !== undefined) recordUpdates.tool_request = JSON.stringify(updates.tool_request);
        if (updates.metadata !== undefined) recordUpdates.metadata = JSON.stringify(updates.metadata);

        const fieldsToUpdate = Object.keys(recordUpdates).filter(key => key !== 'id' && key !== 'thread_id' && key !== 'created_at');

        if (fieldsToUpdate.length === 0) {
            return; // Nothing to update
        }

        const setClauses = fieldsToUpdate.map(field => `${field} = ?`).join(', ');
        const values = fieldsToUpdate.map(field => (recordUpdates as any)[field]);
        values.push(id);

        const query = `UPDATE messages SET ${setClauses} WHERE id = ?`;
        await this.conn.queryAsync(query, values);
    }

    /**
     * Delete a message by its ID.
     * @param id The ID of the message to delete
     */
    public async deleteMessage(id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM messages WHERE id = ?`,
            [id]
        );
    }

    /**
     * Delete multiple messages by their IDs in a single transaction.
     * @param ids The IDs of the messages to delete
     */
    public async deleteMessagesBatch(ids: string[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }

        const placeholders = ids.map(() => '?').join(',');
        
        await this.conn.queryAsync(
            `DELETE FROM messages WHERE id IN (${placeholders})`,
            ids
        );
    }

    /**
     * Retrieve a message by its ID.
     * @param id The ID of the message to retrieve
     * @returns The MessageModel if found, otherwise null
     */
    public async getMessage(id: string): Promise<MessageModel | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM messages WHERE id = ?`,
            [id]
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

    await db.updateAttachment(1, "ATTACHKEY456", { md_status: "embedded", file_hash: "fileHashUpdated" });
    const updatedAttachment = await db.getAttachmentByZoteroKey(1, "ATTACHKEY456");
    console.log("Updated attachment:", updatedAttachment);

    // await db.closeDatabase(); // Close when done
})();
*/ 