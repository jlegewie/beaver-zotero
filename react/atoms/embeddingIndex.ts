import { atom } from "jotai";
import { selectAtom } from 'jotai/utils';


/**
 * Status of the embedding index
 */
export type EmbeddingIndexStatus = 'idle' | 'indexing' | 'updating' | 'error';

/**
 * Phase of the embedding index operation
 */
export type EmbeddingIndexPhase = 'initial' | 'incremental';

/**
 * State of the embedding index
 */
export interface EmbeddingIndexState {
    status: EmbeddingIndexStatus;
    phase: EmbeddingIndexPhase;
    progress: number;           // 0-100 percentage
    totalItems: number;
    indexedItems: number;
    failedItems: number;        // Count of permanently failed items
    error?: string;
}

/**
 * Default state for the embedding index
 */
const defaultEmbeddingIndexState: EmbeddingIndexState = {
    status: 'idle',
    phase: 'initial',
    progress: 0,
    totalItems: 0,
    indexedItems: 0,
    failedItems: 0,
};

/**
 * Atom to track the current state of embedding indexing
 */
export const embeddingIndexStateAtom = atom<EmbeddingIndexState>(defaultEmbeddingIndexState);

/**
 * Counter that increments when a force reindex is requested.
 * useEmbeddingIndex hook watches this and triggers a full diff when it changes.
 */
export const forceReindexCounterAtom = atom<number>(0);

/**
 * Derived atom that indicates if indexing is currently in progress
 */
export const isEmbeddingIndexingAtom = selectAtom(
    embeddingIndexStateAtom,
    (state: EmbeddingIndexState) => state.status === 'indexing' || state.status === 'updating'
);

/**
 * Derived atom for current progress percentage
 */
export const embeddingIndexProgressAtom = selectAtom(
    embeddingIndexStateAtom,
    (state: EmbeddingIndexState) => state.progress
);

/**
 * Action atom to update indexing progress
 */
export const updateEmbeddingIndexProgressAtom = atom(
    null,
    (get, set, update: { indexedItems: number; totalItems: number }) => {
        const current = get(embeddingIndexStateAtom);
        const progress = update.totalItems > 0 
            ? Math.round((update.indexedItems / update.totalItems) * 100) 
            : 0;
        
        set(embeddingIndexStateAtom, {
            ...current,
            indexedItems: update.indexedItems,
            totalItems: update.totalItems,
            progress,
        });
    }
);

/**
 * Action atom to set indexing status
 */
export const setEmbeddingIndexStatusAtom = atom(
    null,
    (get, set, update: { status: EmbeddingIndexStatus; phase?: EmbeddingIndexPhase; error?: string }) => {
        const current = get(embeddingIndexStateAtom);
        set(embeddingIndexStateAtom, {
            ...current,
            status: update.status,
            phase: update.phase ?? current.phase,
            error: update.error,
            // Reset progress when starting a new indexing operation
            ...(update.status === 'indexing' || update.status === 'updating' 
                ? { progress: 0, indexedItems: 0 } 
                : {}),
        });
    }
);

/**
 * Action atom to reset the embedding index state
 */
export const resetEmbeddingIndexStateAtom = atom(
    null,
    (_get, set) => {
        set(embeddingIndexStateAtom, defaultEmbeddingIndexState);
    }
);

/**
 * Derived atom that indicates if there's an embedding index error
 */
export const hasEmbeddingIndexErrorAtom = selectAtom(
    embeddingIndexStateAtom,
    (state: EmbeddingIndexState) => state.status === 'error'
);

/**
 * Derived atom that indicates if there are permanently failed items
 */
export const hasFailedEmbeddingsAtom = selectAtom(
    embeddingIndexStateAtom,
    (state: EmbeddingIndexState) => state.failedItems > 0
);

/**
 * Action atom to trigger a force reindex (full diff run)
 */
export const forceReindexAtom = atom(
    null,
    (_get, set) => {
        set(forceReindexCounterAtom, (prev) => prev + 1);
    }
);

/**
 * Action atom to update failed items count
 */
export const updateFailedItemsCountAtom = atom(
    null,
    (get, set, failedItems: number) => {
        const current = get(embeddingIndexStateAtom);
        set(embeddingIndexStateAtom, {
            ...current,
            failedItems,
        });
    }
);

