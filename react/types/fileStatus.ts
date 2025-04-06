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
    
    // Markdown processing status
    md_unavailable: number;
    md_queued: number;
    md_processing: number;
    md_converted: number;
    md_chunked: number;
    md_embedded: number;
    md_failed: number;

    // Docling processing status
    docling_unavailable: number;
    docling_queued: number;
    docling_processing: number;
    docling_converted: number;
    docling_chunked: number;
    docling_embedded: number;
    docling_failed: number;

    // Timestamp for the last update
    last_updated_at: string; // ISO 8601 timestamp string
} 