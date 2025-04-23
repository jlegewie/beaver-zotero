import { syncingItemFilter } from '../../src/utils/sync';
import { attachmentsService } from '../../src/services/attachmentsService';
import { logger } from '../../src/utils/logger';
// import { attachmentsService as staticAttachmentsService, AttachmentStatusResponse } from '../services/attachmentsService';


// import { AttachmentStatusResponse } from '../services/attachmentsService';

// Copied from react/utils/sourceUtils.ts
// export function syncingItemFilter(item: Zotero.Item): boolean {
//     return item.libraryID === 1 && (item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment());
// };

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
    logger(`Getting Beaver status for item ${attachmentItem.id}`);
    try {
        // 1. Is file valid
        if (attachmentItem.libraryID !== 1) {
            return { text: 'Unsupported library', showButton: false };
        }
        if (!syncingItemFilter(attachmentItem)) {
            return { text: 'Unsupported file type', showButton: false };
        }

        // 2. Does the attachment file exist?
        if (!(await attachmentItem.fileExists())) {
            return { text: 'File does not exist', showButton: false };
        }

        // 3. Get status from backend
        const attachmentStatus = await attachmentsService.getAttachmentStatus(attachmentItem.libraryID, attachmentItem.key);
        const fileStatus = attachmentStatus.md_status;
        const errorCode = attachmentStatus.md_error_code;
        if (!fileStatus) {
            return { text: 'Unknown status', showButton: false };
        }

        // 4. Check if the hash has changed
        const currentHash = await attachmentItem.attachmentHash;
        const hashChanged = Boolean(!attachmentStatus.file_hash) || attachmentStatus.file_hash !== currentHash;

        // 5. Return the status
        switch (fileStatus) {
            case 'unavailable':
                return { text: 'Processing not available', showButton: false };
            case 'balance_insufficient':
                return { text: 'Insufficient balance', showButton: true, buttonDisabled: hashChanged, onClick: () => {console.log('clicked') } };
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
                    buttonDisabled: !hashChanged
                    // buttonIcon: 'chrome://zotero/skin/tick.png'
                };
            case 'failed':
                return {
                    text: 'Processing failed',
                    showButton: true, // Allow retry
                    buttonTooltip: 'Retry processing',
                    buttonDisabled: !hashChanged
                    // buttonIcon: 'chrome://zotero/skin/cross.png',
                };
            default:
                // Handle unexpected status values explicitly
                return {
                    text: `Unknown status: ${fileStatus}`,
                    showButton: false
                };
        }

    } catch (error) {
        logger(`Error fetching Beaver status for ${attachmentItem.id}: ${error}`);
        return { text: 'Error fetching status', showButton: false }; // Return an error status
    }
}