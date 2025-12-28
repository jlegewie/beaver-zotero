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
     * Perform initial indexing of all libraries
     */
    const performInitialIndexing = async () => {
        const indexer = getIndexer();
        if (!indexer) return;

        logger("useEmbeddingIndex: Starting initial indexing", 3);
        setIndexStatus({ status: 'indexing', phase: 'initial' });

        try {
            // Get libraries sorted (user library first)
            const libraryIds = indexer.getLibrariesSorted();
            logger(`useEmbeddingIndex: Found ${libraryIds.length} libraries to index`, 3);

            // Count total items across all libraries for progress tracking
            let totalItems = 0;
            let processedItems = 0;
            const libraryItems: Map<number, Zotero.Item[]> = new Map();

            for (const libraryId of libraryIds) {
                const items = await indexer.getIndexableItemsForLibrary(libraryId, MIN_CONTENT_LENGTH);
                libraryItems.set(libraryId, items);
                totalItems += items.length;
            }

            logger(`useEmbeddingIndex: Total indexable items: ${totalItems}`, 3);
            store.set(embeddingIndexStateAtom, (prev: EmbeddingIndexState) => ({
                ...prev,
                totalItems,
            }));

            // Process each library
            for (const libraryId of libraryIds) {
                const items = libraryItems.get(libraryId) || [];
                if (items.length === 0) continue;

                logger(`useEmbeddingIndex: Processing library ${libraryId} with ${items.length} items`, 3);

                // Index items with progress callback
                const result = await indexer.indexItemsBatch(items, {
                    batchSize: INDEX_BATCH_SIZE,
                    skipUnchanged: true,
                    onProgress: (indexed, total) => {
                        const currentProcessed = processedItems + indexed;
                        updateProgress({
                            indexedItems: currentProcessed,
                            totalItems: totalItems,
                        });
                    },
                });

                processedItems += result.indexed + result.skipped + result.failed;
                logger(`useEmbeddingIndex: Library ${libraryId} complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`, 3);

                // Clean up orphaned embeddings for this library
                const orphanedCount = await indexer.cleanupOrphanedEmbeddings(libraryId);
                if (orphanedCount > 0) {
                    logger(`useEmbeddingIndex: Removed ${orphanedCount} orphaned embeddings from library ${libraryId}`, 3);
                }
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
     * Process collected events for incremental updates
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
            // Handle deletions first
            if (deletedIds.length > 0) {
                const db = getDB();
                if (db) {
                    await db.deleteEmbeddingsBatch(deletedIds);
                    logger(`useEmbeddingIndex: Deleted ${deletedIds.length} embeddings`, 3);
                }
            }

            // Handle modifications
            if (modifiedIds.length > 0) {
                const items = await Zotero.Items.getAsync(modifiedIds);
                const validItems = items.filter(item => 
                    item && 
                    item.isRegularItem() && 
                    indexer.isItemIndexable(item, MIN_CONTENT_LENGTH)
                );

                if (validItems.length > 0) {
                    const result = await indexer.indexItemsBatch(validItems, {
                        batchSize: INDEX_BATCH_SIZE,
                        skipUnchanged: true,
                    });
                    logger(`useEmbeddingIndex: Updated ${result.indexed} embeddings (${result.skipped} skipped)`, 3);
                }

                // Handle items that no longer meet criteria (remove their embeddings)
                const validItemIds = new Set(validItems.map(item => item.id));
                const noLongerIndexableIds = modifiedIds.filter(id => !validItemIds.has(id));
                if (noLongerIndexableIds.length > 0) {
                    const db = getDB();
                    if (db) {
                        await db.deleteEmbeddingsBatch(noLongerIndexableIds);
                        logger(`useEmbeddingIndex: Removed ${noLongerIndexableIds.length} embeddings for items no longer meeting criteria`, 3);
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

