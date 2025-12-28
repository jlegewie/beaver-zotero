import { BeaverDB, EmbeddingRecord } from './database';
import { embeddingsService } from './embeddingsService';
import { getClientDateModifiedAsISOString } from '../utils/zoteroUtils';
import { logger } from '../utils/logger';


/**
 * Minimum combined length of title + abstract required for indexing.
 * Items with less content are skipped.
 */
export const MIN_CONTENT_LENGTH = 50;

/**
 * Default batch size for embedding API requests
 */
export const INDEX_BATCH_SIZE = 100;

/**
 * Lightweight metadata for sorting and batching items without loading full item data.
 * This allows efficient processing of large libraries.
 */
export interface ItemIndexMetadata {
    itemId: number;
    libraryId: number;
    clientDateModified: string;
}

/**
 * Data required to index a Zotero item for semantic search
 */
export interface ItemIndexData {
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    version: number;
    title: string;
    abstract: string;
    clientDateModified?: string;
}

/**
 * Result of determining which items need indexing
 */
export interface IndexingDiff {
    toIndex: number[];              // Item IDs that need (re-)indexing
    toDelete: number[];             // Item IDs whose embeddings should be deleted
    totalIndexable: number;         // Total number of indexable items in library
}

/**
 * Result of an indexing operation
 */
export interface IndexingResult {
    indexed: number;        // Number of items successfully indexed
    skipped: number;        // Number of items skipped (no content or unchanged)
    failed: number;         // Number of items that failed
    totalTokens: number;    // Total tokens used for embedding generation
}

/**
 * Service for indexing Zotero items with embeddings for semantic search.
 * Handles embedding generation, storage, and change detection.
 */
export class EmbeddingIndexer {
    private db: BeaverDB;
    private dimensions: number;
    private modelId: string;

    /**
     * Creates a new EmbeddingIndexer instance
     * @param db The BeaverDB instance for storing embeddings
     * @param dimensions Embedding dimensions (256 or 512, default: 512)
     */
    constructor(db: BeaverDB, dimensions: number = 512) {
        this.db = db;
        this.dimensions = dimensions;
        this.modelId = `voyage-3-int8-${dimensions}`;
    }

    /**
     * Build the text content for embedding from title and abstract.
     * @param title Item title
     * @param abstract Item abstract
     * @returns Combined text for embedding
     */
    private buildEmbeddingText(title: string, abstract: string): string {
        return `${title}\n\n${abstract}`.trim();
    }

    /**
     * Extract indexable data from a Zotero item.
     * @param item Zotero item
     * @param minContentLength Minimum combined length of title + abstract (default: MIN_CONTENT_LENGTH)
     * @returns ItemIndexData or null if the item cannot be indexed
     */
    async extractItemData(item: Zotero.Item, minContentLength: number = MIN_CONTENT_LENGTH): Promise<ItemIndexData | null> {
        if (!item.isRegularItem()) {
            return null;
        }

        const title = item.getField('title') as string || '';
        const abstract = item.getField('abstractNote') as string || '';

        // Skip items with insufficient content
        const combinedLength = (title.trim() + abstract.trim()).length;
        if (combinedLength < minContentLength) {
            return null;
        }

        return {
            itemId: item.id,
            libraryId: item.libraryID,
            zoteroKey: item.key,
            version: item.version,
            title,
            abstract,
        };
    }

    /**
     * Check if an item meets the minimum content requirements for indexing.
     * @param item Zotero item
     * @param minContentLength Minimum combined length of title + abstract
     * @returns true if the item can be indexed
     */
    isItemIndexable(item: Zotero.Item, minContentLength: number = MIN_CONTENT_LENGTH): boolean {
        if (!item.isRegularItem()) {
            return false;
        }

        const title = item.getField('title') as string || '';
        const abstract = item.getField('abstractNote') as string || '';
        const combinedLength = (title.trim() + abstract.trim()).length;

        return combinedLength >= minContentLength;
    }

    /**
     * Check which items need to be re-indexed based on content changes.
     * Compares content hashes to detect changes in title or abstract.
     * @param items Array of ItemIndexData to check
     * @returns Array of items that need indexing (new or changed)
     */
    async filterItemsNeedingIndexing(items: ItemIndexData[]): Promise<ItemIndexData[]> {
        if (items.length === 0) return [];

        // Get existing content hashes from database
        const itemIds = items.map(item => item.itemId);
        const existingHashes = await this.db.getContentHashes(itemIds);

        // Filter to items that are new or have changed content
        return items.filter(item => {
            const text = this.buildEmbeddingText(item.title, item.abstract);
            const newHash = BeaverDB.computeContentHash(text);
            const existingHash = existingHashes.get(item.itemId);

            // Index if no existing hash or hash has changed
            return existingHash === undefined || existingHash !== newHash;
        });
    }

    /**
     * Get lightweight item metadata for a library using direct SQL query.
     * Only returns regular items (excludes notes, annotations, attachments).
     * Sorted by clientDateModified DESC (most recent first).
     * @param libraryId The library to query
     * @returns Array of ItemIndexMetadata
     */
    async getItemMetadataForLibrary(libraryId: number): Promise<ItemIndexMetadata[]> {
        const noteItemTypeID = Zotero.ItemTypes.getID('note');
        const annotationItemTypeID = Zotero.ItemTypes.getID('annotation');
        const attachmentItemTypeID = Zotero.ItemTypes.getID('attachment');

        const sql = `
            SELECT itemID, libraryID, clientDateModified 
            FROM items 
            WHERE libraryID = ? 
              AND itemTypeID NOT IN (?, ?, ?)
              AND itemID NOT IN (SELECT itemID FROM deletedItems)
            ORDER BY clientDateModified DESC
        `;
        const params = [libraryId, noteItemTypeID, annotationItemTypeID, attachmentItemTypeID];

        const results: ItemIndexMetadata[] = [];
        await Zotero.DB.queryAsync(sql, params, {
            onRow: (row: any) => {
                const itemId = row.getResultByIndex(0);
                const libId = row.getResultByIndex(1);
                const rawDate = row.getResultByIndex(2);
                let clientDateModified: string;
                try {
                    clientDateModified = Zotero.Date.sqlToISO8601(rawDate);
                } catch (e) {
                    clientDateModified = new Date().toISOString();
                }
                results.push({ itemId, libraryId: libId, clientDateModified });
            }
        });

        return results;
    }

    /**
     * Compute the full diff of what needs to be indexed and deleted for a library.
     * Uses lightweight SQL queries and per-batch item loading to avoid memory issues.
     * @param libraryId The library to analyze
     * @param minContentLength Minimum content length for indexing
     * @param batchSize Size of batches for loading items (default: 500)
     * @returns IndexingDiff with item IDs to index and delete
     */
    async computeIndexingDiff(
        libraryId: number, 
        minContentLength: number = MIN_CONTENT_LENGTH,
        batchSize: number = 500
    ): Promise<IndexingDiff> {
        // Get all existing embeddings for this library
        const existingHashes = await this.db.getEmbeddingContentHashMap(libraryId);
        const existingItemIds = new Set(existingHashes.keys());

        // Get lightweight metadata for all regular items via SQL
        const itemMetadata = await this.getItemMetadataForLibrary(libraryId);
        
        const toIndex: number[] = [];
        const currentItemIds = new Set<number>();
        let totalIndexable = 0;

        // Process in batches to check content hashes
        for (let i = 0; i < itemMetadata.length; i += batchSize) {
            const batchMeta = itemMetadata.slice(i, i + batchSize);
            const batchItemIds = batchMeta.map(m => m.itemId);
            
            // Load items for this batch
            const items = await Zotero.Items.getAsync(batchItemIds);
            
            // Load required data types
            if (items.length > 0) {
                await Zotero.Items.loadDataTypes(items, ["primaryData", "itemData"]);
            }

            for (const item of items) {
                if (!item || !item.isRegularItem()) continue;
                
                const title = item.getField('title') as string || '';
                const abstract = item.getField('abstractNote') as string || '';
                const combinedLength = (title.trim() + abstract.trim()).length;

                if (combinedLength < minContentLength) continue;

                currentItemIds.add(item.id);
                totalIndexable++;

                // Compute content hash
                const text = this.buildEmbeddingText(title, abstract);
                const newHash = BeaverDB.computeContentHash(text);
                const existingHash = existingHashes.get(item.id);

                // Add to index list if new or changed
                if (existingHash === undefined || existingHash !== newHash) {
                    toIndex.push(item.id);
                }
            }
        }

        // Find orphaned embeddings (items that no longer exist or no longer meet criteria)
        const toDelete: number[] = [];
        for (const embeddedItemId of existingItemIds) {
            if (!currentItemIds.has(embeddedItemId)) {
                toDelete.push(embeddedItemId);
            }
        }

        return { toIndex, toDelete, totalIndexable };
    }

    /**
     * Index items by their IDs, loading and processing in batches.
     * This is memory-efficient as it only loads items per-batch.
     * @param itemIds Array of item IDs to index
     * @param options Options for batch indexing
     * @returns IndexingResult with counts
     */
    async indexItemIdsBatch(
        itemIds: number[],
        options: {
            batchSize?: number;         // Items per API batch (default: INDEX_BATCH_SIZE)
            onProgress?: (indexed: number, total: number) => void;
        } = {}
    ): Promise<IndexingResult> {
        const { batchSize = INDEX_BATCH_SIZE, onProgress } = options;

        const result: IndexingResult = {
            indexed: 0,
            skipped: 0,
            failed: 0,
            totalTokens: 0,
        };

        if (itemIds.length === 0) {
            return result;
        }

        // Process in batches
        for (let i = 0; i < itemIds.length; i += batchSize) {
            const batchIds = itemIds.slice(i, i + batchSize);
            
            try {
                // Load items for this batch
                const items = await Zotero.Items.getAsync(batchIds);
                
                // Load required data types
                if (items.length > 0) {
                    await Zotero.Items.loadDataTypes(items, ["primaryData", "itemData", "creators"]);
                }

                // Filter to valid items and extract data
                const itemsData: ItemIndexData[] = [];
                const clientDatesMap = new Map<number, string>();

                for (const item of items) {
                    if (!item || !item.isRegularItem()) {
                        result.skipped++;
                        continue;
                    }

                    const title = item.getField('title') as string || '';
                    const abstract = item.getField('abstractNote') as string || '';
                    const combinedLength = (title.trim() + abstract.trim()).length;

                    if (combinedLength < MIN_CONTENT_LENGTH) {
                        result.skipped++;
                        continue;
                    }

                    // Get clientDateModified
                    const clientDateModified = await getClientDateModifiedAsISOString(item);
                    clientDatesMap.set(item.id, clientDateModified);

                    itemsData.push({
                        itemId: item.id,
                        libraryId: item.libraryID,
                        zoteroKey: item.key,
                        version: item.version,
                        title,
                        abstract,
                        clientDateModified,
                    });
                }

                if (itemsData.length === 0) {
                    continue;
                }

                // Build texts for embedding
                const texts = itemsData.map(item => this.buildEmbeddingText(item.title, item.abstract));
                const ids = itemsData.map(item => item.itemId);

                // Generate embeddings via API
                const response = await embeddingsService.generateEmbeddings(texts, ids, this.dimensions);

                result.totalTokens += response.total_tokens;

                // Prepare embedding records
                const embeddingRecords: Array<Omit<EmbeddingRecord, 'indexed_at'>> = [];

                for (let j = 0; j < itemsData.length; j++) {
                    const itemData = itemsData[j];
                    const embeddingData = response.embeddings.find(e => e.item_id === itemData.itemId);

                    if (!embeddingData) {
                        result.failed++;
                        continue;
                    }

                    const text = texts[j];
                    const contentHash = BeaverDB.computeContentHash(text);
                    const clientDateModified = clientDatesMap.get(itemData.itemId) || new Date().toISOString();

                    embeddingRecords.push({
                        item_id: itemData.itemId,
                        library_id: itemData.libraryId,
                        zotero_key: itemData.zoteroKey,
                        version: itemData.version,
                        client_date_modified: clientDateModified,
                        content_hash: contentHash,
                        embedding: BeaverDB.embeddingToBlob(new Int8Array(embeddingData.embedding)),
                        dimensions: this.dimensions,
                        model_id: this.modelId,
                    });
                }

                // Store embeddings in batch
                if (embeddingRecords.length > 0) {
                    await this.db.upsertEmbeddingsBatch(embeddingRecords);
                    result.indexed += embeddingRecords.length;
                }

            } catch (error) {
                logger(`indexItemIdsBatch: Batch failed at offset ${i}: ${(error as Error).message}`, 1);
                result.failed += batchIds.length;
            }

            // Report progress
            if (onProgress) {
                onProgress(result.indexed + result.skipped + result.failed, itemIds.length);
            }
        }

        return result;
    }

    /**
     * Get all libraries sorted with user library first.
     * @returns Array of library IDs
     */
    getLibrariesSorted(): number[] {
        const libraries = Zotero.Libraries.getAll();
        const userLibraryId = Zotero.Libraries.userLibraryID;
        
        // Sort: user library first, then by library ID
        return libraries
            .map(lib => lib.libraryID)
            .sort((a, b) => {
                if (a === userLibraryId) return -1;
                if (b === userLibraryId) return 1;
                return a - b;
            });
    }

    /**
     * Index a single Zotero item.
     * @param item Zotero item to index
     * @returns true if indexed successfully, false if skipped or failed
     */
    async indexItem(item: Zotero.Item): Promise<boolean> {
        const itemData = await this.extractItemData(item);
        if (!itemData) {
            return false;
        }

        const text = this.buildEmbeddingText(itemData.title, itemData.abstract);
        const contentHash = BeaverDB.computeContentHash(text);

        // Check if content has changed
        const existingEmbedding = await this.db.getEmbedding(itemData.itemId);
        if (existingEmbedding && existingEmbedding.content_hash === contentHash) {
            // Content unchanged, skip
            return false;
        }

        try {
            // Generate embedding via API
            const response = await embeddingsService.generateEmbeddings(
                [text],
                [itemData.itemId],
                this.dimensions
            );

            if (response.embeddings.length === 0) {
                logger(`indexItem: No embedding returned for item ${itemData.itemId}`, 2);
                return false;
            }

            // Get clientDateModified
            const clientDateModified = await getClientDateModifiedAsISOString(item);

            // Store embedding
            const embeddingBlob = BeaverDB.embeddingToBlob(new Int8Array(response.embeddings[0].embedding));
            
            await this.db.upsertEmbedding({
                item_id: itemData.itemId,
                library_id: itemData.libraryId,
                zotero_key: itemData.zoteroKey,
                version: itemData.version,
                client_date_modified: clientDateModified,
                content_hash: contentHash,
                embedding: embeddingBlob,
                dimensions: this.dimensions,
                model_id: this.modelId,
            });

            return true;
        } catch (error) {
            logger(`indexItem: Failed to index item ${itemData.itemId}: ${(error as Error).message}`, 1);
            return false;
        }
    }

    /**
     * Index multiple Zotero items in batch.
     * Optimized for bulk indexing with batched API calls and database writes.
     * @param items Array of Zotero items to index
     * @param options Options for batch indexing
     * @returns IndexingResult with counts of indexed/skipped/failed items
     */
    async indexItemsBatch(
        items: Zotero.Item[],
        options: {
            batchSize?: number;         // Items per API batch (default: 100)
            skipUnchanged?: boolean;    // Skip items with unchanged content (default: true)
            onProgress?: (indexed: number, total: number) => void;
        } = {}
    ): Promise<IndexingResult> {
        const { batchSize = 100, skipUnchanged = true, onProgress } = options;

        const result: IndexingResult = {
            indexed: 0,
            skipped: 0,
            failed: 0,
            totalTokens: 0,
        };

        // Extract data from all items
        const itemDataPromises = items.map(item => this.extractItemData(item));
        const allItemData = (await Promise.all(itemDataPromises)).filter(
            (data): data is ItemIndexData => data !== null
        );

        // Count items that couldn't be extracted
        result.skipped += items.length - allItemData.length;

        if (allItemData.length === 0) {
            return result;
        }

        // Filter to items needing indexing if skipUnchanged is true
        let itemsToIndex = allItemData;
        if (skipUnchanged) {
            itemsToIndex = await this.filterItemsNeedingIndexing(allItemData);
            result.skipped += allItemData.length - itemsToIndex.length;
        }

        if (itemsToIndex.length === 0) {
            return result;
        }

        // Get clientDateModified for all items
        const clientDatesMap = new Map<number, string>();
        for (const itemData of itemsToIndex) {
            try {
                const item = await Zotero.Items.getAsync(itemData.itemId);
                if (item) {
                    clientDatesMap.set(itemData.itemId, await getClientDateModifiedAsISOString(item));
                }
            } catch (e) {
                clientDatesMap.set(itemData.itemId, new Date().toISOString());
            }
        }

        // Process in batches
        for (let i = 0; i < itemsToIndex.length; i += batchSize) {
            const batch = itemsToIndex.slice(i, i + batchSize);
            
            // Build texts for embedding
            const texts = batch.map(item => this.buildEmbeddingText(item.title, item.abstract));
            const itemIds = batch.map(item => item.itemId);

            try {
                // Generate embeddings via API
                const response = await embeddingsService.generateEmbeddings(
                    texts,
                    itemIds,
                    this.dimensions
                );

                result.totalTokens += response.total_tokens;

                // Prepare embedding records
                const embeddingRecords: Array<Omit<EmbeddingRecord, 'indexed_at'>> = [];

                for (let j = 0; j < batch.length; j++) {
                    const itemData = batch[j];
                    const embeddingData = response.embeddings.find(e => e.item_id === itemData.itemId);

                    if (!embeddingData) {
                        result.failed++;
                        continue;
                    }

                    const text = texts[j];
                    const contentHash = BeaverDB.computeContentHash(text);
                    const clientDateModified = clientDatesMap.get(itemData.itemId) || new Date().toISOString();

                    embeddingRecords.push({
                        item_id: itemData.itemId,
                        library_id: itemData.libraryId,
                        zotero_key: itemData.zoteroKey,
                        version: itemData.version,
                        client_date_modified: clientDateModified,
                        content_hash: contentHash,
                        embedding: BeaverDB.embeddingToBlob(new Int8Array(embeddingData.embedding)),
                        dimensions: this.dimensions,
                        model_id: this.modelId,
                    });
                }

                // Store embeddings in batch
                if (embeddingRecords.length > 0) {
                    await this.db.upsertEmbeddingsBatch(embeddingRecords);
                    result.indexed += embeddingRecords.length;
                }

            } catch (error) {
                logger(`indexItemsBatch: Batch failed at offset ${i}: ${(error as Error).message}`, 1);
                result.failed += batch.length;
            }

            // Report progress
            if (onProgress) {
                onProgress(result.indexed + result.failed, itemsToIndex.length);
            }
        }

        return result;
    }

    /**
     * Remove embeddings for items that no longer exist in Zotero.
     * @param libraryId The library to clean up
     * @returns Number of embeddings removed
     */
    async cleanupOrphanedEmbeddings(libraryId: number): Promise<number> {
        // Get all embedded item IDs for the library
        const embeddedItemIds = await this.db.getEmbeddedItemIds(libraryId);
        
        if (embeddedItemIds.length === 0) {
            return 0;
        }

        // Check which items still exist in Zotero
        const existingItems = await Zotero.Items.getAsync(embeddedItemIds);
        const existingItemIds = new Set(
            existingItems
                .filter(item => item && !item.deleted)
                .map(item => item.id)
        );

        // Find orphaned embeddings
        const orphanedIds = embeddedItemIds.filter(id => !existingItemIds.has(id));

        if (orphanedIds.length > 0) {
            await this.db.deleteEmbeddingsBatch(orphanedIds);
        }

        return orphanedIds.length;
    }

    /**
     * Remove an embedding for a specific item.
     * @param itemId The Zotero item ID
     */
    async removeEmbedding(itemId: number): Promise<void> {
        await this.db.deleteEmbedding(itemId);
    }

    /**
     * Remove all embeddings for a library.
     * @param libraryId The library ID
     */
    async removeLibraryEmbeddings(libraryId: number): Promise<void> {
        await this.db.deleteEmbeddingsByLibrary(libraryId);
    }

    /**
     * Get indexing statistics for a library.
     * @param libraryId Optional library ID (all libraries if not specified)
     */
    async getStats(libraryId?: number): Promise<{
        embeddingCount: number;
        dimensions: number;
        modelId: string;
    }> {
        const count = await this.db.getEmbeddingCount(libraryId);
        return {
            embeddingCount: count,
            dimensions: this.dimensions,
            modelId: this.modelId,
        };
    }
}

