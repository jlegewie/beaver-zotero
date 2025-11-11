import { atom } from 'jotai';
import { FileStatus, FileStatusSummary } from '../types/fileStatus';
import { planFeaturesAtom } from './profile';
import { ErrorCodeStats } from 'src/services/attachmentsService';
import { ProcessingTier } from '../types/profile';
import { errorMapping } from './errors';

// File upload status
// export const fileUploadStatusAtom = atom<SyncStatus>('idle');
// export const fileUploadTotalAtom = atom<number>(0); 
// export const fileUploadCurrentAtom = atom<number>(0);

// File processing status summary
export const fileStatusAtom = atom<FileStatus | null>(null);
export const errorCodeStatsAtom = atom<ErrorCodeStats[] | null>(null);
export const errorCodeStatsIsLoadingAtom = atom<boolean>(false);
export const errorCodeStatsErrorAtom = atom<string | null>(null);
export const lastFetchedErrorCountsAtom = atom<{ failed: number; skipped: number; processingTier: ProcessingTier } | null>(null);

// Type for aggregated error messages
export type AggregatedErrorMessage = {
    code: string;
    message: string;
    count: number;
};

// Aggregated error messages for failed files
export const aggregatedErrorMessagesForFailedFilesAtom = atom<Record<string, AggregatedErrorMessage>>((get) => {
    const errorCodeStats = get(errorCodeStatsAtom);
    if (!errorCodeStats) return {};
    const aggregatedStats: Record<string, AggregatedErrorMessage> = {};
    for (const errorCodeStat of errorCodeStats) {
        if(errorCodeStat.status !== "failed_system") continue;
        const message = errorMapping[errorCodeStat.error_code as keyof typeof errorMapping] || "Unexpected error";
        if (!aggregatedStats[errorCodeStat.error_code]) {
            aggregatedStats[errorCodeStat.error_code] = { code: errorCodeStat.error_code, message, count: 0 };
        }
        aggregatedStats[errorCodeStat.error_code].count += errorCodeStat.count;
    }
    return aggregatedStats;
});

// Aggregated error messages for skipped files
export const aggregatedErrorMessagesForSkippedFilesAtom = atom<Record<string, AggregatedErrorMessage>>((get) => {
    const errorCodeStats = get(errorCodeStatsAtom);
    if (!errorCodeStats) return {};
    const aggregatedStats: Record<string, AggregatedErrorMessage> = {};
    for (const errorCodeStat of errorCodeStats) {
        if(errorCodeStat.status !== "plan_limit" && errorCodeStat.status !== "failed_user") continue;
        const message = errorMapping[errorCodeStat.error_code as keyof typeof errorMapping] || "Unexpected error";
        if (!aggregatedStats[errorCodeStat.error_code]) {
            aggregatedStats[errorCodeStat.error_code] = { code: errorCodeStat.error_code, message, count: 0 };
        }
        aggregatedStats[errorCodeStat.error_code].count += errorCodeStat.count;
    }
    return aggregatedStats;
});


export const calculateFileStatusSummary = (fileStatus: FileStatus | null, processingTier: ProcessingTier) => {
    // if(processingTier === 'none') return;

    // Total files
    const totalFiles = fileStatus?.total_files || 0;

    // Upload status
    const uploadPendingCount = fileStatus?.upload_pending || 0;
    const uploadNotUploadedCount = fileStatus?.upload_not_uploaded || 0;
    const uploadCompletedCount = fileStatus?.upload_completed || 0;
    const uploadFailedCount = fileStatus?.upload_failed || 0;           // Temporary upload failure (retryable)
    const uploadFailedUserCount = fileStatus?.upload_failed_user || 0;  // DEPRECATED
    const uploadPlanLimitCount = fileStatus?.upload_plan_limit || 0;    // DEPRECATED
    const uploadProgress = fileStatus && totalFiles > 0 
        ? Math.round(((uploadNotUploadedCount + uploadCompletedCount + uploadFailedCount + uploadFailedUserCount + uploadPlanLimitCount) / totalFiles) * 1000) / 10
        : 0;

    // Processing status
    const queuedProcessingCount = fileStatus?.md_queued || 0;
    const processingProcessingCount = fileStatus?.md_processing || 0;
    const completedFiles = fileStatus?.md_completed || 0;
    const unsupportedFileCount = fileStatus?.md_unsupported_file || 0;
    
    // Failure categories
    const failedUploadCount = fileStatus?.md_failed_upload || 0;    // Category 1: Temporary upload error
    const failedUserCount = fileStatus?.md_failed_user || 0;        // Category 2: Invalid file (Client-side or server-side)
    const failedSystemCount = fileStatus?.md_failed_system || 0;    // Category 3: System processing error
    const planLimitCount = fileStatus?.md_plan_limit || 0;          // Category 4: Plan limit (Client-side or server-side)
    
    // Combined counts
    const failedCount = failedUploadCount + failedUserCount + failedSystemCount + planLimitCount;
    const activeCount = uploadPendingCount + processingProcessingCount;

    // Processing summary (omitting unsupported files and failed uploads)
    const totalProcessingCount = totalFiles - unsupportedFileCount - failedUploadCount;
    
    // Overall Progress
    const progress = totalFiles > 0
        ? Math.min((totalFiles - uploadPendingCount - queuedProcessingCount - processingProcessingCount) / totalFiles * 100, 100)
        : 0;

    // Difference: md_status is null (shouldn't happen)
    // const progress = totalFiles > 0
    //     ? Math.min((unsupportedFileCount + completedFiles + failedCount) / totalFiles * 100, 100)
    //     : 0;
        
    return {
        fileStatusAvailable: fileStatus !== null,

        // Combined counts
        totalFiles,
        failedCount,
        activeCount,

        // Failure categories
        failedUploadCount,      // Category 1: Temporary upload error
        failedUserCount,        // Category 2: Invalid file (Client-side or server-side)
        failedSystemCount,      // Category 3: System processing error
        planLimitCount,         // Category 4: Plan limit (Client-side or server-side)
        
        // Transient counts
        uploadPendingCount,
        
        // Processing status
        queuedProcessingCount,
        processingProcessingCount,
        completedFiles,
        unsupportedFileCount,

        // Processing summary
        totalProcessingCount,
        uploadProgress,
        progress,
        pageBalanceExhausted: fileStatus?.page_balance_exhausted || false,
    } as FileStatusSummary;
}


export const fileStatusSummaryAtom = atom<FileStatusSummary>(
    (get) => {
        const planFeatures = get(planFeaturesAtom);
        const fileStatus = get(fileStatusAtom);
        
        return calculateFileStatusSummary(fileStatus, planFeatures.processingTier);
    }
);

export const isUploadProcessedAtom = atom<boolean>((get) => {
    const fileStatusSummary = get(fileStatusSummaryAtom);
    return fileStatusSummary.uploadPendingCount === 0 && fileStatusSummary.fileStatusAvailable;
});