import {
    EmbeddingIndexer,
    IndexingError,
    MIN_CONTENT_LENGTH,
    INDEX_BATCH_SIZE,
    mergeIndexingErrors,
} from "./embeddingIndexer";
import { BeaverDB } from "./database";
import { embeddingsService } from "@beaver/agent-core/transport/clients/embeddingsService";
import { logger } from "@beaver/agent-core/platform/logger";
import { getPref, setPref } from "../utils/prefs";

export interface EmbeddingIndexState {
    status: "idle" | "indexing" | "updating" | "error";
    phase: "initial" | "incremental";
    progress: number;
    totalItems: number;
    indexedItems: number;
    failedItems: number;
    error?: string;
}
export const initialEmbeddingState: EmbeddingIndexState = {
    status: "idle",
    phase: "initial",
    progress: 0,
    totalItems: 0,
    indexedItems: 0,
    failedItems: 0,
};
const EVENT_DEBOUNCE_MS = 4000;

/** Pending item changes outlive an indexing generation's observer and timer. */
export interface PendingEmbeddingEvents {
    modifiedItemIds: Set<number>;
    deletedItemIds: Set<number>;
}

/** One generation of indexing; the owner serializes generations and event drains. */
export function startEmbeddingIndex(
    searchableLibraryIds: number[],
    isForceReindex: boolean,
    onUpdate: (update: Partial<EmbeddingIndexState>) => void,
    serialize: (work: () => Promise<void>) => Promise<void>,
    pendingEvents: PendingEmbeddingEvents,
): () => void {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const publish = (update: Partial<EmbeddingIndexState>) => {
        if (!cancelled) onUpdate(update);
    };
    const setIndexStatus = (
        update: Pick<EmbeddingIndexState, "status"> &
            Partial<EmbeddingIndexState>,
    ) =>
        publish({
            error: undefined,
            ...update,
            ...(update.status === "indexing" || update.status === "updating"
                ? { progress: 0, indexedItems: 0 }
                : {}),
        });
    const updateProgress = (update: {
        indexedItems: number;
        totalItems: number;
    }) =>
        publish({
            ...update,
            progress:
                update.totalItems > 0
                    ? Math.round(
                          (update.indexedItems / update.totalItems) * 100,
                      )
                    : 0,
        });
    const updateFailedCount = (failedItems: number) => publish({ failedItems });
    const eventsRef = {
        current: {
            ...pendingEvents,
            timer: null as ReturnType<typeof setTimeout> | null,
            timestamp: 0,
        },
    };
    const indexerRef = { current: null as EmbeddingIndexer | null };
    let moduleNotifierId: string | null = null;
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
            logger("EmbeddingIndex: BeaverDB not available", 2);
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
    const performInitialIndexing = async (
        libraryIds: number[],
        forceFullDiff: boolean = false,
        isCancelled?: () => boolean,
    ) => {
        const startTime = Date.now();
        const indexer = getIndexer();
        if (!indexer) return;

        logger("EmbeddingIndex: Starting initial indexing check", 3);
        setIndexStatus({ status: "indexing", phase: "initial" });

        try {
            // First, clean up embeddings from libraries no longer in searchableLibraryIds
            // This runs even when libraryIds is empty to remove all stale embeddings
            const cleanup = await indexer.cleanupUnsyncedLibraries(libraryIds);
            if (cleanup.librariesRemoved > 0) {
                logger(
                    `EmbeddingIndex: Cleaned up ${cleanup.embeddingsRemoved} embeddings from ${cleanup.librariesRemoved} unsynced libraries`,
                    3,
                );
            }

            // If force reindex requested, clear all failed embeddings to retry them
            if (forceFullDiff && libraryIds.length > 0) {
                const clearedCount =
                    await indexer.clearFailedEmbeddings(libraryIds);
                if (clearedCount > 0) {
                    logger(
                        `EmbeddingIndex: Cleared ${clearedCount} failed embeddings for force reindex`,
                        3,
                    );
                }
            }

            // If no libraries to index, we're done after cleanup
            if (libraryIds.length === 0) {
                const duration = Date.now() - startTime;
                logger(
                    `EmbeddingIndex: No libraries to index (searchableLibraryIds is empty) - completed in ${formatDuration(duration)}`,
                    3,
                );
                // Still update failed count to reflect any existing failures in DB
                const failedStats = await indexer.getFailedStats();
                updateFailedCount(failedStats.permanentlyFailed);
                setIndexStatus({ status: "idle", phase: "initial" });
                return;
            }

            // Check for upgrade-triggered full diff (clears stored index state so shouldRunFullDiff returns true)
            const needsUpgradeDiff = getPref("runEmbeddingFullDiff");
            if (needsUpgradeDiff) {
                logger(
                    "EmbeddingIndex: Upgrade-triggered embedding full diff - clearing index state for all libraries",
                    3,
                );
                const dbInstance = getDB();
                if (dbInstance) {
                    // Clear index state for all libraries
                    const allLibraries = Zotero.Libraries.getAll();
                    for (const lib of allLibraries) {
                        await dbInstance.deleteEmbeddingIndexState(
                            lib.libraryID,
                        );
                    }
                }
                setPref("runEmbeddingFullDiff", false);
            }

            if (forceFullDiff) {
                logger(
                    `EmbeddingIndex: Force full diff requested - processing all ${libraryIds.length} libraries`,
                    3,
                );
            } else {
                logger(
                    `EmbeddingIndex: Found ${libraryIds.length} searchable libraries to check`,
                    3,
                );
            }

            // First pass: check which libraries need a full diff
            // This is fast - just SQL queries for MAX(date) and COUNT
            // Skip this check if forceFullDiff is true
            const librariesToProcess: number[] = [];
            const libraryStates: Map<
                number,
                { maxClientDateModified: string | null; itemCount: number }
            > = new Map();

            for (const libraryId of libraryIds) {
                // If forceFullDiff, process all libraries without checking
                if (forceFullDiff) {
                    librariesToProcess.push(libraryId);
                    const state =
                        await indexer.getZoteroLibraryState(libraryId);
                    libraryStates.set(libraryId, state);
                    continue;
                }

                const diffCheck = await indexer.shouldRunFullDiff(libraryId);

                if (diffCheck.needsDiff) {
                    logger(
                        `EmbeddingIndex: Library ${libraryId} needs diff: ${diffCheck.reason}`,
                        3,
                    );
                    librariesToProcess.push(libraryId);
                    // Get and store the current state for later
                    const state =
                        await indexer.getZoteroLibraryState(libraryId);
                    libraryStates.set(libraryId, state);
                } else {
                    logger(
                        `EmbeddingIndex: Library ${libraryId} skipped: ${diffCheck.reason}`,
                        4,
                    );
                }
            }

            // Collect items ready for retry across synced libraries only
            const itemsReadyForRetry: number[] = [];
            for (const libraryId of libraryIds) {
                const retryItems =
                    await indexer.getItemsReadyForRetry(libraryId);
                itemsReadyForRetry.push(...retryItems);
            }
            if (itemsReadyForRetry.length > 0) {
                logger(
                    `EmbeddingIndex: Found ${itemsReadyForRetry.length} items ready for retry across synced libraries`,
                    3,
                );
            }

            // If no libraries need processing and no retries, we're done
            if (
                librariesToProcess.length === 0 &&
                itemsReadyForRetry.length === 0
            ) {
                const duration = Date.now() - startTime;
                logger(
                    `EmbeddingIndex: All libraries up to date, no retries needed - completed in ${formatDuration(duration)}`,
                    3,
                );
                // Still update failed count to reflect any existing failures in DB
                const failedStats = await indexer.getFailedStats();
                updateFailedCount(failedStats.permanentlyFailed);
                setIndexStatus({ status: "idle", phase: "incremental" });
                return;
            }

            // Second pass: compute diff only for libraries that need it
            let totalToIndex = 0;
            let totalToDelete = 0;
            const libraryDiffs: Map<
                number,
                {
                    toIndex: number[];
                    toDelete: number[];
                    totalIndexable: number;
                }
            > = new Map();

            for (const libraryId of librariesToProcess) {
                logger(
                    `EmbeddingIndex: Computing diff for library ${libraryId}`,
                    4,
                );
                const diff = await indexer.computeIndexingDiff(
                    libraryId,
                    MIN_CONTENT_LENGTH,
                );

                // Filter out items that are still in backoff period
                const filteredToIndex = await indexer.filterItemsNotInBackoff(
                    diff.toIndex,
                );
                const skippedDueToBackoff =
                    diff.toIndex.length - filteredToIndex.length;
                if (skippedDueToBackoff > 0) {
                    logger(
                        `EmbeddingIndex: Library ${libraryId}: ${skippedDueToBackoff} items still in backoff`,
                        4,
                    );
                }

                libraryDiffs.set(libraryId, {
                    toIndex: filteredToIndex,
                    toDelete: diff.toDelete,
                    totalIndexable: diff.totalIndexable,
                });
                totalToIndex += filteredToIndex.length;
                totalToDelete += diff.toDelete.length;
            }

            // Add retry items to total (they may overlap with diff items, but that's fine)
            const uniqueRetryItems = itemsReadyForRetry.filter((id) => {
                // Check if this item is already in any library diff
                for (const diff of libraryDiffs.values()) {
                    if (diff.toIndex.includes(id)) return false;
                }
                return true;
            });
            totalToIndex += uniqueRetryItems.length;

            logger(
                `EmbeddingIndex: Total: ${totalToIndex} to index (including ${uniqueRetryItems.length} retries), ${totalToDelete} to delete across ${librariesToProcess.length} libraries`,
                3,
            );
            publish({ totalItems: totalToIndex });

            // Third pass: process each library and save state
            let processedItems = 0;
            let totalIndexed = 0;
            let totalSkipped = 0;
            let totalFailed = 0;
            const allErrors: IndexingError[] = [];
            const db = getDB();

            for (const libraryId of librariesToProcess) {
                if (isCancelled?.()) {
                    logger(
                        "EmbeddingIndex: Indexing cancelled (superseded by new run)",
                        3,
                    );
                    setIndexStatus({ status: "idle", phase: "initial" });
                    return;
                }
                const diff = libraryDiffs.get(libraryId);
                const zoteroState = libraryStates.get(libraryId);
                if (!diff) continue;

                // Clean up failed embeddings for deleted items
                const cleanedUp =
                    await indexer.cleanupDeletedFailedEmbeddings(libraryId);
                if (cleanedUp > 0) {
                    logger(
                        `EmbeddingIndex: Cleaned up ${cleanedUp} failed records for deleted items in library ${libraryId}`,
                        3,
                    );
                }

                // Delete orphaned embeddings
                if (diff.toDelete.length > 0 && db) {
                    await db.deleteEmbeddingsBatch(diff.toDelete);
                    logger(
                        `EmbeddingIndex: Deleted ${diff.toDelete.length} orphaned embeddings from library ${libraryId}`,
                        3,
                    );
                }

                // Track whether the indexing run for this library left any
                // items in an unknown state (pre-API failure). If so, we MUST
                // skip saveIndexState below so the next pass re-runs the diff
                // and gives those items another chance.
                let libraryIncomplete = false;

                // Index items that need (re-)indexing
                if (diff.toIndex.length > 0) {
                    logger(
                        `EmbeddingIndex: Indexing ${diff.toIndex.length} items in library ${libraryId}`,
                        3,
                    );

                    const result = await indexer.indexItemIdsBatch(
                        diff.toIndex,
                        {
                            batchSize: INDEX_BATCH_SIZE,
                            isCancelled,
                            onProgress: (processed, total) => {
                                updateProgress({
                                    indexedItems: processedItems + processed,
                                    totalItems: totalToIndex,
                                });
                            },
                        },
                    );

                    processedItems +=
                        result.indexed + result.skipped + result.failed;
                    totalIndexed += result.indexed;
                    totalSkipped += result.skipped;
                    totalFailed += result.failed;
                    mergeIndexingErrors(allErrors, result.errors);
                    libraryIncomplete = result.incomplete;
                    logger(
                        `EmbeddingIndex: Library ${libraryId} complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed${result.incomplete ? " (incomplete)" : ""}`,
                        3,
                    );

                    // If cancelled mid-batch, don't persist state for this library
                    // (partial scan would be recorded as complete)
                    if (isCancelled?.()) {
                        logger(
                            "EmbeddingIndex: Indexing cancelled after partial batch - skipping state save",
                            3,
                        );
                        setIndexStatus({ status: "idle", phase: "initial" });
                        return;
                    }
                }

                // Save the index state for this library (for future quick checks).
                // Skip if any batch was incomplete — saving would mark the library
                // as fully scanned and hide unindexed items from quick checks
                // until the weekly safety diff (P1 fix).
                if (zoteroState && !libraryIncomplete) {
                    await indexer.saveIndexState(libraryId, zoteroState);
                    logger(
                        `EmbeddingIndex: Saved index state for library ${libraryId}`,
                        4,
                    );
                } else if (libraryIncomplete) {
                    logger(
                        `EmbeddingIndex: Skipping state save for library ${libraryId} due to incomplete batch — will re-check next pass`,
                        2,
                    );
                }
            }

            // Fourth pass: process retry items that weren't covered by library diffs
            if (uniqueRetryItems.length > 0 && !isCancelled?.()) {
                logger(
                    `EmbeddingIndex: Processing ${uniqueRetryItems.length} retry items`,
                    3,
                );

                const result = await indexer.indexItemIdsBatch(
                    uniqueRetryItems,
                    {
                        batchSize: INDEX_BATCH_SIZE,
                        isCancelled,
                        onProgress: (processed, total) => {
                            updateProgress({
                                indexedItems: processedItems + processed,
                                totalItems: totalToIndex,
                            });
                        },
                    },
                );

                processedItems +=
                    result.indexed + result.skipped + result.failed;
                totalIndexed += result.indexed;
                totalSkipped += result.skipped;
                totalFailed += result.failed;
                mergeIndexingErrors(allErrors, result.errors);
                logger(
                    `EmbeddingIndex: Retry items complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`,
                    3,
                );
            }

            // If cancelled during retry pass, still reset status
            if (isCancelled?.()) {
                logger(
                    "EmbeddingIndex: Indexing cancelled during retry pass",
                    3,
                );
                setIndexStatus({ status: "idle", phase: "initial" });
                return;
            }

            // Log final failed stats and update UI
            const failedStats = await indexer.getFailedStats();
            if (failedStats.totalFailed > 0) {
                logger(
                    `EmbeddingIndex: Failed items summary: ${failedStats.totalFailed} total, ${failedStats.readyForRetry} ready for retry, ${failedStats.permanentlyFailed} permanently failed`,
                    3,
                );
            }
            updateFailedCount(failedStats.permanentlyFailed);

            const duration = Date.now() - startTime;
            logger(
                `EmbeddingIndex: Initial indexing complete - took ${formatDuration(duration)}`,
                3,
            );
            setIndexStatus({ status: "idle", phase: "incremental" });

            // Report indexing completion to backend (fire-and-forget).
            const hasActivity =
                totalIndexed > 0 || totalFailed > 0 || totalToDelete > 0;
            const hasErrors = allErrors.length > 0;
            if (hasActivity || hasErrors) {
                embeddingsService
                    .reportIndexingComplete({
                        items_indexed: totalIndexed,
                        items_failed: totalFailed,
                        items_skipped: totalSkipped,
                        items_deleted: totalToDelete,
                        libraries_count: libraryIds.length,
                        duration_ms: duration,
                        is_force_reindex: forceFullDiff,
                        errors: allErrors.length > 0 ? allErrors : undefined,
                    })
                    .catch(() => {
                        // Silently ignore - already logged in the service
                    });
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            logger(
                `EmbeddingIndex: Initial indexing failed after ${formatDuration(duration)}: ${(error as Error).message}`,
                1,
            );
            Zotero.logError(error as Error);
            setIndexStatus({
                status: "error",
                phase: "initial",
                error: (error as Error).message,
            });
        }
    };

    /**
     * Process collected events for incremental updates.
     * Uses indexItemIdsBatch which loads items per-batch for memory efficiency.
     */
    const processEvents = async () => {
        if (isCancelled()) return;
        const indexer = getIndexer();
        if (!indexer) return;

        const modifiedIds = Array.from(eventsRef.current.modifiedItemIds);
        const deletedIds = Array.from(eventsRef.current.deletedItemIds);

        // Clear collections immediately
        eventsRef.current.modifiedItemIds.clear();
        eventsRef.current.deletedItemIds.clear();
        eventsRef.current.timer = null;

        if (modifiedIds.length === 0 && deletedIds.length === 0) return;

        let filteredModifiedIds = modifiedIds;

        try {
            // Re-check current searchable libraries when draining queued events.
            // Pending IDs can have been collected under an earlier scope.
            if (modifiedIds.length > 0) {
                const searchableLibrarySet = new Set(searchableLibraryIds);
                const items = await Zotero.Items.getAsync(modifiedIds);
                filteredModifiedIds = items
                    .filter(
                        (item): item is Zotero.Item =>
                            Boolean(item) &&
                            searchableLibrarySet.has(item.libraryID),
                    )
                    .map((item) => item.id);
            }

            logger(
                `EmbeddingIndex: Processing events: ${filteredModifiedIds.length} modified, ${deletedIds.length} deleted`,
                3,
            );
            setIndexStatus({ status: "updating", phase: "incremental" });

            const db = getDB();

            // Handle deletions first
            if (deletedIds.length > 0 && db) {
                await db.deleteEmbeddingsBatch(deletedIds);
                logger(
                    `EmbeddingIndex: Deleted ${deletedIds.length} embeddings`,
                    3,
                );
            }

            // Handle modifications - indexItemIdsBatch handles per-batch loading
            // skipUnchanged: compare content hashes to avoid unnecessary API calls
            if (filteredModifiedIds.length > 0) {
                const result = await indexer.indexItemIdsBatch(
                    filteredModifiedIds,
                    {
                        batchSize: INDEX_BATCH_SIZE,
                        skipUnchanged: true,
                        isCancelled,
                    },
                );
                logger(
                    `EmbeddingIndex: Updated ${result.indexed} embeddings (${result.skipped} skipped, ${result.failed} failed)`,
                    3,
                );

                // Items that were skipped might need their embeddings removed
                // (e.g., if title/abstract were cleared below min length, or item was trashed)
                // Only delete embeddings for items that exist but don't meet criteria anymore
                if (result.skipped > 0 && db) {
                    // Get existing embeddings for these items
                    const existingEmbeddings =
                        await db.getContentHashes(filteredModifiedIds);
                    const idsWithEmbeddings = filteredModifiedIds.filter((id) =>
                        existingEmbeddings.has(id),
                    );

                    // Check which of these no longer meet criteria
                    if (idsWithEmbeddings.length > 0) {
                        const items =
                            await Zotero.Items.getAsync(idsWithEmbeddings);
                        const stillValidIds = new Set<number>();

                        for (const item of items) {
                            // Item must exist, be a regular item, not be trashed, and meet content requirements
                            if (
                                item &&
                                item.isRegularItem() &&
                                !item.deleted &&
                                indexer.isItemIndexable(
                                    item,
                                    MIN_CONTENT_LENGTH,
                                )
                            ) {
                                stillValidIds.add(item.id);
                            }
                        }

                        const toRemove = idsWithEmbeddings.filter(
                            (id) => !stillValidIds.has(id),
                        );
                        if (toRemove.length > 0) {
                            await db.deleteEmbeddingsBatch(toRemove);
                            logger(
                                `EmbeddingIndex: Removed ${toRemove.length} embeddings for items no longer meeting criteria`,
                                3,
                            );
                        }
                    }
                }
            }

            // Update failed items count after incremental processing
            const failedStats = await indexer.getFailedStats();
            updateFailedCount(failedStats.permanentlyFailed);

            setIndexStatus({ status: "idle", phase: "incremental" });
        } catch (error) {
            logger(
                `EmbeddingIndex: Event processing failed: ${(error as Error).message}`,
                1,
            );
            Zotero.logError(error as Error);
            setIndexStatus({
                status: "error",
                phase: "incremental",
                error: (error as Error).message,
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

        eventsRef.current.timer = setTimeout(() => {
            void serialize(processEvents);
        }, EVENT_DEBOUNCE_MS);
    };

    logger("EmbeddingIndex: Setting up embedding index", 3);

    let isMounted = true;

    // Track the observer ID for this specific hook instance to prevent race conditions during cleanup
    let myObserverId: string | null = null;

    // Create a set for efficient library lookup in event handling
    const searchableLibrarySet = new Set(searchableLibraryIds);

    // Setup observer (only if we have libraries to index)
    const setupObserver = () => {
        if (myObserverId || isCancelled()) return;
        // Don't set up observer if no libraries are searchable
        if (searchableLibraryIds.length === 0) return;

        // Unregister any existing observer before registering a new one
        // This handles hot-reload scenarios where cleanup may not have run
        if (moduleNotifierId) {
            try {
                Zotero.Notifier.unregisterObserver(moduleNotifierId);
                logger(
                    "EmbeddingIndex: Unregistered stale observer before re-registering",
                    4,
                );
            } catch (e) {
                // Ignore errors if observer was already unregistered
            }
            moduleNotifierId = null;
        }

        const observer = {
            notify: async function (
                event: string,
                type: string,
                ids: number[],
                extraData: any,
            ) {
                // Skip all processing if shutdown has started
                if (Zotero.__beaverShuttingDown) return;

                // Only handle item events
                if (type !== "item") return;

                let shouldSchedule = false;

                // Handle add/modify events - filter to synced libraries
                if (event === "add" || event === "modify") {
                    // Load items to check their library
                    const items = await Zotero.Items.getAsync(ids);
                    if (isCancelled()) return;
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
                if (event === "delete") {
                    for (const id of ids) {
                        // For delete events, item no longer exists - check extraData for libraryID
                        if (extraData && extraData[id]) {
                            const { libraryID } = extraData[id];
                            if (
                                libraryID &&
                                searchableLibrarySet.has(libraryID)
                            ) {
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
            },
            // @ts-ignore Zotero.Notifier.Notify is defined
        } as Zotero.Notifier.Notify;

        moduleNotifierId = Zotero.Notifier.registerObserver(
            observer,
            ["item"],
            "beaver-embedding-index",
        );
        myObserverId = moduleNotifierId;
    };

    // Initialize indexing
    const initialize = async () => {
        try {
            // Wait a moment for DB to be ready (skip delay for force reindex)
            if (!isForceReindex) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (isCancelled()) return;

            // Perform initial indexing for searchable libraries only
            // Pass forceFullDiff=true if user clicked "Rebuild Search Index"
            await performInitialIndexing(
                searchableLibraryIds,
                isForceReindex,
                isCancelled,
            );

            // Setup observer after initial indexing
            if (isMounted && !isCancelled()) {
                setupObserver();

                // If a prior generation was cleaned up before debounce fired,
                // resume processing of the queued IDs in this generation.
                if (
                    eventsRef.current.modifiedItemIds.size > 0 ||
                    eventsRef.current.deletedItemIds.size > 0
                ) {
                    logger(
                        "EmbeddingIndex: Rescheduling pending queued events after re-init",
                        4,
                    );
                    scheduleEventProcessing();
                }
            }
        } catch (error) {
            if (isCancelled()) return;
            logger(
                `EmbeddingIndex: Initialization failed: ${(error as Error).message}`,
                1,
            );
            Zotero.logError(error as Error);
            if (isMounted && !isCancelled()) {
                setupObserver(); // Still set up observer even if initial indexing fails
                if (
                    eventsRef.current.modifiedItemIds.size > 0 ||
                    eventsRef.current.deletedItemIds.size > 0
                ) {
                    logger(
                        "EmbeddingIndex: Rescheduling pending queued events after init failure",
                        4,
                    );
                    scheduleEventProcessing();
                }
            }
        }
    };

    setupObserver();
    void serialize(initialize);

    // Cleanup
    return () => {
        isMounted = false;
        // Bump generation so isCancelled() fires for in-flight performInitialIndexing,
        // whether this is an effect re-fire or a permanent unmount.
        cancelled = true;
        logger("EmbeddingIndex: Cleaning up embedding index", 3);

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

        // The owner retains queued IDs across generations and re-schedules
        // processing after initialization, which avoids losing debounced updates.

        // Clear indexer reference
        indexerRef.current = null;
    };
}
