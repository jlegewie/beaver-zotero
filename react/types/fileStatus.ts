
/**
 * Represents the processing status summary for a user's files.
 * Mirrors the files_status table in the database and the FileStatus type in the backend.
 */
export interface FileStatus {
    user_id: string;
    total_files: number;

    // Upload status
    upload_not_uploaded: number;
    upload_pending: number;
    upload_completed: number;
    upload_failed: number;

    // File processing status
    md_queued: number;
    md_processing: number;
    md_completed: number;
    md_failed_upload: number;
    md_failed_system: number;
    md_failed_user: number;
    md_plan_limit: number;
    md_unsupported_file: number;
    page_balance_exhausted: boolean;

    // Indexing status
    indexing_complete: boolean;
    indexing_progress: number;  // 0-100

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

    // Failure categories
    failedUploadCount: number,     // Category 1: Temporary upload error
    failedUserCount: number,       // Category 2: Invalid file (Client-side or server-side)
    failedSystemCount: number,     // Category 3: System processing error
    planLimitCount: number,        // Category 4: Plan limit (Client-side or server-side)
    unsupportedFileCount: number,

    // Upload status
    uploadNotUploadedCount: number,
    uploadPendingCount: number,
    uploadCompletedCount: number,
    uploadFailedCount: number,

    // Processing status
    queuedProcessingCount: number,
    processingProcessingCount: number,
    completedFiles: number,

    // Processing summary
    totalProcessingCount: number,
    uploadProgress: number,
    progress: number,
    pageBalanceExhausted: boolean,
}