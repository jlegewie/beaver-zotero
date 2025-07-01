import { atom } from 'jotai';
import { SyncStatus } from './ui';
import { syncLibraryIdsAtom } from './profile';

// File uploader status - simplified to just track running and failed states
export const isFileUploaderRunningAtom = atom<boolean>(false);
export const isFileUploaderFailedAtom = atom<boolean>(false);

// Library sync tracking
export interface LibrarySyncStatus {
    libraryID: number;
    libraryName?: string;
    itemCount?: number;
    syncedCount?: number;
    status: SyncStatus;
}

// Library-specific sync status atom
export const initialSyncStatusAtom = atom<Record<number, LibrarySyncStatus>>({});

// Derived atom for overall library sync progress
export const initialSyncStatusSummaryAtom = atom(
    (get) => {
        const initialSyncStatus = get(initialSyncStatusAtom);
        const libraryIds = Object.keys(initialSyncStatus).map(id => Number(id));

        if (libraryIds.length === 0) return {
            totalItems: 0,
            syncedItems: 0,
            progress: 0,
            completed: false,
            anyFailed: false
        };
        
        const totalItems = libraryIds.reduce((sum, id) => sum + (initialSyncStatus[id].itemCount || 0), 0);
        const syncedItems = libraryIds.reduce((sum, id) => sum + (initialSyncStatus[id].syncedCount || 0), 0);
        const progress = totalItems > 0 ? Math.min(Math.round((syncedItems / totalItems) * 1000) / 10, 100) : 0;
        const completed = libraryIds.every(id => initialSyncStatus[id].status === 'completed');
        const anyFailed = libraryIds.some(id => initialSyncStatus[id].status === 'failed');

        return {
            totalItems,
            syncedItems,
            progress,
            completed,
            anyFailed
        };
    }
);

export const isInitialSyncCompleteAtom = atom<boolean>((get) => {
    const librarySyncProgress = get(initialSyncStatusSummaryAtom);
    return librarySyncProgress.completed && !librarySyncProgress.anyFailed;
});
