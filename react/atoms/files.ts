import { atom } from 'jotai';
import { FileStatus, FileStatusStats } from '../types/fileStatus';
import { planFeaturesAtom } from './profile';
import { ErrorCodeStats } from 'src/services/attachmentsService';

// File upload status
// export const fileUploadStatusAtom = atom<SyncStatus>('idle');
// export const fileUploadTotalAtom = atom<number>(0); 
// export const fileUploadCurrentAtom = atom<number>(0);

// Mapping of error codes to user error messages (covers error codes from ProcessingErrorCode pydantic model)
export const errorMapping = {
    "queue_failed": "Unexpected error",
    "queue_failed_invalid_user": "Unexpected error",
    "queue_failed_invalid_file_type": "File Type not supported",
    "queue_failed_invalid_page_count": "Unable to read file",
    "queue_failed_exceeds_plan_page_limit": "File too large",
    "queue_failed_insufficient_balance": "Insufficient balance",
    "queue_failed_file_too_large": "File size too large",
    "queue_failed_database_error": "Unexpected error",
    "encrypted": "File is encrypted",
    "no_text_layer": "File requires OCR",
    "insufficient_text": "Insufficient text",
    "file_missing": "File missing",
    "download_failed": "Unexpected error",
    "preprocessing_failed": "Unexpected error",
    "conversion_failed": "Unexpected error",
    "opening_failed": "Unexpected error",
    "upload_failed": "Unexpected error",
    "chunk_failed": "Unexpected error",
    "embedding_failed": "Unexpected error",
    "db_update_failed": "Unexpected error",
    "task_parsing_failed": "Unexpected error",
    "max_retries": "Unexpected error",
    "timeout": "Unexpected error",
    "unexpected_error": "Unexpected error"
}

// File processing status summary
export const fileStatusAtom = atom<FileStatus | null>(null);
export const errorCodeStatsAtom = atom<ErrorCodeStats[] | null>(null);
export const errorCodeStatsIsLoadingAtom = atom<boolean>(false);
export const errorCodeStatsErrorAtom = atom<string | null>(null);
export const lastFetchedErrorCountsAtom = atom<{ failed: number; skipped: number } | null>(null);

// Aggregated error messages for failed and skipped files
export const aggregatedErrorMessagesForFailedFilesAtom = atom<Record<string, number>>((get) => {
    const errorCodeStats = get(errorCodeStatsAtom);
    if (!errorCodeStats) return {};
    const aggregatedStats: Record<string, number> = {};
    for (const errorCodeStat of errorCodeStats) {
        if(errorCodeStat.status !== "failed_user" && errorCodeStat.status !== "failed_system") continue;
        const message = errorMapping[errorCodeStat.error_code as keyof typeof errorMapping] || "Unexpected error";
        aggregatedStats[message] = (aggregatedStats[message] || 0) + errorCodeStat.count;
    }
    return aggregatedStats;
});

export const aggregatedErrorMessagesForPlanLimitFilesAtom = atom<Record<string, number>>((get) => {
    const errorCodeStats = get(errorCodeStatsAtom);
    if (!errorCodeStats) return {};
    const aggregatedStats: Record<string, number> = {};
    for (const errorCodeStat of errorCodeStats) {
        if(errorCodeStat.status !== "plan_limit") continue;
        const message = errorMapping[errorCodeStat.error_code as keyof typeof errorMapping] || "Unexpected error";
        aggregatedStats[message] = (aggregatedStats[message] || 0) + errorCodeStat.count;
    }
    return aggregatedStats;
});


export const fileStatusStatsAtom = atom<FileStatusStats>(
    (get) => {
        const planFeatures = get(planFeaturesAtom);
        const fileStatus = get(fileStatusAtom);
        
        // Total files
        const totalFiles = fileStatus?.total_files || 0;

        // Upload status
        const uploadPendingCount = fileStatus?.upload_pending || 0;
        const uploadCompletedCount = fileStatus?.upload_completed || 0;
        const uploadFailedCount = fileStatus?.upload_failed || 0;
        const uploadPlanLimitCount = fileStatus?.upload_plan_limit || 0;

        // Processing status based on plan features
        let queuedProcessingCount = 0;
        let processingProcessingCount = 0;
        let completedFiles = 0;
        let failedProcessingCount = 0;
        let planLimitProcessingCount = 0;
        let unsupportedFileCount = 0;

        if(fileStatus && planFeatures.processingTier === 'basic') {
            queuedProcessingCount = fileStatus.text_queued;
            processingProcessingCount = (fileStatus.text_processing);
            completedFiles = fileStatus.text_completed;
            failedProcessingCount = fileStatus.text_failed_system + fileStatus.text_failed_user;
            planLimitProcessingCount = fileStatus.text_plan_limit;
            unsupportedFileCount = fileStatus.text_unsupported_file;
        } else if(fileStatus && planFeatures.processingTier === 'standard') {
            queuedProcessingCount = fileStatus.md_queued;
            processingProcessingCount = (fileStatus.md_processing);
            completedFiles = fileStatus.md_completed;
            failedProcessingCount = fileStatus.md_failed_system + fileStatus.md_failed_user;
            planLimitProcessingCount = fileStatus.md_plan_limit;
            unsupportedFileCount = fileStatus.md_unsupported_file;
        } else if(fileStatus && planFeatures.processingTier === 'advanced') {
            queuedProcessingCount = fileStatus.docling_queued;
            processingProcessingCount = fileStatus.docling_processing;
            completedFiles = fileStatus.docling_completed;
            failedProcessingCount = fileStatus.docling_failed_system + fileStatus.docling_failed_user;
            planLimitProcessingCount = fileStatus.docling_plan_limit;
            unsupportedFileCount = fileStatus.docling_unsupported_file;
        }
            
        // Processing summary (omitting unsupported files)
        const totalProcessingCount = queuedProcessingCount + processingProcessingCount + completedFiles + failedProcessingCount + planLimitProcessingCount;
        const processingProgress = totalProcessingCount > 0
            ? Math.min((completedFiles + failedProcessingCount + planLimitProcessingCount) / totalProcessingCount * 100, 100)
            : 0;

        // Combined counts
        const failedCount = uploadFailedCount + failedProcessingCount;
        const activeCount = uploadPendingCount + processingProcessingCount;
        const planLimitCount = uploadPlanLimitCount + planLimitProcessingCount;
        
        // Overall Progress
        const progress = totalFiles > 0
            // ? Math.min((uploadCompletedCount + uploadFailedCount + uploadPlanLimitCount + completedFiles + failedProcessingCount + planLimitProcessingCount + unsupportedFileCount) / totalFiles * 100, 100)
            ? Math.min((totalFiles - uploadPendingCount - queuedProcessingCount - processingProcessingCount) / totalFiles * 100, 100)
            : 0;
            

        return {
            fileStatusAvailable: fileStatus !== null,

            // Combined counts
            totalFiles,
            failedCount,
            activeCount,
            planLimitCount,

            // Upload status
            uploadPendingCount,
            uploadCompletedCount,
            uploadFailedCount,
            uploadPlanLimitCount,

            // Processing status
            queuedProcessingCount,
            processingProcessingCount,
            completedFiles,
            failedProcessingCount,
            planLimitProcessingCount,
            unsupportedFileCount,

            // Processing summary
            totalProcessingCount,
            processingProgress,
            progress,
        } as FileStatusStats;
    }
);