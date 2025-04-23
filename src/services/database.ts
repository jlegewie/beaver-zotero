import { v4 as uuidv4 } from 'uuid';
import { ProcessingStatus, UploadStatus } from './attachmentsService';

// Interface for the 'items' table row
export interface ItemRecord {
    id: string;
    library_id: number;
    zotero_key: string;
    item_metadata_hash: string;
}

// Interface for the 'attachments' table row
export interface AttachmentRecord {
    id: string;
    library_id: number;
    zotero_key: string;
    attachment_metadata_hash: string;
    file_hash: string | null;
    upload_status: UploadStatus;
    md_status: ProcessingStatus;
    docling_status: ProcessingStatus;
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
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                item_metadata_hash       TEXT NOT NULL,
                UNIQUE(library_id, zotero_key)
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS attachments (
                id                       TEXT(36) PRIMARY KEY,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                attachment_metadata_hash TEXT NOT NULL,
                file_hash                TEXT,
                upload_status            TEXT NOT NULL DEFAULT 'pending',
                md_status                TEXT NOT NULL DEFAULT 'unavailable',
                docling_status           TEXT NOT NULL DEFAULT 'unavailable',
                md_error_code            TEXT,
                docling_error_code       TEXT,
                UNIQUE(library_id, zotero_key)
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
     * @param item Data for the new item record. 'id' will be generated.
     * @returns The generated 'id' of the inserted item.
     */
    public async insertItem(item: Omit<ItemRecord, 'id'>): Promise<string> {
        const id = uuidv4();
        await this.conn.queryAsync(
            `INSERT INTO items (id, library_id, zotero_key, item_metadata_hash)
             VALUES (?, ?, ?, ?)`,
            [
                id,
                item.library_id,
                item.zotero_key,
                item.item_metadata_hash
            ]
        );
        return id;
    }

    /**
     * Insert multiple records into the 'items' table in a single transaction.
     * @param items An array of item data. 'id' will be generated for each.
     * @returns An array of the generated 'id's for the inserted items.
     */
    public async insertItemsBatch(items: Omit<ItemRecord, 'id'>[]): Promise<string[]> {
        if (items.length === 0) {
            return [];
        }

        const generatedIds: string[] = items.map(() => uuidv4());
        const placeholders = items.map(() => '(?, ?, ?, ?)').join(', ');
        const values: any[] = [];
        items.forEach((item, index) => {
            values.push(
                generatedIds[index],
                item.library_id,
                item.zotero_key,
                item.item_metadata_hash
            );
        });

        const query = `INSERT INTO items (id, library_id, zotero_key, item_metadata_hash) VALUES ${placeholders}`;

        // Using executeTransaction ensures atomicity
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(query, values);
        });

        return generatedIds;
    }

    /**
     * Insert a record into the 'attachments' table.
     * Optional fields default to initial states ('pending', 'unavailable', null).
     * @param attachment Data for the new attachment. 'id' will be generated.
     *                   Requires 'library_id', 'zotero_key', 'attachment_metadata_hash'.
     * @returns The generated 'id' of the inserted attachment.
     */
    public async insertAttachment(
        attachment: Pick<AttachmentRecord, 'library_id' | 'zotero_key' | 'attachment_metadata_hash'> & Partial<Omit<AttachmentRecord, 'id' | 'library_id' | 'zotero_key' | 'attachment_metadata_hash'>>
    ): Promise<string> {
        const id = uuidv4();
        const defaults: Partial<AttachmentRecord> = {
            file_hash: null,
            upload_status: 'pending',
            md_status: 'unavailable',
            docling_status: 'unavailable',
            md_error_code: null,
            docling_error_code: null,
        };
        const finalAttachment = { ...defaults, ...attachment };

        await this.conn.queryAsync(
            `INSERT INTO attachments (id, library_id, zotero_key, attachment_metadata_hash, file_hash, upload_status, md_status, docling_status, md_error_code, docling_error_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
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
     * @param libraryId The library_id to match.
     * @param zoteroKey The zotero_key to match.
     * @param updates An object containing field-value pairs to update.
     * @param allowedFields List of fields allowed to be updated.
     */
    private async executeUpdate<T extends object>(
        table: 'items' | 'attachments',
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

        // Add library_id and zotero_key for the WHERE clause
        values.push(libraryId, zoteroKey);

        const query = `UPDATE ${table} SET ${setClauses} WHERE library_id = ? AND zotero_key = ?`;
        // Await is now allowed because the function is async
        await this.conn.queryAsync(query, values);
    }

    /**
     * Update an existing item record identified by library_id and zotero_key.
     * Only 'item_metadata_hash' can be updated.
     * @param libraryId The library_id of the item.
     * @param zoteroKey The zotero_key of the item.
     * @param updates An object containing the fields to update.
     */
    public async updateItem(
        libraryId: number,
        zoteroKey: string,
        updates: Partial<Pick<ItemRecord, 'item_metadata_hash'>>
    ): Promise<void> {
        const allowedFields: (keyof ItemRecord)[] = ['item_metadata_hash'];
        await this.executeUpdate<ItemRecord>('items', libraryId, zoteroKey, updates, allowedFields);
    }

    /**
     * Update an existing attachment record identified by library_id and zotero_key.
     * @param libraryId The library_id of the attachment.
     * @param zoteroKey The zotero_key of the attachment.
     * @param updates An object containing the fields to update.
     */
    public async updateAttachment(
        libraryId: number,
        zoteroKey: string,
        updates: Partial<Omit<AttachmentRecord, 'id' | 'library_id' | 'zotero_key'>>
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
        await this.executeUpdate<AttachmentRecord>('attachments', libraryId, zoteroKey, updates, allowedFields);
    }

    /**
     * Update an existing item record or insert a new one if it doesn't exist.
     * @param item Data for the item record. Requires 'library_id', 'zotero_key', 'item_metadata_hash'.
     * @returns The internal 'id' of the upserted item.
     */
    public async upsertItem(item: Omit<ItemRecord, 'id'>): Promise<string> {
        const existingItem = await this.getItemByZoteroKey(item.library_id, item.zotero_key);
        if (existingItem) {
            // Only update if the hash is different to avoid unnecessary writes
            if (existingItem.item_metadata_hash !== item.item_metadata_hash) {
                 await this.updateItem(item.library_id, item.zotero_key, { item_metadata_hash: item.item_metadata_hash });
            }
            return existingItem.id;
        } else {
            const newId = await this.insertItem(item);
            return newId;
        }
    }

    /**
     * Upsert multiple item records in a single transaction.
     * Inserts items that don't exist, updates items where 'item_metadata_hash' has changed.
     * @param items An array of item data. Requires 'library_id', 'zotero_key', 'item_metadata_hash'.
     * @returns An array of the internal 'id's corresponding to the input items (either existing or newly inserted).
     */
    public async upsertItemsBatch(items: Omit<ItemRecord, 'id'>[]): Promise<string[]> {
        if (items.length === 0) {
            return [];
        }

        const finalIds: string[] = [];
        const itemsToInsert: (Omit<ItemRecord, 'id'> & { generatedId: string })[] = [];
        const itemsToUpdate: { libraryId: number; zoteroKey: string; item_metadata_hash: string }[] = [];
        const itemMap = new Map<string, Omit<ItemRecord, 'id'>>(); // Key: "libraryId-zoteroKey"
        items.forEach(item => itemMap.set(`${item.library_id}-${item.zotero_key}`, item));

        // 1. Fetch existing items matching the batch
        const keys = items.map(item => [item.library_id, item.zotero_key]);
        // Construct IN clause placeholders: ((?,?), (?,?), ...)
        const placeholders = keys.map(() => '(?,?)').join(',');
        const values = keys.flat();
        const query = `SELECT * FROM items WHERE (library_id, zotero_key) IN (VALUES ${placeholders})`;
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
                const insertPlaceholders = itemsToInsert.map(() => '(?, ?, ?, ?)').join(', ');
                const insertValues: any[] = [];
                itemsToInsert.forEach(item => {
                    insertValues.push(
                        item.generatedId,
                        item.library_id,
                        item.zotero_key,
                        item.item_metadata_hash
                    );
                });
                const insertQuery = `INSERT INTO items (id, library_id, zotero_key, item_metadata_hash) VALUES ${insertPlaceholders}`;
                await this.conn.queryAsync(insertQuery, insertValues);
            }

            // Updates (individually within the transaction)
            for (const update of itemsToUpdate) {
                 await this.conn.queryAsync(
                     `UPDATE items SET item_metadata_hash = ? WHERE library_id = ? AND zotero_key = ?`,
                     [update.item_metadata_hash, update.libraryId, update.zoteroKey]
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
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            item_metadata_hash: row.item_metadata_hash,
        };
    }

    /**
     * Retrieve an item record by its library_id and zotero_key.
     * @param libraryId The library_id of the item.
     * @param zoteroKey The zotero_key of the item.
     * @returns The ItemRecord if found, otherwise null.
     */
    public async getItemByZoteroKey(libraryId: number, zoteroKey: string): Promise<ItemRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM items WHERE library_id = ?1 AND zotero_key = ?2`,
            [libraryId, zoteroKey]
        );
        return rows.length === 0 ? null : BeaverDB.rowToItemRecord(rows[0]);
    }

    /**
    * Helper method to construct AttachmentRecord from a database row
    */
    private static rowToAttachmentRecord(row: any): AttachmentRecord {
         return {
            id: row.id,
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
     * Retrieve an attachment record by its library_id and zotero_key.
     * @param libraryId The library_id of the attachment.
     * @param zoteroKey The zotero_key of the attachment.
     * @returns The AttachmentRecord if found, otherwise null.
     */
    public async getAttachmentByZoteroKey(libraryId: number, zoteroKey: string): Promise<AttachmentRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM attachments WHERE library_id = ?1 AND zotero_key = ?2`,
            [libraryId, zoteroKey]
        );
         return rows.length === 0 ? null : BeaverDB.rowToAttachmentRecord(rows[0]);
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