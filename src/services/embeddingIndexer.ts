import { BeaverDB, EmbeddingRecord } from './database';
import { embeddingsService } from './embeddingsService';
import { getClientDateModifiedAsISOString, getClientDateModifiedBatch } from '../utils/zoteroUtils';
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
    toIndex: ItemIndexData[];       // Items that need (re-)indexing
    toDelete: number[];             // Item IDs whose embeddings should be deleted
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
     * Compute the full diff of what needs to be indexed and deleted for a library.
     * Compares current Zotero items against existing embeddings.
     * @param libraryId The library to analyze
     * @param minContentLength Minimum content length for indexing
     * @returns IndexingDiff with items to index and delete
     */
    async computeIndexingDiff(libraryId: number, minContentLength: number = MIN_CONTENT_LENGTH): Promise<IndexingDiff> {
        // Get all existing embeddings for this library
        const existingHashes = await this.db.getEmbeddingContentHashMap(libraryId);
        const existingItemIds = new Set(existingHashes.keys());

        // Get all regular items from Zotero for this library
        const allItems = await Zotero.Items.getAll(libraryId, false, false, false) as Zotero.Item[];
        
        const toIndex: ItemIndexData[] = [];
        const currentItemIds = new Set<number>();

        for (const item of allItems) {
            if (!item.isRegularItem()) continue;
            
            const title = item.getField('title') as string || '';
            const abstract = item.getField('abstractNote') as string || '';
            const combinedLength = (title.trim() + abstract.trim()).length;

            if (combinedLength < minContentLength) continue;

            currentItemIds.add(item.id);

            // Compute content hash
            const text = this.buildEmbeddingText(title, abstract);
            const newHash = BeaverDB.computeContentHash(text);
            const existingHash = existingHashes.get(item.id);

            // Add to index list if new or changed
            if (existingHash === undefined || existingHash !== newHash) {
                toIndex.push({
                    itemId: item.id,
                    libraryId: item.libraryID,
                    zoteroKey: item.key,
                    version: item.version,
                    title,
                    abstract,
                });
            }
        }

        // Find orphaned embeddings (items that no longer exist or no longer meet criteria)
        const toDelete: number[] = [];
        for (const embeddedItemId of existingItemIds) {
            if (!currentItemIds.has(embeddedItemId)) {
                toDelete.push(embeddedItemId);
            }
        }

        return { toIndex, toDelete };
    }

    /**
     * Get all indexable items for a library, sorted by clientDateModified DESC.
     * @param libraryId The library to get items from
     * @param minContentLength Minimum content length for indexing
     * @returns Array of Zotero items sorted by most recently modified first
     */
    async getIndexableItemsForLibrary(
        libraryId: number, 
        minContentLength: number = MIN_CONTENT_LENGTH
    ): Promise<Zotero.Item[]> {
        // Get all items from the library
        const allItems = await Zotero.Items.getAll(libraryId, false, false, false) as Zotero.Item[];
        
        // Filter to indexable items
        const indexableItems = allItems.filter(item => this.isItemIndexable(item, minContentLength));

        // Get clientDateModified for sorting
        const clientDates = await getClientDateModifiedBatch(indexableItems);

        // Sort by clientDateModified DESC (most recent first)
        indexableItems.sort((a, b) => {
            const dateA = clientDates.get(a.id) || '';
            const dateB = clientDates.get(b.id) || '';
            return dateB.localeCompare(dateA);
        });

        return indexableItems;
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

