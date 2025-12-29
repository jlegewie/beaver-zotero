
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

declare const ZOTERO_CONFIG: {
    API_URL: string;
    API_VERSION: string;
};

declare namespace Zotero {
    /** Shared Jotai store for Beaver plugin across all windows */
    let __beaverJotaiStore: any;

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
            createThread(user_id: string, name?: string): Promise<import("../react/atoms/threads").ThreadData>;

            /**
             * Retrieve a thread by its ID.
             * @param user_id The user_id of the thread
             * @param id The ID of the thread to retrieve
             * @returns The ThreadData if found, otherwise null
             */
            getThread(user_id: string, id: string): Promise<import("../react/atoms/threads").ThreadData | null>;

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
            ): Promise<{ threads: import("../react/atoms/threads").ThreadData[]; has_more: boolean }>;

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
                updates: Partial<Omit<import("../react/atoms/threads").ThreadData, 'id' | 'createdAt'>>
            ): Promise<void>;

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

            // --- Embedding Methods ---

            /**
             * Insert or update an embedding record.
             * @param embedding The embedding data to store
             */
            upsertEmbedding(embedding: Omit<import("../src/services/database").EmbeddingRecord, 'indexed_at'> & { indexed_at?: string }): Promise<void>;

            /**
             * Insert or update multiple embedding records in a batch.
             * @param embeddings Array of embedding data to store
             */
            upsertEmbeddingsBatch(embeddings: Array<Omit<import("../src/services/database").EmbeddingRecord, 'indexed_at'> & { indexed_at?: string }>): Promise<void>;

            /**
             * Get an embedding record by item ID.
             * @param itemId The Zotero item ID
             * @returns The embedding record or null if not found
             */
            getEmbedding(itemId: number): Promise<import("../src/services/database").EmbeddingRecord | null>;

            /**
             * Get embedding records for multiple item IDs.
             * @param itemIds Array of Zotero item IDs
             * @returns Map of item ID to embedding record
             */
            getEmbeddingsBatch(itemIds: number[]): Promise<Map<number, import("../src/services/database").EmbeddingRecord>>;

            /**
             * Get all embeddings for a library.
             * @param libraryId The Zotero library ID
             * @returns Array of embedding records
             */
            getEmbeddingsByLibrary(libraryId: number): Promise<import("../src/services/database").EmbeddingRecord[]>;

            /**
             * Get all embeddings across all libraries.
             * @returns Array of embedding records
             */
            getAllEmbeddings(): Promise<import("../src/services/database").EmbeddingRecord[]>;

            /**
             * Get embeddings for multiple libraries.
             * @param libraryIds Array of library IDs
             * @returns Array of embedding records
             */
            getEmbeddingsByLibraries(libraryIds: number[]): Promise<import("../src/services/database").EmbeddingRecord[]>;

            /**
             * Get content hashes for items to check what needs re-indexing.
             * @param itemIds Array of Zotero item IDs
             * @returns Map of item ID to content hash
             */
            getContentHashes(itemIds: number[]): Promise<Map<number, string>>;

            /**
             * Delete an embedding by item ID.
             * @param itemId The Zotero item ID
             */
            deleteEmbedding(itemId: number): Promise<void>;

            /**
             * Delete embeddings for multiple item IDs.
             * @param itemIds Array of Zotero item IDs
             */
            deleteEmbeddingsBatch(itemIds: number[]): Promise<void>;

            /**
             * Delete all embeddings for a library.
             * @param libraryId The Zotero library ID
             */
            deleteEmbeddingsByLibrary(libraryId: number): Promise<void>;

            /**
             * Get the count of embeddings for a library.
             * @param libraryId The Zotero library ID (optional - if not provided, returns total count)
             * @returns Number of embeddings
             */
            getEmbeddingCount(libraryId?: number): Promise<number>;

            /**
             * Get item IDs that have embeddings in a library.
             * @param libraryId The Zotero library ID (optional - if not provided, returns all embedded item IDs)
             * @returns Array of item IDs
             */
            getEmbeddedItemIds(libraryId?: number): Promise<number[]>;

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

    interface Exception {
        UnloadedDataException: new (...args: any[]) => Error;
    }

    interface Prompt {
        confirm(options: {
            window: any;
            title: string;
            text: string;
            button0?: string;
            button1?: string;
            button2?: string;
            defaultButton?: number;
        }): number;

        BUTTON_TITLE_YES: string;
        BUTTON_TITLE_NO: string;
        BUTTON_TITLE_CANCEL: string;
        BUTTON_TITLE_OK: string;
    }
    const Exception: Exception;
    const Prompt: Prompt;
}

declare namespace Zotero {
    namespace Profile {
        const dir: string;
    }
    
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


declare namespace _ZoteroTypes {
    interface HTTP {
        UnexpectedStatusException: new (...args: any[]) => Error;
        BrowserOfflineException: new (...args: any[]) => Error;
        TimeoutException: new (...args: any[]) => Error;
        SecurityException: new (...args: any[]) => Error;
    }

    interface Zotero {
        /** Shared Jotai store for Beaver plugin across all windows */
        __beaverJotaiStore?: import('jotai').createStore extends () => infer R ? R : never;
    }
}