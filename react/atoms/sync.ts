import { atom } from 'jotai';

// File uploader status - simplified to just track running and failed states
export const isFileUploaderRunningAtom = atom<boolean>(false);
export const isFileUploaderFailedAtom = atom<boolean>(false);

export type SyncStatus = 'idle' | 'in_progress' | 'completed' | 'failed';

// Library sync tracking
export interface LibrarySyncStatus {
    libraryID: number;
    libraryName?: string;
    itemCount?: number;
    syncedCount?: number;
    status: SyncStatus;
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
        const libraryIds = Object.keys(syncStatus).map(id => Number(id));

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
        const completed = libraryIds.every(id => syncStatus[id].status === 'completed');
        const anyFailed = libraryIds.some(id => syncStatus[id].status === 'failed');

        return {
            totalItems,
            syncedItems,
            progress,
            completed,
            anyFailed
        };
    }
);

export const isSyncCompleteAtom = atom<boolean>((get) => {
    const librarySyncProgress = get(syncStatusSummaryAtom);
    return librarySyncProgress.completed && !librarySyncProgress.anyFailed;
});
