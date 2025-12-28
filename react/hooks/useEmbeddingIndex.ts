import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { isAuthenticatedAtom } from "../atoms/auth";
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom } from "../atoms/profile";
import { 
    embeddingIndexStateAtom, 
    setEmbeddingIndexStatusAtom, 
    EmbeddingIndexState,
    updateEmbeddingIndexProgressAtom 
} from "../atoms/embeddingIndex";
import { EmbeddingIndexer, MIN_CONTENT_LENGTH, INDEX_BATCH_SIZE } from "../../src/services/embeddingIndexer";
import { BeaverDB } from "../../src/services/database";
import { logger } from "../../src/utils/logger";
import { store } from "../store";


const EVENT_DEBOUNCE_MS = 4000; // Same as useZoteroSync

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
 * - Performs initial indexing on mount (all libraries, sorted by recent modifications)
 * - Sets up listeners for item changes with debouncing
 * - Updates embeddings incrementally based on content hash changes
 */
export function useEmbeddingIndex() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isAuthorized = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);

    // Atoms for state management
    const setIndexStatus = useSetAtom(setEmbeddingIndexStatusAtom);
    const updateProgress = useSetAtom(updateEmbeddingIndexProgressAtom);

    // Ref to prevent multiple registrations
    const zoteroNotifierIdRef = useRef<string | null>(null);

    // Ref for collected events
    const eventsRef = useRef<CollectedEvents>({
        modifiedItemIds: new Set(),
        deletedItemIds: new Set(),
        timer: null,
        timestamp: 0
    });

    // Ref for the indexer instance
    const indexerRef = useRef<EmbeddingIndexer | null>(null);

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
     * Perform initial indexing of all libraries.
     * Uses optimized diff check to skip full scans when nothing changed.
     * Falls back to full diff when changes are detected or on periodic safety check.
     * Also retries previously failed items that are ready for retry.
     */
    const performInitialIndexing = async () => {
        const indexer = getIndexer();
        if (!indexer) return;

        logger("useEmbeddingIndex: Starting initial indexing check", 3);
        setIndexStatus({ status: 'indexing', phase: 'initial' });

        try {
            // Get libraries sorted (user library first)
            const libraryIds = indexer.getLibrariesSorted();
            logger(`useEmbeddingIndex: Found ${libraryIds.length} libraries to check`, 3);

            // First pass: check which libraries need a full diff
            // This is fast - just SQL queries for MAX(date) and COUNT
            const librariesToProcess: number[] = [];
            const libraryStates: Map<number, { maxClientDateModified: string | null, itemCount: number }> = new Map();

            for (const libraryId of libraryIds) {
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

            // Collect items ready for retry across all libraries
            const itemsReadyForRetry = await indexer.getItemsReadyForRetry();
            if (itemsReadyForRetry.length > 0) {
                logger(`useEmbeddingIndex: Found ${itemsReadyForRetry.length} items ready for retry`, 3);
            }

            // If no libraries need processing and no retries, we're done
            if (librariesToProcess.length === 0 && itemsReadyForRetry.length === 0) {
                logger("useEmbeddingIndex: All libraries up to date, no retries needed", 3);
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
                logger(`useEmbeddingIndex: Retry items complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`, 3);
            }

            // Log final failed stats
            const failedStats = await indexer.getFailedStats();
            if (failedStats.totalFailed > 0) {
                logger(`useEmbeddingIndex: Failed items summary: ${failedStats.totalFailed} total, ${failedStats.readyForRetry} ready for retry, ${failedStats.permanentlyFailed} permanently failed`, 3);
            }

            logger("useEmbeddingIndex: Initial indexing complete", 3);
            setIndexStatus({ status: 'idle', phase: 'incremental' });

        } catch (error) {
            logger(`useEmbeddingIndex: Initial indexing failed: ${(error as Error).message}`, 1);
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
        // Guards
        if (!isAuthenticated) return;
        if (!isAuthorized) return;
        if (!isDeviceAuthorized) return;

        logger("useEmbeddingIndex: Setting up embedding index", 3);

        // Setup observer
        const setupObserver = () => {
            const observer = {
                notify: async function(event: string, type: string, ids: number[], extraData: any) {
                    // Only handle item events
                    if (type !== 'item') return;

                    let shouldSchedule = false;

                    // Handle add/modify events
                    if (event === 'add' || event === 'modify') {
                        for (const id of ids) {
                            // Remove from delete set if it was there (item was restored)
                            eventsRef.current.deletedItemIds.delete(id);
                            eventsRef.current.modifiedItemIds.add(id);
                        }
                        shouldSchedule = true;
                    }

                    // Handle delete events
                    if (event === 'delete') {
                        for (const id of ids) {
                            // Remove from modified set
                            eventsRef.current.modifiedItemIds.delete(id);
                            eventsRef.current.deletedItemIds.add(id);
                        }
                        shouldSchedule = true;
                    }

                    if (shouldSchedule) {
                        scheduleEventProcessing();
                    }
                }
            // @ts-ignore Zotero.Notifier.Notify is defined
            } as Zotero.Notifier.Notify;

            zoteroNotifierIdRef.current = Zotero.Notifier.registerObserver(observer, ['item'], 'beaver-embedding-index');
        };

        // Initialize indexing
        const initialize = async () => {
            try {
                // Wait a moment for DB to be ready
                await new Promise(resolve => setTimeout(resolve, 500));

                // Perform initial indexing
                await performInitialIndexing();

                // Setup observer after initial indexing
                setupObserver();

            } catch (error) {
                logger(`useEmbeddingIndex: Initialization failed: ${(error as Error).message}`, 1);
                Zotero.logError(error as Error);
                setupObserver(); // Still set up observer even if initial indexing fails
            }
        };

        initialize();

        // Cleanup
        return () => {
            logger("useEmbeddingIndex: Cleaning up embedding index", 3);

            // Unregister observer
            if (zoteroNotifierIdRef.current) {
                Zotero.Notifier.unregisterObserver(zoteroNotifierIdRef.current);
                zoteroNotifierIdRef.current = null;
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
    }, [isAuthenticated, isAuthorized, isDeviceAuthorized]);
}

