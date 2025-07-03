import { atom } from 'jotai';
import { FileStatus, FileStatusSummary } from '../types/fileStatus';
import { planFeaturesAtom } from './profile';
import { ErrorCodeStats } from 'src/services/attachmentsService';
import { ProcessingTier } from '../types/profile';

// File upload status
// export const fileUploadStatusAtom = atom<SyncStatus>('idle');
// export const fileUploadTotalAtom = atom<number>(0); 
// export const fileUploadCurrentAtom = atom<number>(0);

// Mapping of error codes to user error messages (covers error codes from ProcessingErrorCode pydantic model)
export const errorMapping = {
    // Queue failed
    "queue_failed": "Unexpected error",
    "queue_failed_invalid_user": "Unexpected error",
    "queue_failed_invalid_page_count": "Unable to read file",
    "queue_failed_database_error": "Unexpected error",
    
    // Plan limits
    "plan_limit_unsupported_file": "File Type not supported",
    "plan_limit_max_pages": "File too large",
    "plan_limit_insufficient_balance": "Insufficient balance",
    "plan_limit_file_size": "File too large",
    
    // File errors
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


export const calculateFileStatusSummary = (fileStatus: FileStatus | null, processingTier: ProcessingTier) => {
    // Total files
    const totalFiles = fileStatus?.total_files || 0;

    // Upload status
    const uploadPendingCount = fileStatus?.upload_pending || 0;
    const uploadCompletedCount = fileStatus?.upload_completed || 0;
    const uploadFailedCount = fileStatus?.upload_failed || 0;
    const uploadPlanLimitCount = fileStatus?.upload_plan_limit || 0;
    const uploadProgress = fileStatus && totalFiles > 0 
        ? Math.round(((uploadCompletedCount + uploadFailedCount + uploadPlanLimitCount) / totalFiles) * 1000) / 10
        : 0;

    // Processing status based on plan features
    let queuedProcessingCount = 0;
    let processingProcessingCount = 0;
    let completedFiles = 0;
    let failedProcessingCount = 0;
    let planLimitProcessingCount = 0;
    let unsupportedFileCount = 0;

    if(fileStatus && processingTier === 'basic') {
        queuedProcessingCount = fileStatus.text_queued;
        processingProcessingCount = (fileStatus.text_processing);
        completedFiles = fileStatus.text_completed;
        failedProcessingCount = fileStatus.text_failed_system + fileStatus.text_failed_user;
        planLimitProcessingCount = fileStatus.text_plan_limit;
        unsupportedFileCount = fileStatus.text_unsupported_file;
    } else if(fileStatus && processingTier === 'standard') {
        queuedProcessingCount = fileStatus.md_queued;
        processingProcessingCount = (fileStatus.md_processing);
        completedFiles = fileStatus.md_completed;
        failedProcessingCount = fileStatus.md_failed_system + fileStatus.md_failed_user;
        planLimitProcessingCount = fileStatus.md_plan_limit;
        unsupportedFileCount = fileStatus.md_unsupported_file;
    } else if(fileStatus && processingTier === 'advanced') {
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
        uploadProgress,
        processingProgress,
        progress,
    } as FileStatusSummary;
}


export const fileStatusSummaryAtom = atom<FileStatusSummary>(
    (get) => {
        const planFeatures = get(planFeaturesAtom);
        const fileStatus = get(fileStatusAtom);
        
        return calculateFileStatusSummary(fileStatus, planFeatures.processingTier);
    }
);

export const isUploadCompleteAtom = atom<boolean>((get) => {
    const fileStatusSummary = get(fileStatusSummaryAtom);
    return fileStatusSummary.uploadProgress >= 100;
});