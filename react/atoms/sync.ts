import { atom } from 'jotai';

// File uploader status to track running, failed and backoff states
export const isFileUploaderRunningAtom = atom<boolean>(false);
export const isFileUploaderFailedAtom = atom<boolean>(false);
export const fileUploaderBackoffUntilAtom = atom<number | null>(null);

export type SyncType = 'initial' | 'incremental' | 'consistency' | 'verification';
export type SyncStatus = 'idle' | 'in_progress' | 'completed' | 'failed';
export type OverallSyncStatus = 'in_progress' | 'completed' | 'partially_completed' | 'failed';
export type SyncMethod = 'version' | 'date_modified';

// Library sync tracking
export interface LibrarySyncStatus {
    libraryID: number;
    libraryName?: string;
    itemCount?: number;
    syncedCount?: number;
    status: SyncStatus;
    syncType?: SyncType;
}

// Library-specific sync status atom
export const syncStatusAtom = atom<Record<number, LibrarySyncStatus>>({});

export const syncingAtom = atom(
    (get) => {
        const syncStatus = get(syncStatusAtom);
        return Object.values(syncStatus).some(status => status.status === 'in_progress');
    }
);

export const syncErrorAtom = atom(
    (get) => {
        const syncStatus = get(syncStatusAtom);
        return Object.values(syncStatus).some(status => status.status === 'failed');
    }
);

// Derived atom for overall library sync progress
export const syncStatusSummaryAtom = atom(
    (get) => {
        const syncStatus = get(syncStatusAtom);
        const libraryIds = Object.keys(syncStatus).map(Number);

        if (libraryIds.length === 0) return {
            totalItems: 0,
            syncedItems: 0,
            progress: 0,
            completed: false,
            anyFailed: false
        };
        
        const totalItems = libraryIds.reduce((sum, id) => sum + (syncStatus[id].itemCount || 0), 0);
        const syncedItems = libraryIds.reduce((sum, id) => sum + (syncStatus[id].syncedCount || 0), 0);
        const progress = totalItems > 0 ? Math.min(Math.round((syncedItems / totalItems) * 1000) / 10, 100) : 0;
        const completed = libraryIds.length > 0 && libraryIds.every(id => syncStatus[id].status === 'completed');
        const anyFailed = libraryIds.some(id => syncStatus[id].status === 'failed');

        // Determine if the sync is valid
        // 1. If the main library is included, the sync is valid if the main library is completed and all other libraries are completed or failed
        // 2. If the main library is not included, the sync is valid if at least one library is completed and all other libraries are completed or failed
        let syncValid = false;
        const allCompletedOrFailed = libraryIds.every(id => syncStatus[id].status === 'completed' || syncStatus[id].status === 'failed');
        if (libraryIds.includes(1)) {
            syncValid = syncStatus[1].status === 'completed' && allCompletedOrFailed;
        } else {
            syncValid = libraryIds.some(id => syncStatus[id].status === 'completed') && allCompletedOrFailed;
        }

        return {
            totalItems,
            syncedItems,
            progress,
            completed,
            anyFailed,
            syncValid
        };
    }
);

export const failedSyncLibraryIdsAtom = atom<number[]>((get) => {
    const syncStatus = get(syncStatusAtom);
    return Object.values(syncStatus).filter(status => status.status === 'failed').map(status => status.libraryID);
});

export const overallSyncStatusAtom = atom<OverallSyncStatus>((get) => {
    const syncStatus = get(syncStatusAtom);
    const syncStatuses = Object.values(syncStatus);
    const libraryIds = Object.keys(syncStatus).map(Number);
    // In progress and completed
    if(syncStatuses.some(status => status.status === 'in_progress')) return 'in_progress';
    if(syncStatuses.every(status => status.status === 'completed')) return 'completed';
    if(syncStatuses.every(status => status.status === 'failed')) return 'failed';
    // Failed if the main library is failed
    if(libraryIds.includes(1) && syncStatus[1].status === 'failed') return 'failed';
    // Partially completed (Completed with errors)
    const allCompletedOrFailed = syncStatuses.every(status => status.status === 'completed' || status.status === 'failed');
    if (allCompletedOrFailed) return 'partially_completed';
    return 'in_progress';
});


/*
 * Deletions tracking
 */
export type DeletionStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type DeletionJob = {
  libraryID: number;
  name: string;
  isGroup: boolean;
  startedAt: string;           // ISO
  status: DeletionStatus;
  msgId?: number;              // from backend queue
  sessionId?: string;          // Unique ID for the deletion job
  lastCheckedAt?: string;      // ISO
  error?: string;
};

export const deletionJobsAtom = atom<Record<number, DeletionJob>>({});
