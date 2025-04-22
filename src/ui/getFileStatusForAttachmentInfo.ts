import { syncingItemFilter } from '../utils/sync';
import { attachmentsService } from '../services/attachmentsService';
import { logger } from '../utils/logger';
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
        if (!fileStatus) {
            return { text: 'Unknown status', showButton: true };
        }
        
        switch (fileStatus) {
            case 'unavailable':
                return { text: 'Processing not available', showButton: false };
            case 'balance_insufficient':
                return { text: 'Insufficient balance', showButton: false };
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
                    buttonLabel: 'Reprocess',
                    // buttonIcon: 'chrome://zotero/skin/tick.png'
                };
            case 'failed':
                return {
                    text: 'Processing failed',
                    showButton: true, // Allow retry
                    buttonTooltip: 'Retry processing',
                    buttonLabel: 'Retry',
                    // buttonIcon: 'chrome://zotero/skin/cross.png',
                };
            default:
                // Handle unexpected status values explicitly
                return {
                    text: `Unknown status: ${fileStatus}`,
                    showButton: true, // Default to allowing reprocessing for unknowns
                    buttonTooltip: 'Reprocess this attachment',
                    buttonLabel: 'Reprocess',
                };
        }

    } catch (error) {
        logger(`Error fetching Beaver status for ${attachmentItem.id}: ${error}`);
        return { text: 'Error fetching status', showButton: false }; // Return an error status
    }
}