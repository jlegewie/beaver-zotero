/**
 * Represents the processing status summary for a user's files.
 * Mirrors the files_status table in the database and the FileStatus type in the backend.
 */
export interface FileStatus {
    user_id: string;
    total_files: number;

    // Upload status
    upload_pending: number;
    upload_completed: number;
    upload_failed: number;
    upload_plan_limit: number;

    // Basic processing status (text)
    text_queued: number;
    text_processing: number;
    text_completed: number;
    text_failed_system: number;
    text_failed_user: number;
    text_plan_limit: number;
    text_unsupported_file: number;

    // Standard processing status (markdown)
    md_queued: number;
    md_processing: number;
    md_completed: number;
    md_failed_system: number;
    md_failed_user: number;
    md_plan_limit: number;
    md_unsupported_file: number;

    // Advanced processing status (docling)
    docling_queued: number;
    docling_processing: number;
    docling_completed: number;
    docling_failed_system: number;
    docling_failed_user: number;
    docling_plan_limit: number;
    docling_unsupported_file: number;

    // Timestamp for the last update
    last_updated_at: string; // ISO 8601 timestamp string
}

// Aggregated file processing status stats
export interface FileStatusSummary {
    fileStatusAvailable: boolean,

    // Combined counts
    totalFiles: number,
    failedCount: number,
    activeCount: number,
    planLimitCount: number,

    // Upload status
    uploadPendingCount: number,
    uploadCompletedCount: number,
    uploadFailedCount: number,
    uploadPlanLimitCount: number,

    // Processing status
    queuedProcessingCount: number,
    processingProcessingCount: number,
    completedFiles: number,
    failedProcessingCount: number,
    planLimitProcessingCount: number,
    unsupportedFileCount: number,

    // Processing summary
    totalProcessingCount: number,
    processingProgress: number,
    progress: number,
}