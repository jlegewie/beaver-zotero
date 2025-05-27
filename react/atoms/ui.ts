import { atom } from 'jotai';
import { InputSource } from '../types/sources';
import { FileStatus } from '../types/fileStatus';
import { TextSelection } from '../types/attachments/apiTypes';
import { PopupMessage } from '../types/popupMessage';
import { uploadQueueStatusAtom } from './sync';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const isPreferencePageVisibleAtom = atom(false);


// UI behavior and elements
export const userScrolledAtom = atom(false);

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
export const previewCloseTimeoutAtom = atom<number | null>(null)

// Database sync status
// TODO: Move to sync.ts
export type SyncStatus = 'idle' | 'in_progress' | 'completed' | 'failed';
// 'idle' - Initial state, no sync has been attempted
// 'in_progress' - Active sync operation
// 'completed' - Sync finished successfully
// 'failed' - Sync operation failed
export const syncStatusAtom = atom<SyncStatus>('idle');

// File upload status
export const fileUploadStatusAtom = atom<SyncStatus>('idle');
export const fileUploadTotalAtom = atom<number>(0); 
export const fileUploadCurrentAtom = atom<number>(0);

// Derived atoms for combined status
export const syncingAtom = atom(
    (get) => {
        const dbStatus = get(syncStatusAtom);
        return dbStatus === 'in_progress' || get(uploadQueueStatusAtom)?.status === 'in_progress';
    }
);

export const syncErrorAtom = atom(
    (get) => {
        const dbStatus = get(syncStatusAtom);
        return dbStatus === 'failed' || get(uploadQueueStatusAtom)?.status === 'failed';
    }
);

// File processing status summary
export const fileStatusAtom = atom<FileStatus | null>(null);
export const errorCodeStatsAtom = atom<Record<string, number> | null>(null);
export const errorCodeLastFetchedAtom = atom<number | null>(null);

export interface FileStatusStats {
    fileStatusAvailable: boolean;
    totalFiles: number;
    completedFiles: number;
    failedProcessingCount: number;
    activeProcessingCount: number;
    totalProcessingCount: number;
    processingProgress: number;
    progress: number;
    failedCount: number;
    activeCount: number;
    uploadPendingCount: number;
    queuedProcessingCount: number;
    uploadCompletedCount: number;
    uploadFailedCount: number;
}


export const fileStatusStatsAtom = atom<FileStatusStats>(
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
        const totalProcessingCount = failedProcessingCount + activeProcessingCount + queuedProcessingCount + completedFiles;
        const processingProgress = totalProcessingCount > 0
            ? Math.min(((failedProcessingCount + completedFiles) / totalProcessingCount) * 100, 100)
            : 0;

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
            totalProcessingCount,
            processingProgress,
            progress,
            failedCount,
            activeCount,
            uploadPendingCount,
            queuedProcessingCount,
            uploadCompletedCount,
            uploadFailedCount,
        } as FileStatusStats;
    }
);

// Active preview
export type ActivePreview = 
    | { type: 'source'; content: InputSource }
    | { type: 'textSelection'; content: TextSelection }
    | { type: 'annotation'; content: InputSource }
    | null;

export const activePreviewAtom = atom<ActivePreview>(null);

// Popup Messages
export const popupMessagesAtom = atom<PopupMessage[]>([]);