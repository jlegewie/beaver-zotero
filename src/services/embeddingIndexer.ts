import { BeaverDB, EmbeddingRecord, MAX_EMBEDDING_FAILURES } from './database';
import { embeddingsService } from './embeddingsService';
import { getClientDateModifiedAsISOString } from '../utils/zoteroUtils';
import { logger } from '../utils/logger';


/**
 * Minimum combined length of title + abstract required for indexing.
 * Items with less content are skipped.
 */
export const MIN_CONTENT_LENGTH = 40;

/**
 * Default batch size for embedding API requests (max 500)
 */
export const INDEX_BATCH_SIZE = 500;

/**
 * How often to force a full diff scan as a safety net (in milliseconds).
 * Default: 7 days. This catches any edge cases missed by the quick check.
 */
export const FULL_DIFF_SAFETY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

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
}

/**
 * Current state of Zotero library for diff comparison
 */
export interface ZoteroLibraryState {
    maxClientDateModified: string | null;  // MAX(clientDateModified) from items table
    itemCount: number;                      // COUNT of regular items
}

/**
 * Result of checking whether full diff is needed
 */
export interface DiffCheckResult {
    needsDiff: boolean;     // Whether full diff should run
    reason: string;         // Human-readable reason for the decision
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

        const title = item.getField('title', false, true) as string || '';
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

        const title = item.getField('title', false, true) as string || '';
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
                
                const title = item.getField('title', false, true) as string || '';
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
     * Uses retry with exponential backoff for transient failures.
     * Failed batches are tracked for later retry.
     * @param itemIds Array of item IDs to index
     * @param options Options for batch indexing
     * @returns IndexingResult with counts
     */
    async indexItemIdsBatch(
        itemIds: number[],
        options: {
            batchSize?: number;         // Items per API batch (default: INDEX_BATCH_SIZE)
            skipUnchanged?: boolean;    // Skip items with unchanged content hash (default: false)
            onProgress?: (indexed: number, total: number) => void;
        } = {}
    ): Promise<IndexingResult> {
        const { batchSize = INDEX_BATCH_SIZE, skipUnchanged = false, onProgress } = options;

        const result: IndexingResult = {
            indexed: 0,
            skipped: 0,
            failed: 0
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
                const textsForHashCheck: Map<number, string> = new Map();

                for (const item of items) {
                    if (!item || !item.isRegularItem()) {
                        result.skipped++;
                        continue;
                    }

                    const title = item.getField('title', false, true) as string || '';
                    const abstract = item.getField('abstractNote') as string || '';
                    const combinedLength = (title.trim() + abstract.trim()).length;

                    if (combinedLength < MIN_CONTENT_LENGTH) {
                        result.skipped++;
                        continue;
                    }

                    // Get clientDateModified
                    const clientDateModified = await getClientDateModifiedAsISOString(item);
                    clientDatesMap.set(item.id, clientDateModified);

                    const itemData: ItemIndexData = {
                        itemId: item.id,
                        libraryId: item.libraryID,
                        zoteroKey: item.key,
                        version: item.version,
                        title,
                        abstract,
                        clientDateModified,
                    };
                    
                    itemsData.push(itemData);
                    
                    // Pre-compute text for hash checking
                    if (skipUnchanged) {
                        textsForHashCheck.set(item.id, this.buildEmbeddingText(title, abstract));
                    }
                }

                if (itemsData.length === 0) {
                    continue;
                }

                // Filter out items with unchanged content if requested
                let itemsToProcess = itemsData;
                if (skipUnchanged && textsForHashCheck.size > 0) {
                    const itemIdsToCheck = itemsData.map(d => d.itemId);
                    const existingHashes = await this.db.getContentHashes(itemIdsToCheck);
                    
                    itemsToProcess = itemsData.filter(itemData => {
                        const text = textsForHashCheck.get(itemData.itemId);
                        if (!text) return true; // Shouldn't happen, but include if no text
                        
                        const newHash = BeaverDB.computeContentHash(text);
                        const existingHash = existingHashes.get(itemData.itemId);
                        
                        // Include if no existing hash (new item) or hash changed
                        const needsIndexing = existingHash === undefined || existingHash !== newHash;
                        if (!needsIndexing) {
                            result.skipped++;
                        }
                        return needsIndexing;
                    });
                }

                if (itemsToProcess.length === 0) {
                    continue;
                }

                // Build texts for embedding
                const texts = itemsToProcess.map(item => this.buildEmbeddingText(item.title, item.abstract));
                const ids = itemsToProcess.map(item => item.itemId);

                // Generate embeddings via API with retry
                const response = await embeddingsService.generateEmbeddingsWithRetry(texts, ids);

                // Prepare embedding records
                const embeddingRecords: Array<Omit<EmbeddingRecord, 'indexed_at'>> = [];
                const successfulItemIds: number[] = [];

                for (let j = 0; j < itemsToProcess.length; j++) {
                    const itemData = itemsToProcess[j];
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
                    
                    successfulItemIds.push(itemData.itemId);
                }

                // Store embeddings in batch
                if (embeddingRecords.length > 0) {
                    await this.db.upsertEmbeddingsBatch(embeddingRecords);
                    result.indexed += embeddingRecords.length;
                    
                    // Remove successful items from failed tracking
                    await this.db.removeFailedEmbeddingsBatch(successfulItemIds);
                }

            } catch (error) {
                const errorMessage = (error as Error).message;
                logger(`indexItemIdsBatch: Batch failed at offset ${i}: ${errorMessage}`, 1);
                result.failed += batchIds.length;
                
                // Track all items in the failed batch
                // We need to get library IDs for the failed items
                try {
                    const items = await Zotero.Items.getAsync(batchIds);
                    const failedItems = items
                        .filter(item => item && item.isRegularItem())
                        .map(item => ({ itemId: item.id, libraryId: item.libraryID }));
                    
                    if (failedItems.length > 0) {
                        await this.db.recordFailedEmbeddingsBatch(failedItems, errorMessage);
                        logger(`indexItemIdsBatch: Recorded ${failedItems.length} items as failed`, 3);
                    }
                } catch (trackError) {
                    logger(`indexItemIdsBatch: Failed to track failed items: ${(trackError as Error).message}`, 1);
                }
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
     * Query Zotero database for current library state.
     * Uses SQL to get MAX(clientDateModified) and COUNT of regular items.
     * @param libraryId The library to query
     * @returns ZoteroLibraryState with max date and item count
     */
    async getZoteroLibraryState(libraryId: number): Promise<ZoteroLibraryState> {
        const noteItemTypeID = Zotero.ItemTypes.getID('note');
        const annotationItemTypeID = Zotero.ItemTypes.getID('annotation');
        const attachmentItemTypeID = Zotero.ItemTypes.getID('attachment');

        const sql = `
            SELECT 
                MAX(clientDateModified) as max_date,
                COUNT(*) as item_count
            FROM items 
            WHERE libraryID = ? 
              AND itemTypeID NOT IN (?, ?, ?)
              AND itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        const params = [libraryId, noteItemTypeID, annotationItemTypeID, attachmentItemTypeID];

        let maxDate: string | null = null;
        let itemCount = 0;

        await Zotero.DB.queryAsync(sql, params, {
            onRow: (row: any) => {
                const rawMaxDate = row.getResultByIndex(0);
                const rawCount = row.getResultByIndex(1);
                maxDate = rawMaxDate;
                itemCount = rawCount || 0;
            }
        });

        let maxClientDateModified: string | null = null;
        if (maxDate) {
            try {
                maxClientDateModified = Zotero.Date.sqlToISO8601(maxDate);
            } catch (e) {
                maxClientDateModified = maxDate;
            }
        }

        return {
            maxClientDateModified,
            itemCount,
        };
    }

    /**
     * Check if a full diff scan is needed for a library.
     * Uses quick comparisons to avoid expensive full scans when nothing changed.
     * 
     * A full diff is needed if:
     * 1. No embeddings exist for this library (first run)
     * 2. No stored state exists (establishing baseline)
     * 3. Last scan was more than FULL_DIFF_SAFETY_INTERVAL_MS ago (weekly safety net)
     * 4. Zotero's item count ≠ stored count (items added or deleted)
     * 5. Zotero's MAX(clientDateModified) > stored MAX (items modified)
     * 6. Current embedding count ≠ stored count (data loss/corruption)
     * 
     * @param libraryId The library to check
     * @returns DiffCheckResult with needsDiff flag and reason
     */
    async shouldRunFullDiff(libraryId: number): Promise<DiffCheckResult> {
        // Get stored state from last successful scan
        const storedState = await this.db.getEmbeddingIndexState(libraryId);
        
        // Check 1: First run - no stored state
        if (!storedState) {
            const embeddingCount = await this.db.getEmbeddingCount(libraryId);
            if (embeddingCount === 0) {
                return { needsDiff: true, reason: 'First run - no embeddings exist' };
            }
            // Has embeddings but no state - run diff to establish baseline
            return { needsDiff: true, reason: 'No stored state - establishing baseline' };
        }

        // Check 2: Safety net - periodic full scan
        const lastScanTime = new Date(storedState.last_scan_timestamp).getTime();
        const timeSinceLastScan = Date.now() - lastScanTime;
        if (timeSinceLastScan > FULL_DIFF_SAFETY_INTERVAL_MS) {
            return { needsDiff: true, reason: `Safety net - last scan was ${Math.round(timeSinceLastScan / (24 * 60 * 60 * 1000))} days ago` };
        }

        // Get current Zotero state
        const zoteroState = await this.getZoteroLibraryState(libraryId);

        // Check 3: Item count changed (additions or deletions)
        if (zoteroState.itemCount !== storedState.item_count) {
            return { 
                needsDiff: true, 
                reason: `Item count changed: ${storedState.item_count} → ${zoteroState.itemCount}` 
            };
        }

        // Check 4: Items modified (MAX date increased)
        if (zoteroState.maxClientDateModified && storedState.max_client_date_modified) {
            const zoteroDate = new Date(zoteroState.maxClientDateModified).getTime();
            const storedDate = new Date(storedState.max_client_date_modified).getTime();
            
            if (zoteroDate > storedDate) {
                return { 
                    needsDiff: true, 
                    reason: `Items modified since last scan` 
                };
            }
        }

        // Check 5: Embedding count mismatch (possible data loss/corruption)
        const currentEmbeddingCount = await this.db.getEmbeddingCount(libraryId);
        if (currentEmbeddingCount !== storedState.embedding_count) {
            return { 
                needsDiff: true, 
                reason: `Embedding count changed: ${storedState.embedding_count} → ${currentEmbeddingCount}` 
            };
        }

        // No changes detected
        return { needsDiff: false, reason: 'No changes detected' };
    }

    /**
     * Save the index state after a successful diff scan.
     * @param libraryId The library that was scanned
     * @param zoteroState The Zotero state at scan time
     */
    async saveIndexState(libraryId: number, zoteroState: ZoteroLibraryState): Promise<void> {
        const embeddingCount = await this.db.getEmbeddingCount(libraryId);
        
        await this.db.upsertEmbeddingIndexState({
            library_id: libraryId,
            last_scan_timestamp: new Date().toISOString(),
            max_client_date_modified: zoteroState.maxClientDateModified || new Date().toISOString(),
            item_count: zoteroState.itemCount,
            embedding_count: embeddingCount,
        });
    }

    /**
     * Index a single Zotero item.
     * Uses retry with exponential backoff for transient failures.
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
            // Generate embedding via API with retry
            const response = await embeddingsService.generateEmbeddingsWithRetry(
                [text],
                [itemData.itemId]
            );

            if (response.embeddings.length === 0) {
                logger(`indexItem: No embedding returned for item ${itemData.itemId}`, 2);
                await this.db.recordFailedEmbedding(itemData.itemId, itemData.libraryId, 'No embedding returned');
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

            // Remove from failed tracking on success
            await this.db.removeFailedEmbedding(itemData.itemId);

            return true;
        } catch (error) {
            const errorMessage = (error as Error).message;
            logger(`indexItem: Failed to index item ${itemData.itemId}: ${errorMessage}`, 1);
            await this.db.recordFailedEmbedding(itemData.itemId, itemData.libraryId, errorMessage);
            return false;
        }
    }

    /**
     * Index multiple Zotero items in batch.
     * Optimized for bulk indexing with batched API calls and database writes.
     * Uses retry with exponential backoff for transient failures.
     * @param items Array of Zotero items to index
     * @param options Options for batch indexing
     * @returns IndexingResult with counts of indexed/skipped/failed items
     */
    async indexItemsBatch(
        items: Zotero.Item[],
        options: {
            batchSize?: number;         // Items per API batch (default: 500)
            skipUnchanged?: boolean;    // Skip items with unchanged content (default: true)
            onProgress?: (indexed: number, total: number) => void;
        } = {}
    ): Promise<IndexingResult> {
        const { batchSize = 500, skipUnchanged = true, onProgress } = options;

        const result: IndexingResult = {
            indexed: 0,
            skipped: 0,
            failed: 0
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
                // Generate embeddings via API with retry
                const response = await embeddingsService.generateEmbeddingsWithRetry(
                    texts,
                    itemIds
                );

                // Prepare embedding records
                const embeddingRecords: Array<Omit<EmbeddingRecord, 'indexed_at'>> = [];
                const successfulItemIds: number[] = [];

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
                    
                    successfulItemIds.push(itemData.itemId);
                }

                // Store embeddings in batch
                if (embeddingRecords.length > 0) {
                    await this.db.upsertEmbeddingsBatch(embeddingRecords);
                    result.indexed += embeddingRecords.length;
                    
                    // Remove successful items from failed tracking
                    await this.db.removeFailedEmbeddingsBatch(successfulItemIds);
                }

            } catch (error) {
                const errorMessage = (error as Error).message;
                logger(`indexItemsBatch: Batch failed at offset ${i}: ${errorMessage}`, 1);
                result.failed += batch.length;
                
                // Track all items in the failed batch
                const failedItems = batch.map(item => ({ 
                    itemId: item.itemId, 
                    libraryId: item.libraryId 
                }));
                await this.db.recordFailedEmbeddingsBatch(failedItems, errorMessage);
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
     * Clean up embeddings, failed records, and index state for libraries that are no longer synced.
     * This should be called during initial indexing to handle library sync changes.
     * @param syncedLibraryIds Array of library IDs that should be synced
     * @returns Object with number of libraries and embeddings cleaned up
     */
    async cleanupUnsyncedLibraries(syncedLibraryIds: number[]): Promise<{ 
        librariesRemoved: number; 
        embeddingsRemoved: number;
    }> {
        // Get all library IDs that have embeddings
        const embeddedLibraryIds = await this.db.getEmbeddedLibraryIds();
        
        // Find libraries that have embeddings but are not in sync list
        const syncedSet = new Set(syncedLibraryIds);
        const librariesToRemove = embeddedLibraryIds.filter(id => !syncedSet.has(id));
        
        if (librariesToRemove.length === 0) {
            return { librariesRemoved: 0, embeddingsRemoved: 0 };
        }
        
        let totalEmbeddingsRemoved = 0;
        
        for (const libraryId of librariesToRemove) {
            // Get count before deletion for logging
            const count = await this.db.getEmbeddingCount(libraryId);
            
            // Delete embeddings for this library
            await this.db.deleteEmbeddingsByLibrary(libraryId);
            
            // Delete failed embedding records for this library
            await this.db.deleteFailedEmbeddingsByLibrary(libraryId);
            
            // Also clean up the index state for this library
            await this.db.deleteEmbeddingIndexState(libraryId);
            
            totalEmbeddingsRemoved += count;
            logger(`cleanupUnsyncedLibraries: Removed ${count} embeddings, failed records, and index state for unsynced library ${libraryId}`, 3);
        }
        
        return { 
            librariesRemoved: librariesToRemove.length, 
            embeddingsRemoved: totalEmbeddingsRemoved 
        };
    }

    /**
     * Clear all failed embeddings for synced libraries.
     * This resets the backoff state for all items that previously failed,
     * allowing them to be retried on the next indexing run.
     * @param syncedLibraryIds Array of library IDs to clear failed state for
     * @returns Number of failed records cleared
     */
    async clearFailedEmbeddings(syncedLibraryIds: number[]): Promise<number> {
        if (syncedLibraryIds.length === 0) {
            return 0;
        }

        let totalCleared = 0;
        for (const libraryId of syncedLibraryIds) {
            const count = await this.db.getFailedEmbeddingCount(libraryId);
            if (count > 0) {
                await this.db.deleteFailedEmbeddingsByLibrary(libraryId);
                totalCleared += count;
                logger(`clearFailedEmbeddings: Cleared ${count} failed records for library ${libraryId}`, 3);
            }
        }
        
        return totalCleared;
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

    /**
     * Get item IDs that are ready for retry (failed previously but retry time has passed).
     * @param libraryId Optional library ID to filter by
     * @returns Array of item IDs ready for retry
     */
    async getItemsReadyForRetry(libraryId?: number): Promise<number[]> {
        return this.db.getItemsReadyForRetry(libraryId);
    }

    /**
     * Get count of failed embeddings.
     * @param libraryId Optional library ID to filter by
     * @returns Object with total failed, ready for retry, and permanently failed counts
     */
    async getFailedStats(libraryId?: number): Promise<{
        totalFailed: number;
        readyForRetry: number;
        permanentlyFailed: number;
    }> {
        const totalFailed = await this.db.getFailedEmbeddingCount(libraryId);
        const readyForRetry = (await this.db.getItemsReadyForRetry(libraryId)).length;
        const permanentlyFailed = (await this.db.getPermanentlyFailedItems(libraryId)).length;
        
        return {
            totalFailed,
            readyForRetry,
            permanentlyFailed,
        };
    }

    /**
     * Filter out items that are not ready for retry from the to-index list.
     * Items that have failed and are still in backoff period will be excluded.
     * @param itemIds Array of item IDs to potentially index
     * @returns Filtered array excluding items not ready for retry
     */
    async filterItemsNotInBackoff(itemIds: number[]): Promise<number[]> {
        if (itemIds.length === 0) return [];

        // Get failed items for these IDs
        const failedRecords = await this.db.getFailedEmbeddingsBatch(itemIds);
        const failedMap = new Map(failedRecords.map(r => [r.item_id, r]));
        
        // Use the same string format as stored timestamps for consistent comparison
        // Timestamps are stored as UTC strings like "2024-05-24 12:00:00"
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        return itemIds.filter(id => {
            const failed = failedMap.get(id);
            if (!failed) {
                // Never failed, include it
                return true;
            }
            
            // Check if permanently failed
            if (failed.failure_count >= MAX_EMBEDDING_FAILURES) {
                // Skip permanently failed items
                return false;
            }
            
            // Check if backoff period has passed
            // Compare as strings since both are in the same UTC format
            return now >= failed.next_retry_after;
        });
    }

    /**
     * Clean up failed embedding records for items that have been deleted from Zotero.
     * @param libraryId The library to clean up
     * @returns Number of records cleaned up
     */
    async cleanupDeletedFailedEmbeddings(libraryId: number): Promise<number> {
        // Get all failed item IDs for this library
        const failedRecords = await this.db.getPermanentlyFailedItems(libraryId);
        const allFailedIds = failedRecords.map(r => r.item_id);
        
        // Also get items ready for retry
        const retryIds = await this.db.getItemsReadyForRetry(libraryId);
        const allIds = [...new Set([...allFailedIds, ...retryIds])];
        
        if (allIds.length === 0) return 0;
        
        // Check which items still exist in Zotero
        const existingItems = await Zotero.Items.getAsync(allIds);
        const existingIds = new Set(
            existingItems
                .filter(item => item && !item.deleted)
                .map(item => item.id)
        );
        
        // Find items that no longer exist
        const toDelete = allIds.filter(id => !existingIds.has(id));
        
        if (toDelete.length > 0) {
            await this.db.removeFailedEmbeddingsBatch(toDelete);
        }
        
        return toDelete.length;
    }
}

