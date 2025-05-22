import { atom } from 'jotai';
import { getPref } from '../../src/utils/prefs';
import { SyncStatus } from './ui';


// Library sync tracking
export interface LibrarySyncStatus {
    libraryID: number;
    libraryName: string;
    itemCount: number;
    syncedCount: number;
    status: SyncStatus;
}

// Library-specific sync status atom
export const librariesSyncStatusAtom = atom<Record<number, LibrarySyncStatus>>(
    JSON.parse(getPref('selectedLibrary') || '{}') as Record<number, LibrarySyncStatus>
);

// Derived atom for overall library sync progress
export const librarySyncProgressAtom = atom(
    (get) => {
        const librariesStatus = get(librariesSyncStatusAtom);
        const libraryIds = Object.keys(librariesStatus).map(id => Number(id));

        if (libraryIds.length === 0) return {
            totalItems: 0,
            syncedItems: 0,
            progress: 0,
            completed: false,
            anyFailed: false
        };

        const totalItems = libraryIds.reduce((sum, id) => sum + librariesStatus[id].itemCount, 0);
        const syncedItems = libraryIds.reduce((sum, id) => sum + librariesStatus[id].syncedCount, 0);
        const progress = totalItems > 0 ? Math.min(Math.round((syncedItems / totalItems) * 100), 100) : 0;
        const completed = libraryIds.every(id => librariesStatus[id].status === 'completed');
        const anyFailed = libraryIds.some(id => librariesStatus[id].status === 'failed');

        return {
            totalItems,
            syncedItems,
            progress,
            completed,
            anyFailed
        };
    }
);