import { syncingItemFilter } from '../../src/utils/sync';
import { fileUploader } from '../../src/services/FileUploader';
import { logger } from '../../src/utils/logger';
import { errorMapping } from '../atoms/files';
import { AttachmentStatusResponse, attachmentsService } from '../../src/services/attachmentsService';
import { store } from '../index';
import { userAtom } from '../atoms/auth';
import { getAttachmentStatus } from './attachmentStatus';
import { planFeaturesAtom } from '../atoms/profile';

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
        const user = store.get(userAtom);
        if (!user) {
            return { text: 'Not logged in', showButton: false };
        }

        // 0. Check if user has a subscription
        if (!store.get(planFeaturesAtom).fileProcessing) {
            return {
                text: 'Processing not available',
                showButton: true,
                buttonIcon: 'chrome://beaver/content/icons/info.svg',
                buttonTooltip: `File processing is only available for users without a subscription.`,
                buttonDisabled: true
            };
        }
        
        // 1. Is file valid
        if (attachmentItem.libraryID !== 1) {
            return { text: 'Unsupported library', showButton: false };
        }
        if (!syncingItemFilter(attachmentItem)) {
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
        let attachmentStatus: AttachmentStatusResponse | null = null;
        try {
            attachmentStatus = await getAttachmentStatus(attachmentItem, user.id);
        } catch (error) {
            logger(`getFileStatusForAttachmentInfo: Error getting attachment status for ${attachmentItem.key}: ${error}`);
        }
        if (!attachmentStatus) {
            return { text: 'Unknown status', showButton: false };
        }

        // Processing status of file
        const planFeatures = store.get(planFeaturesAtom);
        const fileStatus = planFeatures.advancedProcessing ? attachmentStatus.advanced_status : attachmentStatus.standard_status;
        const errorCode = planFeatures.advancedProcessing ? attachmentStatus.advanced_error_code : attachmentStatus.standard_error_code;
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
            case 'unavailable':
                return {
                    text: 'Processing not available',
                    showButton: true,
                    buttonIcon: 'chrome://beaver/content/icons/info.svg',
                    buttonTooltip: 'File processing is only available for users with a subscription.',
                    buttonDisabled: true
                };
            case 'balance_insufficient':
                return {
                    text: 'Insufficient balance',
                    showButton: true,
                    buttonIcon: 'chrome://beaver/content/icons/info.svg',
                    buttonTooltip: 'Your balance is insufficient to process this file.',
                    buttonDisabled: true,
                    onClick: () => {attachmentsService.updateFile(attachmentItem.libraryID, attachmentItem.key, currentHash); }
                };
            case 'queued':
                return { text: 'Waiting for processing...', showButton: false };
            case 'processing':
                return { text: 'Processing...', showButton: false };
            case 'embedded':
                return {
                    text: 'Completed',
                    showButton: true, // Allow reprocessing
                    buttonTooltip: 'Reprocess this attachment',
                    buttonIcon: 'chrome://zotero/skin/20/universal/sync.svg',
                    // buttonIcon: 'chrome://zotero/skin/tick.png'
                    buttonDisabled: !hashChanged,
                    onClick: async () => {
                        await attachmentsService.updateFile(attachmentItem.libraryID, attachmentItem.key, currentHash);
                        await fileUploader.start("manual");
                    }
                };
            case 'skipped':
                return { text: 'Skipped', showButton: false };
            case 'failed': {
                // Error code if any
                const errorDescription = errorMapping[errorCode as keyof typeof errorMapping] || "Unexpected error";
                return {
                    text: `Processing failed: ${errorDescription}`,
                    showButton: true, // Allow retry
                    buttonTooltip: 'Retry processing',
                    buttonIcon: 'chrome://zotero/skin/20/universal/sync.svg',
                    buttonDisabled: !hashChanged,
                    onClick: async () => {
                        await attachmentsService.updateFile(attachmentItem.libraryID, attachmentItem.key, currentHash);
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