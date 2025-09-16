
declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare interface SymbolConstructor {
  readonly observable: symbol;
}

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

        const data: {
            env: "development" | "production";
        };

        const db: {
            /**
             * Initialize the database by creating tables if they don't exist.
             * Should be called once after constructing the class.
             */
            initDatabase(pluginVersion: string): Promise<void>;

            /**
             * Close the database connection.
             */
            closeDatabase(): Promise<void>;

            /**
             * Create a new chat thread.
             * @param user_id The user_id of the thread
             * @param name Optional name for the thread
             * @returns The complete ThreadData for the newly created thread
             */
            createThread(user_id: string, name?: string): Promise<import("../react/types/chat/uiTypes").ThreadData>;

            /**
             * Retrieve a thread by its ID.
             * @param user_id The user_id of the thread
             * @param id The ID of the thread to retrieve
             * @returns The ThreadData if found, otherwise null
             */
            getThread(user_id: string, id: string): Promise<import("../react/types/chat/uiTypes").ThreadData | null>;

            /**
             * Get a paginated list of threads.
             * @param user_id The user_id of the threads
             * @param limit Number of threads per page
             * @param offset Number of threads to skip
             * @returns Object containing an array of ThreadData objects and a boolean indicating if there are more items
             */
            getThreadsPaginated(
                user_id: string,
                limit: number,
                offset: number
            ): Promise<{ threads: import("../react/types/chat/uiTypes").ThreadData[]; has_more: boolean }>;

            /**
             * Delete a thread and all its messages.
             * @param user_id The user_id of the thread
             * @param id The ID of the thread to delete
             */
            deleteThread(user_id: string, id: string): Promise<void>;

            /**
             * Rename a thread.
             * @param user_id The user_id of the thread
             * @param id The ID of the thread to rename
             * @param name The new name for the thread
             */
            renameThread(user_id: string, id: string, name: string): Promise<void>;

            /**
             * Update a thread. Currently only supports renaming.
             * @param user_id The user_id of the thread
             * @param id The ID of the thread to update
             * @param updates An object containing the fields to update (using ThreadData format)
             */
            updateThread(
                user_id: string,
                id: string,
                updates: Partial<Omit<import("../react/types/chat/uiTypes").ThreadData, 'id' | 'createdAt'>>
            ): Promise<void>;

            // --- Message Methods ---

            /**
             * Retrieve all messages from a specific thread, ordered by creation date.
             * @param user_id The user_id of the thread
             * @param threadId The ID of the thread
             * @returns An array of MessageModel objects
             */
            getMessagesFromThread(user_id: string, threadId: string): Promise<import("../react/types/chat/apiTypes").MessageModel[]>;

            /**
             * Reset a thread from a specific message.
             * @param user_id The user_id of the thread
             * @param thread_id The ID of the thread
             * @param message_id The ID of the message to reset from
             * @param messages List of messages to operate on
             * @param keep_message If true, keeps the message with message_id and deletes only subsequent messages
             */
            resetFromMessage(
                user_id: string,
                thread_id: string,
                message_id: string,
                messages: import("../react/types/chat/apiTypes").MessageModel[],
                keep_message: boolean
            ): Promise<import("../react/types/chat/apiTypes").MessageModel[]>;

            /**
             * Upsert a message in the database.
             * Inserts a new message or updates an existing one based on the message ID.
             * @param user_id The user_id of the message
             * @param message The complete message object to upsert
             */
            upsertMessage(user_id: string, message: import("../react/types/chat/apiTypes").MessageModel): Promise<void>;

            /**
             * Update an existing message.
             * @param user_id The user_id of the message
             * @param id The ID of the message to update
             * @param updates A partial message object with fields to update
             */
            updateMessage(user_id: string, id: string, updates: Partial<import("../react/types/chat/apiTypes").MessageModel>): Promise<void>;

            /**
             * Delete a message by its ID.
             * @param id The ID of the message to delete
             */
            deleteMessage(user_id: string, id: string): Promise<void>;

            /**
             * Retrieve a message by its ID.
             * @param user_id The user_id of the message
             * @param id The ID of the message to retrieve
             * @returns The MessageModel if found, otherwise null
             */
            getMessage(user_id: string, id: string): Promise<import("../react/types/chat/apiTypes").MessageModel | null>;

            // --- Sync Logs Methods ---

            /**
             * Insert a new sync log record.
             * @param syncLog The sync log data to insert (without id, which will be generated)
             * @returns The complete SyncLogsRecord with generated id
             */
            insertSyncLog(syncLog: Omit<import("../src/services/database").SyncLogsRecord, 'id' | 'timestamp'>): Promise<import("../src/services/database").SyncLogsRecord>;

            /**
             * Get sync log record for library_id and user_id with the highest library_version.
             * @param user_id The user_id to filter by
             * @param library_id The library_id to filter by
             * @returns The SyncLogsRecord with highest library_version, or null if not found
             */
            getSyncLogWithHighestVersion(user_id: string, library_id: number): Promise<import("../src/services/database").SyncLogsRecord | null>;

            /**
             * Get sync log record for library_id and user_id with the most recent library_date_modified.
             * @param user_id The user_id to filter by
             * @param library_id The library_id to filter by
             * @returns The SyncLogsRecord with most recent library_date_modified, or null if not found
             */
            getSyncLogWithMostRecentDate(user_id: string, library_id: number): Promise<import("../src/services/database").SyncLogsRecord | null>;

            /**
             * Get all sync log records for specific library_id and user_id.
             * @param user_id The user_id to filter by
             * @param library_id The library_id to filter by
             * @param orderBy Optional ordering field ('timestamp', 'library_version', 'library_date_modified')
             * @param orderDirection Optional order direction ('ASC' or 'DESC')
             * @returns Array of SyncLogsRecord objects
             */
            getAllSyncLogsForLibrary(
                user_id: string, 
                library_id: number,
                orderBy?: 'timestamp' | 'library_version' | 'library_date_modified',
                orderDirection?: 'ASC' | 'DESC'
            ): Promise<import("../src/services/database").SyncLogsRecord[]>;

            /**
             * Get the most recent sync log record for specific library_ids and user_id.
             * @param user_id The user_id to filter by
             * @param library_ids The library_ids to filter by
             * @returns The SyncLogsRecord with most recent timestamp, or null if not found
             */
            getMostRecentSyncLogForLibraries(
                user_id: string,
                library_ids: number[]
            ): Promise<import("../src/services/database").SyncLogsRecord | null>;

            /**
             * Deletes all sync log records for a specific library.
             * @param user_id The user_id to filter by
             * @param library_id The library_id to delete logs for
             */
            deleteSyncLogsForLibraryIds(user_id: string, library_ids: number[]): Promise<void>;

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