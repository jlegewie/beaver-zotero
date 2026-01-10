import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { isAuthenticatedAtom } from "../atoms/auth";
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom, searchableLibraryIdsAtom, processingModeAtom } from "../atoms/profile";
import { ProcessingMode } from "../types/profile";
import { 
    embeddingIndexStateAtom, 
    setEmbeddingIndexStatusAtom, 
    EmbeddingIndexState,
    updateEmbeddingIndexProgressAtom,
    forceReindexCounterAtom,
    updateFailedItemsCountAtom
} from "../atoms/embeddingIndex";
import { EmbeddingIndexer, MIN_CONTENT_LENGTH, INDEX_BATCH_SIZE } from "../../src/services/embeddingIndexer";
import { BeaverDB } from "../../src/services/database";
import { embeddingsService } from "../../src/services/embeddingsService";
import { logger } from "../../src/utils/logger";
import { store } from "../store";


const EVENT_DEBOUNCE_MS = 4000; // Same as useZoteroSync

/**
 * Module-level variable to track the Zotero notifier observer ID.
 * This persists across hot-reloads to ensure proper cleanup.
 */
let moduleNotifierId: string | null = null;

/**
 * Interface for collected embedding index events
 */
interface CollectedEvents {
    modifiedItemIds: Set<number>;   // Item IDs that were added or modified
    deletedItemIds: Set<number>;    // Item IDs that were deleted
    timer: NodeJS.Timeout | null;   // Timer ID for debounce
    timestamp: number;              // Last event timestamp
}

/**
 * Hook that manages embedding index for semantic search:
 * - Only indexes libraries in searchableLibraryIds
 * - Cleans up embeddings from libraries removed from searchableLibraryIds
 * - Performs initial indexing on mount for searchableLibraryIds
 * - Sets up listeners for item changes with debouncing (filtered to searchableLibraryIds)
 * - Updates embeddings incrementally based on content hash changes
 */
export function useEmbeddingIndex() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isAuthorized = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    // Use searchableLibraryIds: Free users index ALL libraries, Pro users index synced only
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const forceReindexCounter = useAtomValue(forceReindexCounterAtom);
    const processingMode = useAtomValue(processingModeAtom);

    // Atoms for state management
    const setIndexStatus = useSetAtom(setEmbeddingIndexStatusAtom);
    const updateProgress = useSetAtom(updateEmbeddingIndexProgressAtom);
    const updateFailedCount = useSetAtom(updateFailedItemsCountAtom);


    // Ref for collected events
    const eventsRef = useRef<CollectedEvents>({
        modifiedItemIds: new Set(),
        deletedItemIds: new Set(),
        timer: null,
        timestamp: 0
    });

    // Ref for the indexer instance
    const indexerRef = useRef<EmbeddingIndexer | null>(null);
    
    // Ref to track previous forceReindexCounter for detecting manual reindex requests
    const prevForceReindexCounterRef = useRef<number>(forceReindexCounter);

    /**
     * Get the BeaverDB instance from addon
     */
    const getDB = (): BeaverDB | null => {
        return Zotero.Beaver?.db as BeaverDB | null;
    };

    /**
     * Get or create the indexer instance
     */
    const getIndexer = (): EmbeddingIndexer | null => {
        if (indexerRef.current) return indexerRef.current;
        
        const db = getDB();
        if (!db) {
            logger("useEmbeddingIndex: BeaverDB not available", 2);
            return null;
        }

        indexerRef.current = new EmbeddingIndexer(db);
        return indexerRef.current;
    };

    /**
     * Format duration in milliseconds to a human-readable string
     */
    const formatDuration = (ms: number): string => {
        if (ms < 1000) {
            return `${Math.round(ms)}ms`;
        }
        return `${(ms / 1000).toFixed(2)}s`;
    };

    /**
     * Perform initial indexing of searchable libraries only.
     * First cleans up embeddings from libraries no longer in searchableLibraryIds.
     * Uses optimized diff check to skip full scans when nothing changed.
     * Falls back to full diff when changes are detected or on periodic safety check.
     * Also retries previously failed items that are ready for retry.
     * @param libraryIds Array of library IDs to index (from searchableLibraryIds)
     * @param forceFullDiff If true, bypass shouldRunFullDiff and process all libraries
     */
    const performInitialIndexing = async (libraryIds: number[], forceFullDiff: boolean = false) => {
        const startTime = Date.now();
        const indexer = getIndexer();
        if (!indexer) return;

        logger("useEmbeddingIndex: Starting initial indexing check", 3);
        setIndexStatus({ status: 'indexing', phase: 'initial' });

        try {
            // First, clean up embeddings from libraries no longer in searchableLibraryIds
            // This runs even when libraryIds is empty to remove all stale embeddings
            const cleanup = await indexer.cleanupUnsyncedLibraries(libraryIds);
            if (cleanup.librariesRemoved > 0) {
                logger(`useEmbeddingIndex: Cleaned up ${cleanup.embeddingsRemoved} embeddings from ${cleanup.librariesRemoved} unsynced libraries`, 3);
            }

            // If force reindex requested, clear all failed embeddings to retry them
            if (forceFullDiff && libraryIds.length > 0) {
                const clearedCount = await indexer.clearFailedEmbeddings(libraryIds);
                if (clearedCount > 0) {
                    logger(`useEmbeddingIndex: Cleared ${clearedCount} failed embeddings for force reindex`, 3);
                }
            }

            // If no libraries to index, we're done after cleanup
            if (libraryIds.length === 0) {
                const duration = Date.now() - startTime;
                logger(`useEmbeddingIndex: No libraries to index (searchableLibraryIds is empty) - completed in ${formatDuration(duration)}`, 3);
                // Still update failed count to reflect any existing failures in DB
                const failedStats = await indexer.getFailedStats();
                updateFailedCount(failedStats.permanentlyFailed);
                setIndexStatus({ status: 'idle', phase: 'initial' });
                return;
            }

            if (forceFullDiff) {
                logger(`useEmbeddingIndex: Force full diff requested - processing all ${libraryIds.length} libraries`, 3);
            } else {
                logger(`useEmbeddingIndex: Found ${libraryIds.length} searchable libraries to check`, 3);
            }

            // First pass: check which libraries need a full diff
            // This is fast - just SQL queries for MAX(date) and COUNT
            // Skip this check if forceFullDiff is true
            const librariesToProcess: number[] = [];
            const libraryStates: Map<number, { maxClientDateModified: string | null, itemCount: number }> = new Map();

            for (const libraryId of libraryIds) {
                // If forceFullDiff, process all libraries without checking
                if (forceFullDiff) {
                    librariesToProcess.push(libraryId);
                    const state = await indexer.getZoteroLibraryState(libraryId);
                    libraryStates.set(libraryId, state);
                    continue;
                }

                const diffCheck = await indexer.shouldRunFullDiff(libraryId);
                
                if (diffCheck.needsDiff) {
                    logger(`useEmbeddingIndex: Library ${libraryId} needs diff: ${diffCheck.reason}`, 3);
                    librariesToProcess.push(libraryId);
                    // Get and store the current state for later
                    const state = await indexer.getZoteroLibraryState(libraryId);
                    libraryStates.set(libraryId, state);
                } else {
                    logger(`useEmbeddingIndex: Library ${libraryId} skipped: ${diffCheck.reason}`, 4);
                }
            }

            // Collect items ready for retry across synced libraries only
            const itemsReadyForRetry: number[] = [];
            for (const libraryId of libraryIds) {
                const retryItems = await indexer.getItemsReadyForRetry(libraryId);
                itemsReadyForRetry.push(...retryItems);
            }
            if (itemsReadyForRetry.length > 0) {
                logger(`useEmbeddingIndex: Found ${itemsReadyForRetry.length} items ready for retry across synced libraries`, 3);
            }

            // If no libraries need processing and no retries, we're done
            if (librariesToProcess.length === 0 && itemsReadyForRetry.length === 0) {
                const duration = Date.now() - startTime;
                logger(`useEmbeddingIndex: All libraries up to date, no retries needed - completed in ${formatDuration(duration)}`, 3);
                // Still update failed count to reflect any existing failures in DB
                const failedStats = await indexer.getFailedStats();
                updateFailedCount(failedStats.permanentlyFailed);
                setIndexStatus({ status: 'idle', phase: 'incremental' });
                return;
            }

            // Second pass: compute diff only for libraries that need it
            let totalToIndex = 0;
            let totalToDelete = 0;
            const libraryDiffs: Map<number, { toIndex: number[], toDelete: number[], totalIndexable: number }> = new Map();

            for (const libraryId of librariesToProcess) {
                logger(`useEmbeddingIndex: Computing diff for library ${libraryId}`, 4);
                const diff = await indexer.computeIndexingDiff(libraryId, MIN_CONTENT_LENGTH);
                
                // Filter out items that are still in backoff period
                const filteredToIndex = await indexer.filterItemsNotInBackoff(diff.toIndex);
                const skippedDueToBackoff = diff.toIndex.length - filteredToIndex.length;
                if (skippedDueToBackoff > 0) {
                    logger(`useEmbeddingIndex: Library ${libraryId}: ${skippedDueToBackoff} items still in backoff`, 4);
                }
                
                libraryDiffs.set(libraryId, { 
                    toIndex: filteredToIndex, 
                    toDelete: diff.toDelete, 
                    totalIndexable: diff.totalIndexable 
                });
                totalToIndex += filteredToIndex.length;
                totalToDelete += diff.toDelete.length;
            }

            // Add retry items to total (they may overlap with diff items, but that's fine)
            const uniqueRetryItems = itemsReadyForRetry.filter(id => {
                // Check if this item is already in any library diff
                for (const diff of libraryDiffs.values()) {
                    if (diff.toIndex.includes(id)) return false;
                }
                return true;
            });
            totalToIndex += uniqueRetryItems.length;

            logger(`useEmbeddingIndex: Total: ${totalToIndex} to index (including ${uniqueRetryItems.length} retries), ${totalToDelete} to delete across ${librariesToProcess.length} libraries`, 3);
            store.set(embeddingIndexStateAtom, (prev: EmbeddingIndexState) => ({
                ...prev,
                totalItems: totalToIndex,
            }));

            // Third pass: process each library and save state
            let processedItems = 0;
            let totalIndexed = 0;
            let totalSkipped = 0;
            let totalFailed = 0;
            const db = getDB();

            for (const libraryId of librariesToProcess) {
                const diff = libraryDiffs.get(libraryId);
                const zoteroState = libraryStates.get(libraryId);
                if (!diff) continue;

                // Clean up failed embeddings for deleted items
                const cleanedUp = await indexer.cleanupDeletedFailedEmbeddings(libraryId);
                if (cleanedUp > 0) {
                    logger(`useEmbeddingIndex: Cleaned up ${cleanedUp} failed records for deleted items in library ${libraryId}`, 3);
                }

                // Delete orphaned embeddings
                if (diff.toDelete.length > 0 && db) {
                    await db.deleteEmbeddingsBatch(diff.toDelete);
                    logger(`useEmbeddingIndex: Deleted ${diff.toDelete.length} orphaned embeddings from library ${libraryId}`, 3);
                }

                // Index items that need (re-)indexing
                if (diff.toIndex.length > 0) {
                    logger(`useEmbeddingIndex: Indexing ${diff.toIndex.length} items in library ${libraryId}`, 3);

                    const result = await indexer.indexItemIdsBatch(diff.toIndex, {
                        batchSize: INDEX_BATCH_SIZE,
                        onProgress: (processed, total) => {
                            updateProgress({
                                indexedItems: processedItems + processed,
                                totalItems: totalToIndex,
                            });
                        },
                    });

                    processedItems += result.indexed + result.skipped + result.failed;
                    totalIndexed += result.indexed;
                    totalSkipped += result.skipped;
                    totalFailed += result.failed;
                    logger(`useEmbeddingIndex: Library ${libraryId} complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`, 3);
                }

                // Save the index state for this library (for future quick checks)
                if (zoteroState) {
                    await indexer.saveIndexState(libraryId, zoteroState);
                    logger(`useEmbeddingIndex: Saved index state for library ${libraryId}`, 4);
                }
            }

            // Fourth pass: process retry items that weren't covered by library diffs
            if (uniqueRetryItems.length > 0) {
                logger(`useEmbeddingIndex: Processing ${uniqueRetryItems.length} retry items`, 3);
                
                const result = await indexer.indexItemIdsBatch(uniqueRetryItems, {
                    batchSize: INDEX_BATCH_SIZE,
                    onProgress: (processed, total) => {
                        updateProgress({
                            indexedItems: processedItems + processed,
                            totalItems: totalToIndex,
                        });
                    },
                });

                processedItems += result.indexed + result.skipped + result.failed;
                totalIndexed += result.indexed;
                totalSkipped += result.skipped;
                totalFailed += result.failed;
                logger(`useEmbeddingIndex: Retry items complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`, 3);
            }

            // Log final failed stats and update UI
            const failedStats = await indexer.getFailedStats();
            if (failedStats.totalFailed > 0) {
                logger(`useEmbeddingIndex: Failed items summary: ${failedStats.totalFailed} total, ${failedStats.readyForRetry} ready for retry, ${failedStats.permanentlyFailed} permanently failed`, 3);
            }
            updateFailedCount(failedStats.permanentlyFailed);

            const duration = Date.now() - startTime;
            logger(`useEmbeddingIndex: Initial indexing complete - took ${formatDuration(duration)}`, 3);
            setIndexStatus({ status: 'idle', phase: 'incremental' });

            // Report indexing completion to backend (fire-and-forget)
            // Only report if there was actual work done
            if (totalIndexed > 0 || totalFailed > 0 || totalToDelete > 0) {
                embeddingsService.reportIndexingComplete({
                    items_indexed: totalIndexed,
                    items_failed: totalFailed,
                    items_skipped: totalSkipped,
                    libraries_count: libraryIds.length,
                    duration_ms: duration,
                    is_force_reindex: forceFullDiff,
                }).catch(() => {
                    // Silently ignore - already logged in the service
                });
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            logger(`useEmbeddingIndex: Initial indexing failed after ${formatDuration(duration)}: ${(error as Error).message}`, 1);
            Zotero.logError(error as Error);
            setIndexStatus({ 
                status: 'error', 
                phase: 'initial',
                error: (error as Error).message 
            });
        }
    };

    
    /**
     * Process collected events for incremental updates.
     * Uses indexItemIdsBatch which loads items per-batch for memory efficiency.
     */
    const processEvents = async () => {
        const indexer = getIndexer();
        if (!indexer) return;

        const modifiedIds = Array.from(eventsRef.current.modifiedItemIds);
        const deletedIds = Array.from(eventsRef.current.deletedItemIds);

        // Clear collections immediately
        eventsRef.current.modifiedItemIds.clear();
        eventsRef.current.deletedItemIds.clear();
        eventsRef.current.timer = null;

        if (modifiedIds.length === 0 && deletedIds.length === 0) return;

        logger(`useEmbeddingIndex: Processing events: ${modifiedIds.length} modified, ${deletedIds.length} deleted`, 3);
        setIndexStatus({ status: 'updating', phase: 'incremental' });

        try {
            const db = getDB();

            // Handle deletions first
            if (deletedIds.length > 0 && db) {
                await db.deleteEmbeddingsBatch(deletedIds);
                logger(`useEmbeddingIndex: Deleted ${deletedIds.length} embeddings`, 3);
            }

            // Handle modifications - indexItemIdsBatch handles per-batch loading
            // and skips items that don't meet criteria or haven't changed
            if (modifiedIds.length > 0) {
                const result = await indexer.indexItemIdsBatch(modifiedIds, {
                    batchSize: INDEX_BATCH_SIZE,
                });
                logger(`useEmbeddingIndex: Updated ${result.indexed} embeddings (${result.skipped} skipped, ${result.failed} failed)`, 3);

                // Items that were skipped might need their embeddings removed
                // (e.g., if title/abstract were cleared below min length)
                // Only delete embeddings for items that exist but don't meet criteria anymore
                if (result.skipped > 0 && db) {
                    // Get existing embeddings for these items
                    const existingEmbeddings = await db.getContentHashes(modifiedIds);
                    const idsWithEmbeddings = modifiedIds.filter(id => existingEmbeddings.has(id));
                    
                    // Check which of these no longer meet criteria
                    if (idsWithEmbeddings.length > 0) {
                        const items = await Zotero.Items.getAsync(idsWithEmbeddings);
                        const stillValidIds = new Set<number>();
                        
                        for (const item of items) {
                            if (item && item.isRegularItem() && indexer.isItemIndexable(item, MIN_CONTENT_LENGTH)) {
                                stillValidIds.add(item.id);
                            }
                        }
                        
                        const toRemove = idsWithEmbeddings.filter(id => !stillValidIds.has(id));
                        if (toRemove.length > 0) {
                            await db.deleteEmbeddingsBatch(toRemove);
                            logger(`useEmbeddingIndex: Removed ${toRemove.length} embeddings for items no longer meeting criteria`, 3);
                        }
                    }
                }
            }

            // Update failed items count after incremental processing
            const failedStats = await indexer.getFailedStats();
            updateFailedCount(failedStats.permanentlyFailed);

            setIndexStatus({ status: 'idle', phase: 'incremental' });

        } catch (error) {
            logger(`useEmbeddingIndex: Event processing failed: ${(error as Error).message}`, 1);
            Zotero.logError(error as Error);
            setIndexStatus({ 
                status: 'error', 
                phase: 'incremental',
                error: (error as Error).message 
            });
        }
    };

    /**
     * Schedule event processing with debounce
     */
    const scheduleEventProcessing = () => {
        eventsRef.current.timestamp = Date.now();

        if (eventsRef.current.timer !== null) {
            clearTimeout(eventsRef.current.timer);
        }

        eventsRef.current.timer = setTimeout(processEvents, EVENT_DEBOUNCE_MS);
    };

    useEffect(() => {
        // Guards - auth/authorization required
        if (!isAuthenticated) return;
        if (!isAuthorized) return;
        if (!isDeviceAuthorized) return;
        if (processingMode === ProcessingMode.BACKEND) return;

        logger("useEmbeddingIndex: Setting up embedding index", 3);

        let isMounted = true;

        // Track the observer ID for this specific hook instance to prevent race conditions during cleanup
        let myObserverId: string | null = null;

        // Create a set for efficient library lookup in event handling
        const searchableLibrarySet = new Set(searchableLibraryIds);

        // Setup observer (only if we have libraries to index)
        const setupObserver = () => {
            // Don't set up observer if no libraries are searchable
            if (searchableLibraryIds.length === 0) return;

            // Unregister any existing observer before registering a new one
            // This handles hot-reload scenarios where cleanup may not have run
            if (moduleNotifierId) {
                try {
                    Zotero.Notifier.unregisterObserver(moduleNotifierId);
                    logger("useEmbeddingIndex: Unregistered stale observer before re-registering", 4);
                } catch (e) {
                    // Ignore errors if observer was already unregistered
                }
                moduleNotifierId = null;
            }

            const observer = {
                notify: async function(event: string, type: string, ids: number[], extraData: any) {
                    // Only handle item events
                    if (type !== 'item') return;

                    let shouldSchedule = false;

                    // Handle add/modify events - filter to synced libraries
                    if (event === 'add' || event === 'modify') {
                        // Load items to check their library
                        const items = await Zotero.Items.getAsync(ids);
                        for (const item of items) {
                            if (item && searchableLibrarySet.has(item.libraryID)) {
                                // Remove from delete set if it was there (item was restored)
                                eventsRef.current.deletedItemIds.delete(item.id);
                                eventsRef.current.modifiedItemIds.add(item.id);
                                shouldSchedule = true;
                            }
                        }
                    }

                    // Handle delete events - use extraData to get libraryID
                    if (event === 'delete') {
                        for (const id of ids) {
                            // For delete events, item no longer exists - check extraData for libraryID
                            if (extraData && extraData[id]) {
                                const { libraryID } = extraData[id];
                                if (libraryID && searchableLibrarySet.has(libraryID)) {
                                    // Remove from modified set
                                    eventsRef.current.modifiedItemIds.delete(id);
                                    eventsRef.current.deletedItemIds.add(id);
                                    shouldSchedule = true;
                                }
                            }
                        }
                    }

                    if (shouldSchedule) {
                        scheduleEventProcessing();
                    }
                }
            // @ts-ignore Zotero.Notifier.Notify is defined
            } as Zotero.Notifier.Notify;

            moduleNotifierId = Zotero.Notifier.registerObserver(observer, ['item'], 'beaver-embedding-index');
            myObserverId = moduleNotifierId;
        };

        // Check if this is a manual reindex request (counter changed)
        const isForceReindex = forceReindexCounter !== prevForceReindexCounterRef.current;
        prevForceReindexCounterRef.current = forceReindexCounter;

        // Initialize indexing
        const initialize = async () => {
            try {
                // Wait a moment for DB to be ready (skip delay for force reindex)
                if (!isForceReindex) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                // Perform initial indexing for searchable libraries only
                // Pass forceFullDiff=true if user clicked "Rebuild Search Index"
                await performInitialIndexing(searchableLibraryIds, isForceReindex);

                // Setup observer after initial indexing
                if (isMounted) setupObserver();

            } catch (error) {
                logger(`useEmbeddingIndex: Initialization failed: ${(error as Error).message}`, 1);
                Zotero.logError(error as Error);
                if (isMounted) setupObserver(); // Still set up observer even if initial indexing fails
            }
        };

        initialize();

        // Cleanup
        return () => {
            isMounted = false;
            logger("useEmbeddingIndex: Cleaning up embedding index", 3);

            // Unregister observer
            if (moduleNotifierId && moduleNotifierId === myObserverId) {
                Zotero.Notifier.unregisterObserver(myObserverId);
                moduleNotifierId = null;
            }

            // Clear pending timer
            if (eventsRef.current.timer !== null) {
                clearTimeout(eventsRef.current.timer);
                eventsRef.current.timer = null;
            }

            // Process remaining events in background
            const hasRemainingEvents = 
                eventsRef.current.modifiedItemIds.size > 0 || 
                eventsRef.current.deletedItemIds.size > 0;

            if (hasRemainingEvents) {
                processEvents().catch(error => {
                    logger(`useEmbeddingIndex: Error processing remaining events: ${(error as Error).message}`, 1);
                });
            }

            // Clear collections
            eventsRef.current.modifiedItemIds.clear();
            eventsRef.current.deletedItemIds.clear();

            // Clear indexer reference
            indexerRef.current = null;
        };
    }, [isAuthenticated, isAuthorized, isDeviceAuthorized, processingMode, searchableLibraryIds, forceReindexCounter]);
}

