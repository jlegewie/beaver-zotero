import { atom } from "jotai";
import { planFeaturesAtom } from "./profile";
import { ErrorCode } from "src/services/attachmentsService";


interface ErrorGroup {
    name: string;
    details: string;
    errorCodes: ErrorCode[];
}

// Mapping of error codes to user error messages (covers error codes from ProcessingErrorCode pydantic model)
export const errorMapping = {
    // Queue failed
    "queue_failed": "Unexpected error",
    "queue_failed_invalid_user": "Unexpected error",
    "queue_failed_invalid_page_count": "Unable to read file",
    "queue_failed_database_error": "Unexpected error",
    
    // Plan limits
    "plan_limit_unsupported_file": "File Type not supported",
    "plan_limit_max_pages": "Too many pages",
    "plan_limit_max_pages_ocr": "Too many pages for OCR",
    "plan_limit_insufficient_balance": "Insufficient balance",
    "plan_limit_file_size": "File too large",
    
    // File errors
    "encrypted": "File is encrypted",
    "no_text_layer": "File requires OCR",
    "insufficient_text": "Insufficient text",
    "file_missing": "File missing",
    "ocr_failed": "OCR failed",
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
    "unexpected_error": "Unexpected error",
    
    // Upload errors 
    "attachment_not_found": "Attachment deleted",
    "file_unavailable": "File not available",
    "zotero_credentials_invalid": "Zotero login required",
    "server_download_failed": "Zotero server download failed",
    "unable_to_read_file": "Unable to read file",
    "storage_upload_failed": "Upload failed",
    "completion_failed": "Upload failed",
    "invalid_file_metadata": "Invalid file metadata"
}


export const errorGroupsAtom = atom((get) => {
    const planFeatures = get(planFeaturesAtom);
    return [
        {
            name: "Files with processing errors",
            details: "Check your internet connection and retry",
            errorCodes: ["queue_failed", "queue_failed_invalid_user", "queue_failed_database_error", "download_failed", "preprocessing_failed", "conversion_failed", "opening_failed", "upload_failed", "chunk_failed", "embedding_failed", "db_update_failed", "max_retries", "timeout", "unexpected_error", "ocr_failed"],
        },
        {
            name: "Files with unsupported file type",
            details: "Only PDFs are supported for Beta",
            errorCodes: ["plan_limit_unsupported_file"],
        },
        {
            name: "Files over the per-file page limit",
            details: `${planFeatures.maxPageCount} pages max per file`,
            errorCodes: ["plan_limit_max_pages", "plan_limit_max_pages_ocr"],
        },
        // {
        //     name: "Files over the OCR page limit",
        //     details: "OCR is limited for your plan",
        //     errorCodes: ["plan_limit_max_pages_ocr"],
        // },
        {
            name: "Files exceed your page balance",
            details: "Full-document search limited to 75k pages for Beta",
            errorCodes: ["plan_limit_insufficient_balance"],
        },
        {
            name: "Files over the per-file size limit",
            details: `${planFeatures.uploadFileSizeLimit}MB max per file`,
            errorCodes: ["plan_limit_file_size"],
        },
        {
            name: "Scanned PDFs that need OCR",
            details: "Supported in the future",
            errorCodes: ["no_text_layer"],
        },
        {
            name: "Files with insufficient text",
            details: "File may be primarily images",
            errorCodes: ["insufficient_text"],
        },
        {
            name: "Files not found",
            details: "Files may have been moved or deleted",
            errorCodes: ["file_missing", "attachment_not_found", "file_unavailable", "server_download_failed"],
        },
        {
            name: "Files unable to read",
            details: "File may be corrupted or have permission issues",
            errorCodes: ["queue_failed_invalid_page_count", "unable_to_read_file", "invalid_file_metadata", "encrypted"],
        },
        {
            name: "Files requiring Zotero login",
            details: "Sign in to Zotero (Edit → Preferences → Sync)",
            errorCodes: ["zotero_credentials_invalid"],
        },
        {
            name: "Files failed to upload",
            details: "Check your internet connection and retry",
            errorCodes: ["storage_upload_failed", "completion_failed"],
        }
    ] as ErrorGroup[];
});


export const errorMappingOverview = {
    // Queue failed
    "queue_failed": "Files with processing errors",
    "queue_failed_invalid_user": "Files with processing errors",
    "queue_failed_invalid_page_count": "Files unable to read",
    "queue_failed_database_error": "Files with processing errors",
    
    // Plan limits
    "plan_limit_unsupported_file": "Files with unsupported file type",
    "plan_limit_max_pages": "Files over the per-file page limit",
    "plan_limit_max_pages_ocr": "Files over the OCR page limit",
    "plan_limit_insufficient_balance": "Files exceed your page balance",
    "plan_limit_file_size": "Files over the per-file size limit",
    
    // File errors
    "encrypted": "Password-protected files",
    "no_text_layer": "Scanned PDFs that need OCR",
    "insufficient_text": "Files with too little readable text",
    "file_missing": "Files not found",
    "ocr_failed": "Files where OCR failed",

    "download_failed": "Files with processing errors",
    "preprocessing_failed": "Files with processing errors",
    "conversion_failed": "Files with processing errors",
    "opening_failed": "Files with processing errors",
    "upload_failed": "Files with processing errors",
    "chunk_failed": "Files with processing errors",
    "embedding_failed": "Files with processing errors",
    "db_update_failed": "Files with processing errors",
    "max_retries": "Files with processing errors",
    "timeout": "Files with processing errors",
    "unexpected_error": "Files with processing errors",
    
    // Upload errors
    "attachment_not_found": "Files deleted from Zotero",
    "file_unavailable": "Files not available locally or on server",
    "zotero_credentials_invalid": "Files requiring Zotero login",
    "server_download_failed": "Files failed to download from Zotero server",
    "unable_to_read_file": "Files unable to read",
    "storage_upload_failed": "Files failed to upload",
    "completion_failed": "Files uploaded but not confirmed",
    "invalid_file_metadata": "Files with invalid metadata"
}

export const errorMappingHintAtom = atom((get) => {
    const planFeatures = get(planFeaturesAtom);
    return {
        "plan_limit_max_pages": `${planFeatures.maxPageCount} pages max per file`,
        "plan_limit_file_size": `${planFeatures.uploadFileSizeLimit}MB max per file`,
        "plan_limit_unsupported_file": "Only PDFs are supported for Beta",
        "plan_limit_insufficient_balance": "Full-document search limited to 75k pages for Beta. You can still add files manually.",
        "no_text_layer": "Supported in the future",
        
        // Upload error hints
        "zotero_credentials_invalid": "Sign in to Zotero (Edit → Preferences → Sync)",
        "file_unavailable": "File links may be broken in Zotero",
        "unable_to_read_file": "File may be corrupted or have permission issues",
        "storage_upload_failed": "Check your internet connection and retry",
        "completion_failed": "Retry to complete the upload",
        "invalid_file_metadata": "File may be password-protected or corrupted"
    };
});