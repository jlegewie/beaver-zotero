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
    "queue_failed_exceeds_plan_page_limit": "Exceeds page limit",
    "queue_failed_file_too_large": "Exceeds size limit",
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
        const fileStatus = get(fileStatusAtom);
        
        // Total files
        const totalFiles = fileStatus?.total_files || 0;

        // Upload status
        const uploadPendingCount = fileStatus?.upload_pending || 0;
        const uploadCompletedCount = fileStatus?.upload_completed || 0;
        const uploadFailedCount = fileStatus?.upload_failed || 0;
        const uploadSkippedCount = fileStatus?.upload_skipped || 0;

        // Processing status based on plan features
        let completedFiles = 0;
        let skippedProcessingCount = 0;
        let failedProcessingCount = 0;
        let activeProcessingCount = 0;
        let queuedProcessingCount = 0;

        if(fileStatus && planFeatures.processingTier === 'basic') {
            completedFiles = fileStatus.text_embedded;
            skippedProcessingCount = fileStatus.text_skipped;
            failedProcessingCount = fileStatus.text_failed;
            activeProcessingCount = (fileStatus.text_processing);
            queuedProcessingCount = fileStatus.text_queued;
        } else if(fileStatus && planFeatures.processingTier === 'standard') {
            completedFiles = fileStatus.md_embedded;
            skippedProcessingCount = fileStatus.md_skipped;
            failedProcessingCount = fileStatus.md_failed;
            activeProcessingCount = (fileStatus.md_processing);
            queuedProcessingCount = fileStatus.md_queued;
        } else if(fileStatus && planFeatures.processingTier === 'advanced') {
            completedFiles = fileStatus.docling_embedded;
            skippedProcessingCount = fileStatus.docling_skipped;
            failedProcessingCount = fileStatus.docling_failed;
            activeProcessingCount = fileStatus.docling_processing;
            queuedProcessingCount = fileStatus.docling_queued;
        }

        const totalProcessingCount = failedProcessingCount + activeProcessingCount + queuedProcessingCount + completedFiles + skippedProcessingCount
        const processingProgress = totalProcessingCount > 0
            ? Math.min((completedFiles + skippedProcessingCount + failedProcessingCount) / totalProcessingCount * 100, 100)
            : 0;

        // combined stats
        const failedCount = uploadFailedCount + failedProcessingCount;
        const activeCount = uploadPendingCount + activeProcessingCount;
        
        // Overall Progress
        const progress = totalProcessingCount > 0
                ? (completedFiles + skippedProcessingCount + failedProcessingCount) / totalProcessingCount * 100
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