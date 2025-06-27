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
    upload_skipped: number;

    // Basic processing status (text)
    text_unavailable: number;
    text_balance_insufficient: number;
    text_queued: number;
    text_processing: number;
    text_embedded: number;
    text_failed: number;
    text_skipped: number;

    // Standard processing status (markdown)
    md_unavailable: number;
    md_balance_insufficient: number;
    md_queued: number;
    md_processing: number;
    md_embedded: number;
    md_failed: number;
    md_skipped: number;

    // Advanced processing status (docling)
    docling_unavailable: number;
    docling_balance_insufficient: number;
    docling_queued: number;
    docling_processing: number;
    docling_embedded: number;
    docling_failed: number;
    docling_skipped: number;

    // Timestamp for the last update
    last_updated_at: string; // ISO 8601 timestamp string
}

// Aggregated file processing status stats
export interface FileStatusStats {
    fileStatusAvailable: boolean;
    totalFiles: number;
    completedFiles: number;
    failedProcessingCount: number;
    skippedProcessingCount: number;
    balanceInsufficientProcessingCount: number;
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
    uploadSkippedCount: number;
}