import { atom } from 'jotai';
import { FileStatus, FileStatusStats } from '../types/fileStatus';
import { planFeaturesAtom } from './profile';
import { ErrorCodeStats } from 'src/services/attachmentsService';
import { errorMapping } from '../components/status/FileProcessingStatus';
import { SyncStatus } from './ui';

// File upload status
// export const fileUploadStatusAtom = atom<SyncStatus>('idle');
// export const fileUploadTotalAtom = atom<number>(0); 
// export const fileUploadCurrentAtom = atom<number>(0);

// File processing status summary
export const fileStatusAtom = atom<FileStatus | null>(null);
export const errorCodeStatsAtom = atom<ErrorCodeStats[] | null>(null);
export const lastFetchedErrorCountsAtom = atom<{ failed: number; skipped: number } | null>(null);

// Aggregated error messages for failed and skipped files
export const aggregatedErrorMessagesForFailedFilesAtom = atom<Record<string, number>>((get) => {
    const errorCodeStats = get(errorCodeStatsAtom);
    if (!errorCodeStats) return {};
    const aggregatedStats: Record<string, number> = {};
    for (const errorCodeStat of errorCodeStats) {
        if(errorCodeStat.status !== "failed") continue;
        const message = errorMapping[errorCodeStat.error_code as keyof typeof errorMapping] || "Unexpected error";
        aggregatedStats[message] = (aggregatedStats[message] || 0) + errorCodeStat.count;
    }
    return aggregatedStats;
});

export const aggregatedErrorMessagesForSkippedFilesAtom = atom<Record<string, number>>((get) => {
    const errorCodeStats = get(errorCodeStatsAtom);
    if (!errorCodeStats) return {};
    const aggregatedStats: Record<string, number> = {};
    for (const errorCodeStat of errorCodeStats) {
        if(errorCodeStat.status !== "skipped") continue;
        const message = errorMapping[errorCodeStat.error_code as keyof typeof errorMapping] || "Unexpected error";
        aggregatedStats[message] = (aggregatedStats[message] || 0) + errorCodeStat.count;
    }
    return aggregatedStats;
});


export const fileStatusStatsAtom = atom<FileStatusStats>(
    (get) => {
        const planFeatures = get(planFeaturesAtom);
        const useAdvancedPipeline = planFeatures.advancedProcessing;

        const fileStatus = get(fileStatusAtom);
        
        // Total files
        const totalFiles = fileStatus?.total_files || 0;
        const completedFiles = useAdvancedPipeline ? (fileStatus?.docling_embedded || 0) : (fileStatus?.md_embedded || 0);
        
        // Upload stats
        const uploadPendingCount = fileStatus?.upload_pending || 0;
        const uploadCompletedCount = fileStatus?.upload_completed || 0;
        const uploadFailedCount = fileStatus?.upload_failed || 0;
        const uploadSkippedCount = fileStatus?.upload_skipped || 0;

        // Processing stats
        const skippedProcessingCount = useAdvancedPipeline ? fileStatus?.docling_skipped || 0 : fileStatus?.md_skipped || 0;
        const failedProcessingCount = useAdvancedPipeline ? fileStatus?.docling_failed || 0 : fileStatus?.md_failed || 0;
        const activeProcessingCount = (useAdvancedPipeline ? fileStatus?.docling_processing || 0 : fileStatus?.md_processing || 0);
        const queuedProcessingCount = useAdvancedPipeline ? fileStatus?.docling_queued || 0 : fileStatus?.md_queued || 0;
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
            skippedProcessingCount,
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
            uploadSkippedCount,
        } as FileStatusStats;
    }
);