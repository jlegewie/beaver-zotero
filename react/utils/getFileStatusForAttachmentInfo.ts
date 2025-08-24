import { syncingItemFilter } from '../../src/utils/sync';
import { fileUploader } from '../../src/services/FileUploader';
import { logger } from '../../src/utils/logger';
import { errorMapping } from '../atoms/files';
import { AttachmentStatusResponse, attachmentsService } from '../../src/services/attachmentsService';
import { store } from '../store';
import { userAtom } from '../atoms/auth';
import { planFeaturesAtom, syncLibraryIdsAtom } from '../atoms/profile';
import attachmentStatusManager from '../../src/services/attachmentStatusManager';
import { getMimeType } from '../../src/utils/zoteroUtils';

// Define the structure or interface for your status data
interface BeaverStatusInfo {
    text: string;
    showButton: boolean;
    buttonTooltip?: string;
    buttonLabel?: string;
    buttonDisabled?: boolean;
    onClick?: () => void;
    buttonIcon?: string; // Optional: path to an icon
}

export async function getFileStatusForAttachmentInfo(attachmentItem: Zotero.Item): Promise<BeaverStatusInfo> {
    logger(`getFileStatusForAttachmentInfo: Getting Beaver status for item ${attachmentItem.id}`);
    try {
        const libraryIds = store.get(syncLibraryIdsAtom);
        const user = store.get(userAtom);
        if (!user) {
            return { text: 'Not logged in', showButton: false };
        }
        
        // 1. Is file valid
        if (!libraryIds.includes(attachmentItem.libraryID)) {
            return { text: 'Library not synced', showButton: false };
        }
        if (!syncingItemFilter(attachmentItem)) {
            if (attachmentItem.isInTrash()) return {text: 'File not synced', showButton: false };
            return {
                text: 'Unsupported file type',
                showButton: true,
                buttonIcon: 'chrome://beaver/content/icons/info.svg',
                buttonTooltip: 'Beaver only supports PDF and image files',
                buttonDisabled: true
            };
        }

        // 2. Does the attachment file exist?
        if (!(await attachmentItem.fileExists())) {
            return { text: 'File does not exist', showButton: false };
        }

        // 3. Get attachment status from Beaver DB (local cache first, then backend)
        const planFeatures = store.get(planFeaturesAtom);
        let attachmentStatus: AttachmentStatusResponse | null = null;
        try {
            attachmentStatus = await attachmentStatusManager.getAttachmentStatus(attachmentItem.libraryID, attachmentItem.key);
        } catch (error) {
            logger(`getFileStatusForAttachmentInfo: Error getting attachment status for ${attachmentItem.key}: ${error}`);
        }
        if (!attachmentStatus) {
            return { text: 'Unknown status', showButton: false };
        }

        // Processing status of file
        let fileStatus = attachmentStatus.text_status;
        let errorCode = attachmentStatus.text_error_code;
        if(planFeatures.processingTier === 'standard') {
            fileStatus = attachmentStatus.md_status;
            errorCode = attachmentStatus.md_error_code;
        } else if(planFeatures.processingTier === 'advanced') {
            fileStatus = attachmentStatus.docling_status;
            errorCode = attachmentStatus.docling_error_code;
        }
        if (!fileStatus) {
            return { text: 'Unknown status', showButton: false };
        }

        // 4. Check if the hash has changed
        const currentHash = await attachmentItem.attachmentHash;
        const hashChanged = Boolean(!attachmentStatus.file_hash) || attachmentStatus.file_hash !== currentHash;

        // Status: Uploading
        if (attachmentStatus.upload_status === 'pending') {
            return {
                text: 'Uploading...',
                showButton: false
            };
        }

        // 5. Return the status
        switch (fileStatus) {
            case null:
                return {
                    text: 'Processing not available',
                    showButton: false,
                };
            case 'plan_limit': {
                const errorDescription = errorMapping[errorCode as keyof typeof errorMapping] || "Unexpected error";
                return {
                    text: `Plan limit: ${errorDescription}`,
                    showButton: false,
                };
            }
            case 'queued':
                return { text: 'Waiting for processing...', showButton: false };
            case 'processing':
                return { text: 'Processing...', showButton: false };
            case 'completed':
                return {
                    text: 'Completed',
                    showButton: true,
                    buttonTooltip: 'Reprocess this attachment',
                    buttonIcon: 'chrome://zotero/skin/20/universal/sync.svg',
                    // buttonIcon: 'chrome://zotero/skin/tick.png'
                    buttonDisabled: !hashChanged,
                    onClick: async () => {
                        const mimeType = await getMimeType(attachmentItem);
                        await attachmentsService.updateFile(attachmentItem.libraryID, attachmentItem.key, currentHash, mimeType);
                        await fileUploader.start("manual");
                    }
                };
            case 'failed_system':
            case 'failed_user': {
                // Error code if any
                const errorDescription = errorMapping[errorCode as keyof typeof errorMapping] || "Unexpected error";
                return {
                    text: `Failed: ${errorDescription}`,
                    showButton: true, // Allow retry
                    buttonTooltip: 'Retry processing',
                    buttonIcon: 'chrome://zotero/skin/20/universal/sync.svg',
                    buttonDisabled: !hashChanged,
                    onClick: async () => {
                        const mimeType = await getMimeType(attachmentItem);
                        await attachmentsService.updateFile(attachmentItem.libraryID, attachmentItem.key, currentHash, mimeType);
                        await fileUploader.start("manual");
                    }
                };
              }
            default:
                // Handle unexpected status values explicitly
                return {
                    text: `Unknown status: ${fileStatus}`,
                    showButton: false
                };
        }

    } catch (error) {
        logger(`getFileStatusForAttachmentInfo: Error fetching Beaver status for ${attachmentItem.id}: ${error}`);
        return { text: 'Error fetching status', showButton: false }; // Return an error status
    }
}