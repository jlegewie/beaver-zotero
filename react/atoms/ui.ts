import { atom } from 'jotai';
import { currentSourcesAtom } from './input';
import { InputSource } from '../types/sources';
import { FileStatus } from '../types/fileStatus';
import { TextSelection } from '../utils/readerUtils';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const isPreferencePageVisibleAtom = atom(false);

// UI behavior and elements
export const userScrolledAtom = atom(false);

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
export const previewCloseTimeoutAtom = atom<number | null>(null)

// Database sync status
export type SyncStatus = 'idle' | 'in_progress' | 'completed' | 'failed';
// 'idle' - Initial state, no sync has been attempted
// 'in_progress' - Active sync operation
// 'completed' - Sync finished successfully
// 'failed' - Sync operation failed
export const syncStatusAtom = atom<SyncStatus>('idle');
export const syncTotalAtom = atom<number>(0);
export const syncCurrentAtom = atom<number>(0);

// File upload status
export const fileUploadStatusAtom = atom<SyncStatus>('idle');
export const fileUploadTotalAtom = atom<number>(0); 
export const fileUploadCurrentAtom = atom<number>(0);

// Derived atoms for combined status
export const syncingAtom = atom(
    (get) => {
        const dbStatus = get(syncStatusAtom);
        const fileStatus = get(fileUploadStatusAtom);
        return dbStatus === 'in_progress' || fileStatus === 'in_progress';
    }
);

export const syncErrorAtom = atom(
    (get) => {
        const dbStatus = get(syncStatusAtom);
        const fileStatus = get(fileUploadStatusAtom);
        return dbStatus === 'failed' || fileStatus === 'failed';
    }
);

// File processing status summary
export const fileStatusAtom = atom<FileStatus | null>(null);
export const errorCodeStatsAtom = atom<Record<string, number> | null>(null);
export const errorCodeLastFetchedAtom = atom<number | null>(null);

export const fileStatusStatsAtom = atom(
    (get) => {
        const fileStatus = get(fileStatusAtom);
        
        // Total files
        const totalFiles = fileStatus?.total_files || 0;
        const completedFiles = fileStatus?.md_embedded || 0;
        
        // Upload stats
        const uploadPendingCount = fileStatus?.upload_pending || 0;
        const uploadCompletedCount = fileStatus?.upload_completed || 0;
        const uploadFailedCount = fileStatus?.upload_failed || 0;

        // Processing stats
        const failedProcessingCount = fileStatus?.md_failed || 0;
        const activeProcessingCount = (fileStatus?.md_processing || 0) + (fileStatus?.md_chunked || 0) + (fileStatus?.md_converted || 0);
        const queuedProcessingCount = fileStatus?.md_queued || 0;

        // combined stats
        const failedCount = uploadFailedCount + failedProcessingCount;
        const activeCount = uploadPendingCount + activeProcessingCount;
        
        // Progress
        const progress = totalFiles > 0
                ? (completedFiles / (totalFiles - failedProcessingCount - (fileStatus?.upload_failed || 0))) * 100
                : 0;

        return {
            fileStatusAvailable: fileStatus !== null,
            totalFiles,
            completedFiles,
            failedProcessingCount,
            activeProcessingCount,
            progress,
            failedCount,
            activeCount,
            uploadPendingCount,
            queuedProcessingCount,
            uploadCompletedCount,
            uploadFailedCount,
        };
    }
);

// Active preview
export type ActivePreview = 
    | { type: 'source'; content: InputSource }
    | { type: 'textSelection'; content: TextSelection }
    | null;

export const activePreviewAtom = atom<ActivePreview>(null);