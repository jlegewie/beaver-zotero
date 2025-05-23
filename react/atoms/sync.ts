import { atom } from 'jotai';
import { getPref } from '../../src/utils/prefs';
import { SyncStatus } from './ui';

// UploadQueueStatus
export type UploadSessionType = 'initial' | 'background' | 'manual';
export type UploadQueueStatusType = 'in_progress' | 'completed' | 'failed';
export interface UploadQueueSession {
    sessionId: string;
    sessionType: UploadSessionType;
    startTime: string;
    status: UploadQueueStatusType;
    
    // Statistics
    pending: number;
    completed: number;
    failed: number;
    skipped: number;
    total: number;
    currentFile: string | null;
}

export const uploadQueueStatusAtom = atom<UploadQueueSession | null>(null);

export function isUploadQueueSession(obj: any): obj is UploadQueueSession {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.sessionId === 'string' &&
        (obj.sessionType === 'initial' || obj.sessionType === 'background' || obj.sessionType === 'manual') &&
        typeof obj.startTime === 'string' &&
        (obj.status === 'in_progress' || obj.status === 'completed' || obj.status === 'failed') &&
        typeof obj.pending === 'number' &&
        typeof obj.completed === 'number' &&
        typeof obj.failed === 'number' &&
        typeof obj.skipped === 'number' &&
        typeof obj.total === 'number' &&
        (typeof obj.currentFile === 'string' || obj.currentFile === null)
    );
}



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