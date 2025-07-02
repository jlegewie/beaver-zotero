declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare namespace Zotero {
    namespace Beaver {
        const pluginVersion: string;

        const db: {
            /**
             * Initialize the database by creating tables if they don't exist.
             * Should be called once after constructing the class.
             */
            initDatabase(): Promise<void>;

            /**
             * Close the database connection.
             */
            closeDatabase(): Promise<void>;

            /**
             * Insert a record into the 'items' table.
             * @param user_id User ID for the item
             * @param item Data for the new item record. 'id' will be generated.
             * @returns The generated 'id' of the inserted item.
             */
            insertItem(user_id: string, item: Omit<import("../src/services/database").ItemRecord, 'id' | 'user_id'>): Promise<string>;

            /**
             * Insert multiple records into the 'items' table in a single transaction.
             * @param user_id User ID for the items
             * @param items An array of item data. 'id' will be generated for each.
             * @returns An array of the generated 'id's for the inserted items.
             */
            insertItemsBatch(user_id: string, items: Omit<import("../src/services/database").ItemRecord, 'id' | 'user_id'>[]): Promise<string[]>;

            /**
             * Insert a record into the 'attachments' table.
             * Optional fields default to initial states ('pending', 'unavailable', null).
             * @param user_id User ID for the attachment
             * @param attachment Data for the new attachment. 'id' will be generated.
             * @returns The generated 'id' of the inserted attachment.
             */
            insertAttachment(
                user_id: string,
                attachment: Pick<import("../src/services/database").AttachmentRecord, 'library_id' | 'zotero_key' | 'attachment_metadata_hash'> & 
                           Partial<Omit<import("../src/services/database").AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key' | 'attachment_metadata_hash'>>
            ): Promise<string>;

            /**
             * Update an existing item record identified by user_id, library_id and zotero_key.
             * Only 'item_metadata_hash' can be updated.
             * @param user_id The user_id of the item.
             * @param libraryId The library_id of the item.
             * @param zoteroKey The zotero_key of the item.
             * @param updates An object containing the fields to update.
             */
            updateItem(
                user_id: string,
                libraryId: number,
                zoteroKey: string,
                updates: Partial<Pick<import("../src/services/database").ItemRecord, 'item_metadata_hash'>>
            ): Promise<void>;

            /**
             * Update an existing attachment record identified by user_id, library_id and zotero_key.
             * @param user_id The user_id of the attachment.
             * @param libraryId The library_id of the attachment.
             * @param zoteroKey The zotero_key of the attachment.
             * @param updates An object containing the fields to update.
             */
            updateAttachment(
                user_id: string,
                libraryId: number,
                zoteroKey: string,
                updates: Partial<Omit<import("../src/services/database").AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key'>>
            ): Promise<void>;

            /**
             * Update an existing item record or insert a new one if it doesn't exist.
             * @param user_id User ID for the item
             * @param item Data for the item record. Requires 'library_id', 'zotero_key', 'item_metadata_hash'.
             * @returns The internal 'id' of the upserted item.
             */
            upsertItem(user_id: string, item: Omit<import("../src/services/database").ItemRecord, 'id' | 'user_id'>): Promise<string>;

            /**
             * Upsert multiple item records in a single transaction.
             * Inserts items that don't exist, updates items where 'item_metadata_hash' has changed.
             * @param user_id User ID for the items
             * @param items An array of item data. Requires 'library_id', 'zotero_key', 'item_metadata_hash'.
             * @returns An array of the internal 'id's corresponding to the input items (either existing or newly inserted).
             */
            upsertItemsBatch(user_id: string, items: Omit<import("../src/services/database").ItemRecord, 'id' | 'user_id'>[]): Promise<string[]>;

            /**
             * Retrieve an item record by its user_id, library_id and zotero_key.
             * @param user_id The user_id of the item.
             * @param libraryId The library_id of the item.
             * @param zoteroKey The zotero_key of the item.
             * @returns The ItemRecord if found, otherwise null.
             */
            getItemByZoteroKey(user_id: string, libraryId: number, zoteroKey: string): Promise<import("../src/services/database").ItemRecord | null>;

            /**
             * Retrieve an attachment record by its user_id, library_id and zotero_key.
             * @param user_id The user_id of the attachment.
             * @param libraryId The library_id of the attachment.
             * @param zoteroKey The zotero_key of the attachment.
             * @returns The AttachmentRecord if found, otherwise null.
             */
            getAttachmentByZoteroKey(user_id: string, libraryId: number, zoteroKey: string): Promise<import("../src/services/database").AttachmentRecord | null>;

            /**
             * Retrieve an upload queue record by its user_id, library_id and zotero_key.
             * @param user_id The user_id of the queue item.
             * @param libraryId The library_id of the representative attachment.
             * @param zoteroKey The zotero_key of the representative attachment.
             * @returns The UploadQueueRecord if found, otherwise null.
             */
            getUploadQueueRecordByZoteroKey(user_id: string, libraryId: number, zoteroKey: string): Promise<import("../src/services/database").UploadQueueRecord | null>;

            /**
             * Retrieve an upload queue record by its user_id and file_hash.
             * @param user_id The user_id of the queue item.
             * @param file_hash The file_hash of the queue item.
             * @returns The UploadQueueRecord if found, otherwise null.
             */
            getUploadQueueRecordByFileHash(user_id: string, file_hash: string): Promise<import("../src/services/database").UploadQueueRecord | null>;

            /**
             * Upsert multiple attachment records in a single transaction.
             * Inserts attachments that don't exist, updates attachments where fields have changed.
             * @param user_id User ID for the attachments
             * @param attachments An array of attachment data. Requires 'library_id', 'zotero_key', 'attachment_metadata_hash'.
             * @returns An array of the internal 'id's corresponding to the input attachments (either existing or newly inserted).
             */
            upsertAttachmentsBatch(
                user_id: string, 
                attachments: (Pick<import("../src/services/database").AttachmentRecord, 'library_id' | 'zotero_key' | 'attachment_metadata_hash'> & 
                             Partial<Omit<import("../src/services/database").AttachmentRecord, 'id' | 'user_id' | 'library_id' | 'zotero_key' | 'attachment_metadata_hash'>>)[]
            ): Promise<string[]>;

            /**
             * Delete an item record by user_id, library_id and zotero_key.
             * @param user_id The user_id of the item to delete.
             * @param libraryId The library_id of the item to delete.
             * @param zoteroKey The zotero_key of the item to delete.
             */
            deleteItem(user_id: string, libraryId: number, zoteroKey: string): Promise<void>;

            /**
             * Delete an attachment record by user_id, library_id and zotero_key.
             * @param user_id The user_id of the attachment to delete.
             * @param libraryId The library_id of the attachment to delete.
             * @param zoteroKey The zotero_key of the attachment to delete.
             */
            deleteAttachment(user_id: string, libraryId: number, zoteroKey: string): Promise<void>;

            /**
             * Delete a record from either items or attachments table by user_id, library_id and zotero_key.
             * Use this method when you don't know which table contains the record.
             * @param user_id The user_id of the record to delete.
             * @param libraryId The library_id of the record to delete.
             * @param zoteroKey The zotero_key of the record to delete.
             */
            deleteByLibraryAndKey(user_id: string, libraryId: number, zoteroKey: string): Promise<void>;

            /**
             * Delete multiple records from either items or attachments table by user_id, library_id and zotero_keys.
             * Use this method when you don't know which table contains the records.
             * @param user_id The user_id of the records to delete.
             * @param libraryId The library_id of the records to delete.
             * @param zoteroKeys Array of zotero_keys of the records to delete.
             */
            deleteByLibraryAndKeys(user_id: string, libraryId: number, zoteroKeys: string[]): Promise<void>;

            /**
             * Retrieve multiple item records by their user_id, library_id and zotero_keys.
             * @param user_id The user_id of the items.
             * @param libraryId The library_id of the items.
             * @param zoteroKeys Array of zotero_keys to retrieve.
             * @returns Array of ItemRecord objects found, empty array if none found.
             */
            getItemsByZoteroKeys(user_id: string, libraryId: number, zoteroKeys: string[]): Promise<import("../src/services/database").ItemRecord[]>;

            /**
             * Retrieve multiple attachment records by their user_id, library_id and zotero_keys.
             * @param user_id The user_id of the attachments.
             * @param libraryId The library_id of the attachments.
             * @param zoteroKeys Array of zotero_keys to retrieve.
             * @returns Array of AttachmentRecord objects found, empty array if none found.
             */
            getAttachmentsByZoteroKeys(user_id: string, libraryId: number, zoteroKeys: string[]): Promise<import("../src/services/database").AttachmentRecord[]>;

            /**
             * Get comprehensive upload statistics
             * @param user_id User ID
             * @returns Upload statistics
             */
            getAttachmentUploadStatistics(user_id: string): Promise<import("../src/services/database").AttachmentUploadStatistics>;

            /**
             * Get the next batch of items from the upload queue and claim them for processing.
             * @param user_id User ID
             * @param limit Maximum number of items to return
             * @param maxAttempts Maximum upload attempts before an item is no longer considered for upload via this method
             * @param visibilityTimeoutMinutes How long to claim the items for (in minutes)
             * @returns Array of upload queue records ready for processing
             */
            readQueueItems(
                user_id: string,
                limit?: number,
                maxAttempts?: number,
                visibilityTimeoutMinutes?: number
            ): Promise<import("../src/services/database").UploadQueueRecord[]>;

            /**
             * Mark an item in the upload queue as completed.
             * This involves deleting it from 'upload_queue' and updating 'attachments'.
             * @param user_id User ID
             * @param file_hash The file_hash of the completed item
             * @returns boolean indicating whether the queue item was found and processed
             */
            completeQueueItem(user_id: string, file_hash: string): Promise<boolean>;

            /**
             * Mark an item in the upload queue as failed.
             * This involves deleting it from 'upload_queue' and updating 'attachments'.
             * @param user_id User ID
             * @param file_hash The file_hash of the failed item
             * @param status Optional. The status to update the upload to. Defaults to 'failed'.
             */
            failQueueItem(user_id: string, file_hash: string, status?: import("../src/services/attachmentsService").UploadStatus): Promise<void>;

            /**
             * Upsert a single record into the 'upload_queue' table.
             * If a record with the same user_id and file_hash exists, it's updated. Otherwise, a new record is inserted.
             * For inserts: queue_visibility defaults to current time, attempt_count defaults to 0 if not provided.
             * For updates: queue_visibility and attempt_count are only updated if explicitly provided.
             * @param user_id User ID for the queue item.
             * @param item Data for the upload_queue record.
             */
            upsertQueueItem(
                user_id: string,
                item: import("../src/services/database").UploadQueueInput
            ): Promise<void>;

            /**
             * Upsert multiple upload_queue records in a single transaction.
             * Items without a valid file_hash will be filtered out before insertion.
             * For inserts: queue_visibility defaults to current time, attempt_count defaults to 0 if not provided.
             * For updates: queue_visibility and attempt_count are only updated if explicitly provided.
             * @param user_id User ID for the queue items
             * @param items An array of queue item data.
             */
            upsertQueueItemsBatch(user_id: string, items: import("../src/services/database").UploadQueueInput[]): Promise<void>;

            /**
             * Reset uploads by setting their status to pending and adding them back to the upload queue.
             * @param user_id User ID
             * @param items Array of UploadQueueInput objects containing file_hash, library_id, and zotero_key
             */
            resetUploads(user_id: string, items: import("../src/services/database").UploadQueueInput[]): Promise<void>;

            /**
             * Get the total number of unique files in the upload queue for a user
             * This represents the total work for an upload session
             * @param user_id User ID
             * @returns Number of unique file hashes in upload queue
             */
            getTotalQueueItems(user_id: string): Promise<number>;

            /**
             * Set visibility timeout for queue items
             * @param user_id User ID
             * @param file_hash File hash of the item
             * @param timeoutMinutes Timeout in minutes
             */
            setQueueItemTimeout(user_id: string, file_hash: string, timeoutMinutes: number): Promise<void>;

            /**
             * Get all attachments with failed upload status for a user
             * @param user_id User ID
             * @returns Array of AttachmentRecord objects with failed upload status
             */
            getFailedAttachments(user_id: string): Promise<import("../src/services/database").AttachmentRecord[]>;

            /**
             * Get paginated failed attachments for a user
             * @param user_id User ID
             * @param limit Number of items per page
             * @param offset Number of items to skip
             * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
             */
            getFailedAttachmentsPaginated(user_id: string, limit: number, offset: number): Promise<{ attachments: import("../src/services/database").AttachmentRecord[]; has_more: boolean }>;

            /**
             * Get all attachments by upload status for a user
             * @param user_id User ID
             * @param status Upload status to filter by
             * @returns Array of AttachmentRecord objects
             */
            getAttachmentsByUploadStatus(user_id: string, status: import("../src/services/attachmentsService").UploadStatus): Promise<import("../src/services/database").AttachmentRecord[]>;

            /**
             * Get a paginated list of attachments by upload status for a user.
             * @param user_id User ID
             * @param status Upload status to filter by
             * @param limit Number of items per page
             * @param offset Number of items to skip
             * @returns Object containing an array of AttachmentRecord objects and a boolean indicating if there are more items
             */
            getAttachmentsByUploadStatusPaginated(user_id: string, status: import("../src/services/attachmentsService").UploadStatus, limit: number, offset: number): Promise<import("../src/services/attachmentsService").AttachmentStatusPagedResponse>;

            /**
             * Fix pending attachments without queue entries
             * @param user_id User ID
             * @returns Number of attachments fixed
             */
            fixPendingAttachmentsWithoutQueue(user_id: string): Promise<number>;

            // --- Thread Methods ---

            /**
             * Create a new chat thread.
             * @param name Optional name for the thread
             * @returns The complete ThreadData for the newly created thread
             */
            createThread(name?: string): Promise<import("../react/types/chat/uiTypes").ThreadData>;

            /**
             * Retrieve a thread by its ID.
             * @param id The ID of the thread to retrieve
             * @returns The ThreadData if found, otherwise null
             */
            getThread(id: string): Promise<import("../react/types/chat/uiTypes").ThreadData | null>;

            /**
             * Get a paginated list of threads.
             * @param limit Number of threads per page
             * @param offset Number of threads to skip
             * @returns Object containing an array of ThreadData objects and a boolean indicating if there are more items
             */
            getThreadsPaginated(
                limit: number,
                offset: number
            ): Promise<{ threads: import("../react/types/chat/uiTypes").ThreadData[]; has_more: boolean }>;

            /**
             * Delete a thread and all its messages.
             * @param id The ID of the thread to delete
             */
            deleteThread(id: string): Promise<void>;

            /**
             * Rename a thread.
             * @param id The ID of the thread to rename
             * @param name The new name for the thread
             */
            renameThread(id: string, name: string): Promise<void>;

            /**
             * Update a thread. Currently only supports renaming.
             * @param id The ID of the thread to update
             * @param updates An object containing the fields to update (using ThreadData format)
             */
            updateThread(
                id: string,
                updates: Partial<Omit<import("../react/types/chat/uiTypes").ThreadData, 'id' | 'createdAt'>>
            ): Promise<void>;

            // --- Message Methods ---

            /**
             * Retrieve all messages from a specific thread, ordered by creation date.
             * @param threadId The ID of the thread
             * @returns An array of MessageModel objects
             */
            getMessagesFromThread(threadId: string): Promise<import("../react/types/chat/apiTypes").MessageModel[]>;

            /**
             * Reset a thread from a specific message.
             * @param thread_id The ID of the thread
             * @param message_id The ID of the message to reset from
             * @param messages List of messages to operate on
             * @param keep_message If true, keeps the message with message_id and deletes only subsequent messages
             */
            resetFromMessage(
                thread_id: string,
                message_id: string,
                messages: import("../react/types/chat/apiTypes").MessageModel[],
                keep_message: boolean
            ): Promise<import("../react/types/chat/apiTypes").MessageModel[]>;

            /**
             * Upsert a message in the database.
             * Inserts a new message or updates an existing one based on the message ID.
             * @param message The complete message object to upsert
             */
            upsertMessage(message: import("../react/types/chat/apiTypes").MessageModel): Promise<void>;

            /**
             * Update an existing message.
             * @param id The ID of the message to update
             * @param updates A partial message object with fields to update
             */
            updateMessage(id: string, updates: Partial<import("../react/types/chat/apiTypes").MessageModel>): Promise<void>;

            /**
             * Delete a message by its ID.
             * @param id The ID of the message to delete
             */
            deleteMessage(id: string): Promise<void>;

            /**
             * Retrieve a message by its ID.
             * @param id The ID of the message to retrieve
             * @returns The MessageModel if found, otherwise null
             */
            getMessage(id: string): Promise<import("../react/types/chat/apiTypes").MessageModel | null>;
        }

        /**
         * Citation object for CSL formatting
         */
        type Citation = {
            id: number;
            locator?: string;
            label?: string;
            prefix?: string;
            suffix?: string;
            suppressAuthor?: boolean;
            authorOnly?: boolean;
        }

        /**
         * Citation service for formatting citations using CSL
         */
        const citationService: {
            /**
             * Format an in-text citation for Zotero items
             * @param items Single Zotero item or array of items to format
             * @param clean If true, removes parentheses and normalizes quotes
             * @returns Formatted in-text citation or empty string on error
             */
            formatCitation(items: Zotero.Item | Zotero.Item[], clean?: boolean): string;

            /**
             * Format an in-text citation for citation objects
             * @param citationItems Array of citation objects to format
             * @param clean If true, removes parentheses and normalizes quotes
             * @returns Formatted in-text citation or empty string on error
             */
            formatCitation(citationItems: Citation[], clean?: boolean): string;

            /**
             * Format multiple items as a bibliography entry
             * @param items Single Zotero item or array of items
             * @param format Output format - "text" or "html"
             * @returns Formatted bibliography or empty string on error
             */
            formatBibliography(items: Zotero.Item | Zotero.Item[], format?: "text" | "html"): string;

            /**
             * Force recreation of the CSL engine on next use
             * Call this when preferences change
             */
            reset(): void;

            /**
             * Free resources when the service is no longer needed
             * Call during plugin shutdown
             */
            dispose(): void;
        }
    }

    interface Item {
        /**
         * Determine whether the item or any of its ancestors is in the trash
         *
         * @return {Boolean}
         */
        isInTrash(): boolean;
    }

    interface Utilities {
        Internal: {
            /**
             * Compress text content using gzip
             * @param textContent The text content to compress
             * @returns Promise that resolves to the compressed content
             */
            gzip(textContent: string): Promise<string>;
        }
    }
}

declare namespace Zotero {
    namespace BetterBibTeX {
        /**
         * Better BibTeX KeyManager API
         */
        const KeyManager: {
            /**
             * Get citation key information for a Zotero item
             * @param itemID - The Zotero item ID (number)
             * @returns Object containing citation key and metadata
             */
            get(itemID: number): {
                citationKey: string;
                pinned?: boolean;
                itemID?: number;
                libraryID?: number;
                itemKey?: string;
                lcCitationKey?: string;
                retry?: boolean;
            };

            /**
             * Find first citation key record matching query
             */
            first(query: any): any;

            /**
             * Find all citation key records matching query
             */
            find(query: any): any[];

            /**
             * Get all citation key records
             */
            all(): any[];

            /**
             * Update/generate citation key for an item
             */
            update(item: Zotero.Item): string;
        };
    }
}