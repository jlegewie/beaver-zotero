import { BeaverDB, EmbeddingRecord, EmbeddingSource, MAX_EMBEDDING_FAILURES } from './database';
import { embeddingsService } from '@beaver/agent-core/transport/clients/embeddingsService';
import { getClientDateModifiedBatch } from '../utils/zoteroUtils';
import { logger } from '@beaver/agent-core/platform/logger';
import { expectedExtractionSchemaVersion } from './documentExtraction/shared/extractionSchemaVersions';
import {
    enqueueEmbeddingExtractions,
    resolveUnitsBatch,
    type ExtractionCandidate,
    type FileIdentityCheck,
} from './embeddingUnits';

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
    text: string;
    source: EmbeddingSource;
    sourceAttachmentId: number | null;
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
 * Sanitized error summary surfaced through indexing results.
 */
export interface IndexingError {
    type: string;       // Error class name
    message: string;    // Sanitized message (no file paths, no PII, capped length)
    count: number;      // How many items hit this exact error
}

/**
 * Result of an indexing operation
 */
export interface IndexingResult {
    indexed: number;        // Number of items successfully indexed
    skipped: number;        // Number of items skipped (no content or unchanged)
    failed: number;         // Number of items that failed
    errors: IndexingError[]; // Sanitized error summaries for diagnostics
    /**
     * True if any batch hit a failure that prevented items from being properly
     * classified into indexed/failed/skipped buckets — i.e. the batch crashed
     * before items could be sent to the API or persisted to failed_embeddings.
     */
    incomplete: boolean;
    /** Loaded items that are not (or no longer) indexable; their embeddings should be removed. */
    unindexable: number[];
}

/**
 * Maximum length of a sanitized error message before truncation.
 */
const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Maximum number of unique error variants tracked per result.
 */
const MAX_ERROR_VARIANTS = 20;

/**
 * Sanitize an error message for transmission to the backend
 */
function sanitizeErrorMessage(message: string): string {
    if (!message) return '';
    let m = message;
    // Strip Unix home dirs and common system dirs (preserves leading slash for context)
    m = m.replace(/\/(?:Users|home|root|var|tmp|opt|private)\/[^\s'"]+/g, '<path>');
    // Strip Windows-style absolute paths
    m = m.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
    if (m.length > MAX_ERROR_MESSAGE_LENGTH) {
        m = m.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '...';
    }
    return m;
}

/**
 * Convert an unknown thrown value into a {type, message} pair safe to send
 * to the backend.
 */
function classifyError(err: unknown): { type: string; message: string } {
    if (err instanceof Error) {
        return {
            type: err.name || 'Error',
            message: sanitizeErrorMessage(err.message || ''),
        };
    }
    return {
        type: 'unknown',
        message: sanitizeErrorMessage(String(err)),
    };
}

/**
 * Record an error against an IndexingResult. Deduplicates by (type, message)
 * and bumps the count if the same error has been seen before. Caps total
 * variants at MAX_ERROR_VARIANTS to keep the payload bounded.
 */
export function recordIndexingError(result: IndexingResult, err: unknown): void {
    const { type, message } = classifyError(err);
    const existing = result.errors.find(e => e.type === type && e.message === message);
    if (existing) {
        existing.count++;
        return;
    }
    if (result.errors.length < MAX_ERROR_VARIANTS) {
        result.errors.push({ type, message, count: 1 });
    }
}

/**
 * Merge errors from one IndexingResult into another, preserving dedup/cap
 * semantics. Used by callers (e.g. useEmbeddingIndex) that aggregate results
 * from multiple library passes / batches.
 */
export function mergeIndexingErrors(
    target: IndexingError[],
    source: IndexingError[],
): void {
    for (const incoming of source) {
        const existing = target.find(
            e => e.type === incoming.type && e.message === incoming.message,
        );
        if (existing) {
            existing.count += incoming.count;
        } else if (target.length < MAX_ERROR_VARIANTS) {
            target.push({ ...incoming });
        }
    }
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
     * Get lightweight item metadata for a library using direct SQL query.
     * Only returns regular items (excludes notes, annotations, attachments).
     * Sorted by dateAdded DESC (most recently added first) so the earliest
     * batches reflect what the user has most recently brought into their
     * library.
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
            ORDER BY dateAdded DESC
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
     * Child attachments added or modified at or after `since`, e.g. by a sync
     * while no index generation was observing. Adding or replacing an attachment
     * does not change its parent's modification date. The boundary second is
     * included because Zotero timestamps have second precision.
     */
    async getAttachmentsModifiedSince(
        libraryId: number,
        since: Date,
    ): Promise<{ attachmentId: number; parentId: number }[]> {
        const sqlDate = since.toISOString().replace('T', ' ').slice(0, 19);
        const attachments: { attachmentId: number; parentId: number }[] = [];
        await Zotero.DB.queryAsync(
            `SELECT IA.itemID, IA.parentItemID
             FROM itemAttachments IA
             JOIN items I ON I.itemID = IA.itemID
             WHERE I.libraryID = ? AND IA.parentItemID IS NOT NULL AND I.clientDateModified >= ?`,
            [libraryId, sqlDate],
            {
                onRow: (row: any) => {
                    attachments.push({ attachmentId: row.getResultByIndex(0), parentId: row.getResultByIndex(1) });
                },
            },
        );
        return attachments;
    }

    /**
     * Compute the full diff of what needs to be indexed and deleted for a library.
     * Uses lightweight SQL queries and per-batch item loading to avoid memory issues.
     * Also enqueues extraction for units that need derived text and drops derived
     * text of attachments that no longer exist. Only units whose text changed,
     * that (or whose attachments) were modified since the last saved scan, or
     * whose attachment holds a final extraction verdict from an older extractor
     * are considered for extraction, and only the files of attachments modified
     * since that scan are checked against their stored text, so a routine diff
     * does no per-item file I/O. Without a saved scan (first run, derived-text
     * version change) every unit is considered.
     * @param libraryId The library to analyze
     * @param options.batchSize Size of batches for loading items (default: 500)
     * @param options.enqueueAllExtractions Consider every unit for extraction
     * @returns IndexingDiff with item IDs to index and delete
     */
    async computeIndexingDiff(
        libraryId: number,
        options: { batchSize?: number; enqueueAllExtractions?: boolean } = {},
    ): Promise<IndexingDiff> {
        const { batchSize = 500, enqueueAllExtractions = false } = options;
        // Get all existing embeddings for this library
        const existingHashes = await this.db.getEmbeddingContentHashMap(libraryId);
        const existingItemIds = new Set(existingHashes.keys());

        const lastScan = await this.db.getEmbeddingIndexState(libraryId);
        const scannedUntil = lastScan ? Date.parse(lastScan.max_client_date_modified) : NaN;
        // Inclusive: a change in the watermark's second may postdate the scan.
        const modifiedSinceScan = (clientDateModified: string) => enqueueAllExtractions
            || Number.isNaN(scannedUntil) || !(Date.parse(clientDateModified) < scannedUntil);
        const modifiedAttachments = Number.isNaN(scannedUntil)
            ? []
            : await this.getAttachmentsModifiedSince(libraryId, new Date(scannedUntil));
        // A replaced file keeps its stored text until its identity is checked.
        const checkFileIdentity = new Set(modifiedAttachments.map(a => a.attachmentId));
        const extractionParents = new Set(modifiedAttachments.map(a => a.parentId));
        for (const parentId of await this.getParentsWithOutdatedExtractionVerdicts(libraryId)) {
            extractionParents.add(parentId);
        }

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
            const items = (await Zotero.Items.getAsync(batchItemIds)).filter(Boolean);
            
            // Load required data types
            if (items.length > 0) {
                await Zotero.Items.loadDataTypes(items, ["primaryData", "itemData"]);
            }

            const resolutions = await resolveUnitsBatch(items, this.db, { checkFileIdentity });
            const unchanged: Pick<ItemIndexData, 'itemId' | 'source' | 'sourceAttachmentId'>[] = [];
            const extractionIds = new Set(batchMeta
                .filter(m => modifiedSinceScan(m.clientDateModified) || extractionParents.has(m.itemId))
                .map(m => m.itemId));
            for (const { item, unit, error } of resolutions) {
                if (error) {
                    // Keep the existing embedding; indexing records the failure.
                    currentItemIds.add(item.id);
                    toIndex.push(item.id);
                    continue;
                }
                if (!unit) continue;

                currentItemIds.add(item.id);
                totalIndexable++;

                // Add to index list if new or changed
                const existingHash = existingHashes.get(item.id);
                if (existingHash === undefined || existingHash !== BeaverDB.computeContentHash(unit.text)) {
                    toIndex.push(item.id);
                    extractionIds.add(item.id);
                } else {
                    unchanged.push({ itemId: item.id, source: unit.source, sourceAttachmentId: unit.sourceAttachmentId });
                }
            }
            await this.syncUnchangedSources(unchanged);
            // Other units were considered when they last changed; text for them
            // arrives through extraction and attachment events.
            await this.enqueueExtractions(resolutions.filter(r => extractionIds.has(r.item.id)));
        }

        // Find orphaned embeddings (items that no longer exist or no longer meet criteria)
        const toDelete: number[] = [];
        for (const embeddedItemId of existingItemIds) {
            if (!currentItemIds.has(embeddedItemId)) {
                toDelete.push(embeddedItemId);
            }
        }

        await this.cleanupOrphanedEmbeddingTexts(libraryId);

        return { toIndex, toDelete, totalIndexable };
    }

    /**
     * Parents of attachments whose failed or skipped extraction was recorded by
     * an older extractor. A newer extractor may succeed, and the enqueue step
     * reopens such verdicts for the current source.
     */
    private async getParentsWithOutdatedExtractionVerdicts(libraryId: number): Promise<number[]> {
        const attachmentIds = await this.db.getAttachmentIdsWithOutdatedTerminalVerdicts(libraryId, {
            pdf: expectedExtractionSchemaVersion('pdf'),
            epub: expectedExtractionSchemaVersion('epub'),
            snapshot: expectedExtractionSchemaVersion('snapshot'),
        });
        if (attachmentIds.length === 0) return [];
        return (await Zotero.Items.getAsync(attachmentIds))
            .map(attachment => attachment ? attachment.parentID : false)
            .filter((parentId): parentId is number => typeof parentId === 'number');
    }

    /** Enqueue extraction for resolved units whose derived text is missing or outdated. */
    private async enqueueExtractions(resolutions: { candidate: ExtractionCandidate | null }[]): Promise<void> {
        const candidates = resolutions
            .map(r => r.candidate)
            .filter((c): c is ExtractionCandidate => c !== null);
        if (candidates.length === 0) return;
        try {
            await enqueueEmbeddingExtractions(candidates, this.db);
        } catch (error) {
            // Units still index from metadata; the next diff or event retries.
            logger(`EmbeddingIndexer: Failed to enqueue extractions: ${(error as Error).message}`, 2);
        }
    }

    /**
     * Identical text can come from a different attachment (e.g. a duplicate PDF
     * replacing the original). Keep the reverse link current without re-embedding.
     */
    private async syncUnchangedSources(
        units: Pick<ItemIndexData, 'itemId' | 'source' | 'sourceAttachmentId'>[],
    ): Promise<void> {
        if (units.length === 0) return;
        const stored = await this.db.getEmbeddingSources(units.map(u => u.itemId));
        const updates = units.filter(u => {
            const current = stored.get(u.itemId);
            return current && (current.source !== u.source || current.sourceAttachmentId !== u.sourceAttachmentId);
        });
        await this.db.updateEmbeddingSources(updates.map(u => ({
            itemId: u.itemId, source: u.source, sourceAttachmentId: u.sourceAttachmentId,
        })));
    }

    /** Remove derived text of attachments that no longer exist in the library. */
    private async cleanupOrphanedEmbeddingTexts(libraryId: number): Promise<void> {
        const keys = await this.db.getAttachmentEmbeddingTextKeys(libraryId);
        const orphaned = keys.filter(key => !Zotero.Items.getIDFromLibraryAndKey(libraryId, key));
        if (orphaned.length > 0) {
            await this.db.deleteAttachmentEmbeddingTexts(orphaned.map(zoteroKey => ({ libraryId, zoteroKey })));
            logger(`EmbeddingIndexer: Removed derived text of ${orphaned.length} deleted attachments in library ${libraryId}`, 3);
        }
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
            isCancelled?: () => boolean; // Optional cancellation check between batches
            /** Called before each embedding API request, i.e. only when something is re-embedded. */
            onEmbed?: () => void;
            /**
             * Also enqueue extraction for units whose derived text is missing or
             * outdated, after checking the given attachments' files.
             */
            extractions?: FileIdentityCheck;
        } = {}
    ): Promise<IndexingResult> {
        const { batchSize = INDEX_BATCH_SIZE, skipUnchanged = false, onProgress, isCancelled } = options;

        const result: IndexingResult = {
            indexed: 0,
            skipped: 0,
            failed: 0,
            errors: [],
            incomplete: false,
            unindexable: [],
        };

        if (itemIds.length === 0) {
            return result;
        }

        // Process in batches
        for (let i = 0; i < itemIds.length; i += batchSize) {
            if (isCancelled?.()) {
                logger(`indexItemIdsBatch: Cancelled at batch offset ${i}/${itemIds.length}`, 3);
                return result;
            }
            const batchIds = itemIds.slice(i, i + batchSize);

            // Items "in flight" to the API/upsert
            let itemsToProcess: ItemIndexData[] = [];
            // Best-known retryable set before the API call. This excludes
            // non-regular and too-short items even if the batch fails during
            // local preprocessing (e.g. content-hash lookup).
            let retryablePreApiItems: Array<{ itemId: number; libraryId: number }> = [];

            try {
                // ----- Phase 1: load items + bulk metadata -----
                const items = await Zotero.Items.getAsync(batchIds);
                
                // Load required data types
                if (items.length > 0) {
                    await Zotero.Items.loadDataTypes(items, ["primaryData", "itemData", "creators"]);
                }

                // Pre-fetch clientDateModified for the whole batch in one SQL query.
                let clientDatesMap = new Map<number, string>();
                try {
                    clientDatesMap = await getClientDateModifiedBatch(items);
                } catch (datesError) {
                    // SQL error or similar: fall back to per-item now() and surface the error
                    logger(`indexItemIdsBatch: getClientDateModifiedBatch failed, falling back to current time: ${(datesError as Error).message}`, 2);
                    recordIndexingError(result, datesError);
                }

                // Derived-text lookups are batched; a failure here leaves the
                // batch incomplete like any other pre-API failure.
                const resolutions = new Map(
                    (await resolveUnitsBatch(items.filter(Boolean), this.db, options.extractions))
                        .map(r => [r.item.id, r]),
                );
                if (options.extractions) {
                    await this.enqueueExtractions([...resolutions.values()]);
                }

                // ----- Phase 2: per-item validation (per-item try/catch) -----
                // A poison item now fails alone instead of taking the whole batch down.
                const itemsData: ItemIndexData[] = [];

                for (const item of items) {
                    try {
                        const resolution = item ? resolutions.get(item.id) : undefined;
                        if (resolution?.error) throw resolution.error;
                        const unit = resolution?.unit;
                        if (!item || !unit) {
                            result.skipped++;
                            if (item) result.unindexable.push(item.id);
                            continue;
                        }

                        itemsData.push({
                            itemId: item.id,
                            libraryId: item.libraryID,
                            zoteroKey: item.key,
                            version: item.version,
                            text: unit.text,
                            source: unit.source,
                            sourceAttachmentId: unit.sourceAttachmentId,
                            clientDateModified: clientDatesMap.get(item.id) || new Date().toISOString(),
                        });
                    } catch (itemError) {
                        // Individual item blew up (corrupt field, type error, etc.).
                        // Count just this item, record it in the failed table, and keep going.
                        result.failed++;
                        recordIndexingError(result, itemError);
                        logger(`indexItemIdsBatch: Item ${item?.id} validation failed (${(itemError as Error).name}): ${(itemError as Error).message}`, 1);
                        if (item && item.id !== undefined && item.libraryID !== undefined) {
                            try {
                                await this.db.recordFailedEmbeddingsBatch(
                                    [{ itemId: item.id, libraryId: item.libraryID }],
                                    sanitizeErrorMessage((itemError as Error).message || ''),
                                );
                            } catch (trackError) {
                                logger(`indexItemIdsBatch: Failed to record per-item failure: ${(trackError as Error).message}`, 1);
                            }
                        }
                    }
                }

                if (itemsData.length === 0) {
                    if (onProgress) {
                        onProgress(result.indexed + result.skipped + result.failed, itemIds.length);
                    }
                    continue;
                }

                retryablePreApiItems = itemsData.map(itemData => ({
                    itemId: itemData.itemId,
                    libraryId: itemData.libraryId,
                }));

                // ----- Phase 3: skipUnchanged filter -----
                // Compute the filtered candidates in a local variable. We do NOT
                // assign itemsToProcess here yet — if getContentHashes() throws,
                // we want the failure to land in the "incomplete" path, not the
                // "API failed → mark items as failed" path. (P2 fix)
                let candidates: ItemIndexData[] = itemsData;
                if (skipUnchanged) {
                    const itemIdsToCheck = itemsData.map(d => d.itemId);
                    const existingHashes = await this.db.getContentHashes(itemIdsToCheck);

                    const unchanged: ItemIndexData[] = [];
                    candidates = itemsData.filter(itemData => {
                        const newHash = BeaverDB.computeContentHash(itemData.text);
                        const existingHash = existingHashes.get(itemData.itemId);

                        // Include if no existing hash (new item) or hash changed
                        const needsIndexing = existingHash === undefined || existingHash !== newHash;
                        if (!needsIndexing) {
                            result.skipped++;
                            unchanged.push(itemData);
                        }
                        return needsIndexing;
                    });
                    await this.syncUnchangedSources(unchanged);
                }

                if (candidates.length === 0) {
                    if (onProgress) {
                        onProgress(result.indexed + result.skipped + result.failed, itemIds.length);
                    }
                    continue;
                }

                // Mark items as in-flight only now that the local hash lookup
                // has succeeded and we're committed to sending them to the API.
                itemsToProcess = candidates;

                // ----- Phase 4: API call -----
                const texts = itemsToProcess.map(item => item.text);
                const ids = itemsToProcess.map(item => item.itemId);

                if (isCancelled?.()) return result;
                options.onEmbed?.();
                const response = await embeddingsService.generateEmbeddingsWithRetry(texts, ids);
                if (isCancelled?.()) return result;

                // ----- Phase 5: process response -----
                const embeddingRecords: Array<Omit<EmbeddingRecord, 'indexed_at'>> = [];
                const successfulItemIds: number[] = [];

                for (let j = 0; j < itemsToProcess.length; j++) {
                    const itemData = itemsToProcess[j];
                    const embeddingData = response.embeddings.find(e => e.item_id === itemData.itemId);

                    if (!embeddingData) {
                        // Backend returned 200 but the response is missing this item_id.
                        // This shouldn't happen given the backend's positional mapping
                        // (and the new defensive assertion in routes/embeddings.py),
                        // but surface it loudly if it ever does.
                        result.failed++;
                        recordIndexingError(result, new Error('embedding_missing_in_response'));
                        continue;
                    }

                    const text = texts[j];
                    const contentHash = BeaverDB.computeContentHash(text);
                    const clientDateModified = itemData.clientDateModified || new Date().toISOString();

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
                        source: itemData.source,
                        source_attachment_id: itemData.sourceAttachmentId,
                    });
                    
                    successfulItemIds.push(itemData.itemId);
                }

                // ----- Phase 6: persist embeddings -----
                if (embeddingRecords.length > 0) {
                    await this.db.upsertEmbeddingsBatch(embeddingRecords);
                    result.indexed += embeddingRecords.length;
                    
                    // Remove successful items from failed tracking
                    await this.db.removeFailedEmbeddingsBatch(successfulItemIds);
                }

            } catch (error) {
                if (isCancelled?.()) return result;
                const errorName = (error as Error).name || 'Error';
                const rawMessage = (error as Error).message || String(error);
                logger(`indexItemIdsBatch: Batch failed at offset ${i} (${errorName}): ${rawMessage}`, 1);
                recordIndexingError(result, error);

                // Determine which items to mark as failed:
                // - If we got past phase 4 (itemsToProcess set), the failure happened
                //   during the API call or upsert; record exactly those items.
                // - If we never reached phase 4, the failure was during loading,
                //   loadDataTypes, getClientDateModifiedBatch, or getContentHashes.
                //   We don't know which items would have been valid, so mark the
                //   result as incomplete and the caller MUST NOT save the library
                //   state for this run — otherwise unindexed items would be
                //   silently invisible until the weekly safety diff (P1 fix).
                if (itemsToProcess.length > 0) {
                    const failedItemRecords = itemsToProcess.map(d => ({
                        itemId: d.itemId,
                        libraryId: d.libraryId,
                    }));
                    try {
                        await this.db.recordFailedEmbeddingsBatch(
                            failedItemRecords,
                            sanitizeErrorMessage(rawMessage),
                        );
                        result.failed += failedItemRecords.length;
                        logger(`indexItemIdsBatch: Recorded ${failedItemRecords.length} items as failed`, 3);
                    } catch (trackError) {
                        // Even DB write failed — count items as failed for the report
                        // but log the secondary failure.
                        result.failed += failedItemRecords.length;
                        logger(`indexItemIdsBatch: Failed to track failed items: ${(trackError as Error).message}`, 1);
                    }
                } else {
                    // Pre-API failure: failure happened during loading,
                    // loadDataTypes, getClientDateModifiedBatch, or getContentHashes.
                    result.incomplete = true;
                    logger(`indexItemIdsBatch: Batch incomplete; ${retryablePreApiItems.length} validated items will be re-checked next pass`, 2);

                    try {
                        if (retryablePreApiItems.length > 0) {
                            await this.db.recordFailedEmbeddingsBatch(
                                retryablePreApiItems,
                                sanitizeErrorMessage(rawMessage),
                                { incrementExisting: false },
                            );
                            logger(`indexItemIdsBatch: Queued ${retryablePreApiItems.length} items for retry (transient pre-API failure)`, 2);
                        }
                    } catch (trackError) {
                        logger(`indexItemIdsBatch: Failed to queue items for retry after incomplete batch: ${(trackError as Error).message}`, 1);
                    }
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
        // Derived attachment text follows the same scope as embeddings.
        await this.db.deleteAttachmentEmbeddingTextsOutsideLibraries(syncedLibraryIds);

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

