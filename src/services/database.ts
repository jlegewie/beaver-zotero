import { v4 as uuidv4 } from 'uuid';
import { ProcessingStatus, UploadStatus } from './attachmentsService';

// Interface for the 'items' table row
export interface ItemRecord {
    id: string;
    user_id: string;
    library_id: number;
    zotero_key: string;
    item_metadata_hash: string;
}

// Interface for the 'attachments' table row
export interface AttachmentRecord {
    id: string;
    user_id: string;
    library_id: number;
    zotero_key: string;
    attachment_metadata_hash: string;
    file_hash: string | null;
    upload_status: UploadStatus | null;
    md_status: ProcessingStatus | null;
    docling_status: ProcessingStatus | null;
    md_error_code: string | null;
    docling_error_code: string | null;
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
                upload_status            TEXT,
                md_status                TEXT,
                docling_status           TEXT,
                md_error_code            TEXT,
                docling_error_code       TEXT,
                UNIQUE(user_id, library_id, zotero_key)
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
            upload_status: null,
            md_status: null,
            docling_status: null,
            md_error_code: null,
            docling_error_code: null,
        };
        const finalAttachment = { ...defaults, ...attachment };

        await this.conn.queryAsync(
            `INSERT INTO attachments (id, user_id, library_id, zotero_key, attachment_metadata_hash, file_hash, upload_status, md_status, docling_status, md_error_code, docling_error_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                user_id,
                finalAttachment.library_id,
                finalAttachment.zotero_key,
                finalAttachment.attachment_metadata_hash,
                finalAttachment.file_hash,
                finalAttachment.upload_status,
                finalAttachment.md_status,
                finalAttachment.docling_status,
                finalAttachment.md_error_code,
                finalAttachment.docling_error_code
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
            'upload_status',
            'md_status',
            'docling_status',
            'md_error_code',
            'docling_error_code'
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
            upload_status: row.upload_status as UploadStatus,
            md_status: row.md_status as ProcessingStatus,
            docling_status: row.docling_status as ProcessingStatus,
            md_error_code: row.md_error_code,
            docling_error_code: row.docling_error_code,
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
            upload_status: 'pending',
            md_status: 'unavailable',
            docling_status: 'unavailable',
            md_error_code: null,
            docling_error_code: null,
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
                    'file_hash', 'upload_status', 'md_status', 'docling_status', 'md_error_code', 'docling_error_code'
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
                const insertPlaceholders = attachmentsToInsert.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
                const insertValues: any[] = [];
                attachmentsToInsert.forEach(attachment => {
                    insertValues.push(
                        attachment.generatedId,
                        user_id,
                        attachment.library_id,
                        attachment.zotero_key,
                        attachment.attachment_metadata_hash,
                        attachment.file_hash,
                        attachment.upload_status,
                        attachment.md_status,
                        attachment.docling_status,
                        attachment.md_error_code,
                        attachment.docling_error_code
                    );
                });
                const insertQuery = `INSERT INTO attachments (id, user_id, library_id, zotero_key, attachment_metadata_hash, file_hash, upload_status, md_status, docling_status, md_error_code, docling_error_code) VALUES ${insertPlaceholders}`;
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
     * @returns boolean indicating whether an item was deleted.
     */
    public async deleteItem(user_id: string, libraryId: number, zoteroKey: string): Promise<boolean> {
        const result = await this.conn.queryAsync(
            `DELETE FROM items WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
            [user_id, libraryId, zoteroKey]
        );
        return result.changes > 0;
    }

    /**
     * Delete an attachment record by user_id, library_id and zotero_key.
     * @param user_id The user_id of the attachment to delete.
     * @param libraryId The library_id of the attachment to delete.
     * @param zoteroKey The zotero_key of the attachment to delete.
     * @returns boolean indicating whether an attachment was deleted.
     */
    public async deleteAttachment(user_id: string, libraryId: number, zoteroKey: string): Promise<boolean> {
        const result = await this.conn.queryAsync(
            `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
            [user_id, libraryId, zoteroKey]
        );
        return result.changes > 0;
    }

    /**
     * Delete a record from either items or attachments table by user_id, library_id and zotero_key.
     * Use this method when you don't know which table contains the record.
     * @param user_id The user_id of the record to delete.
     * @param libraryId The library_id of the record to delete.
     * @param zoteroKey The zotero_key of the record to delete.
     * @returns An object indicating which types of records were deleted and how many.
     */
    public async deleteByLibraryAndKey(user_id: string, libraryId: number, zoteroKey: string): Promise<{
        itemDeleted: boolean;
        attachmentDeleted: boolean;
    }> {
        const result = {
            itemDeleted: false,
            attachmentDeleted: false
        };
        
        // Execute both delete operations in a transaction for atomicity
        await this.conn.executeTransaction(async () => {
            const itemResult = await this.conn.queryAsync(
                `DELETE FROM items WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                [user_id, libraryId, zoteroKey]
            );
            
            const attachmentResult = await this.conn.queryAsync(
                `DELETE FROM attachments WHERE user_id = ? AND library_id = ? AND zotero_key = ?`,
                [user_id, libraryId, zoteroKey]
            );
            
            result.itemDeleted = itemResult.changes > 0;
            result.attachmentDeleted = attachmentResult.changes > 0;
        });
        
        return result;
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