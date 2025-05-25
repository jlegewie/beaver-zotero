import { syncingItemFilter } from '../../src/utils/sync';
import { attachmentsService } from '../../src/services/attachmentsService';
import { syncService } from '../../src/services/syncService';
import { fileUploader } from '../../src/services/FileUploader';
import { logger } from '../../src/utils/logger';
import { errorMapping } from '../components/FileStatusStats'
import { AttachmentStatusResponse } from '../../src/services/attachmentsService';
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

        // 3. Try to get attachment status from Beaver DB
        const attachmentStatus = await getAttachmentStatus(attachmentItem, user.id);
        if (!attachmentStatus) {
            return { text: 'Unknown status', showButton: false };
        }

        const fileStatus = attachmentStatus.md_status;
        const errorCode = attachmentStatus.md_error_code;
        if (!fileStatus) {
            return { text: 'Unknown status', showButton: false };
        }

        // 4. Check if the hash has changed
        const currentHash = await attachmentItem.attachmentHash;
        const hashChanged = Boolean(!attachmentStatus.file_hash) || attachmentStatus.file_hash !== currentHash;

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
                    onClick: () => {syncService.forceAttachmentFileUpdate(attachmentItem.libraryID, attachmentItem.key, currentHash); }
                };
            case 'queued':
                return { text: 'Waiting for processing...', showButton: false };
            case 'processing':
            case 'converted':
            case 'chunked':
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
                        syncService.forceAttachmentFileUpdate(attachmentItem.libraryID, attachmentItem.key, currentHash);
                        await fileUploader.start("manual");
                    }
                };
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
                        syncService.forceAttachmentFileUpdate(attachmentItem.libraryID, attachmentItem.key, currentHash);
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