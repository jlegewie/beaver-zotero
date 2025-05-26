import { atom } from 'jotai';
import { getPref } from '../../src/utils/prefs';
import { SyncStatus } from './ui';

// UploadQueueStatus
export type UploadSessionType = 'initial' | 'background' | 'manual';
export type UploadQueueStatusType = 'in_progress' | 'completed' | 'failed';
export interface UploadQueueSession {
    sessionType: UploadSessionType;
    status: UploadQueueStatusType;
    pending: number;
    completed: number;
    failed: number;
    skipped: number;
    currentFile: string | null;
}

export const uploadQueueStatusAtom = atom<UploadQueueSession | null>(null);

export const uploadQueueTotalAtom = atom<number>((get) => {
    const status = get(uploadQueueStatusAtom);
    return (status?.pending || 0) + (status?.completed || 0) + (status?.failed || 0) + (status?.skipped || 0);
});


// Library sync tracking
export interface LibrarySyncStatus {
    libraryID: number;
    libraryName: string;
    itemCount: number;
    syncedCount: number;
    status: SyncStatus;
}

// Library-specific sync status atom
let initialLibraryStatus: Record<number, LibrarySyncStatus> = {};
try {
    const prefValue = getPref('selectedLibrary');
    if (prefValue) {
        initialLibraryStatus = JSON.parse(prefValue) as Record<number, LibrarySyncStatus>;
    }
} catch (e) {
    const errorMessage = `Failed to parse 'selectedLibrary' preference: ${e instanceof Error ? e.message : String(e)}`;
    Zotero.logError(new Error(errorMessage));
}
export const librariesSyncStatusAtom = atom<Record<number, LibrarySyncStatus>>(
    initialLibraryStatus
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