import { syncingItemFilter } from '../../src/utils/sync';
import { attachmentsService } from '../../src/services/attachmentsService';
import { syncService } from '../../src/services/syncService';
import { fileUploader } from '../../src/services/FileUploader';
import { logger } from '../../src/utils/logger';
import { errorMapping } from '../components/FileStatusStats'
import { AttachmentStatusResponse } from '../../src/services/attachmentsService';

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
        // @ts-ignore Beaver is defined
        const attachmentsDB = await Zotero.Beaver.db?.getAttachmentsByZoteroKeys(attachmentItem.libraryID, [attachmentItem.key]);
        let attachmentStatus: AttachmentStatusResponse | null = null;
        if (attachmentsDB && attachmentsDB.length > 0) {
            const attachmentDB = attachmentsDB[0];
            if (attachmentDB.file_hash && attachmentDB.md_status && attachmentDB.md_status === 'embedded') {
                logger(`Beaver DB found attachment status for ${attachmentItem.key}`);
                attachmentStatus = {
                    attachment_id: attachmentDB.id,
                    ...attachmentDB
                } as AttachmentStatusResponse;
            }
        }
        if (!attachmentStatus) {
            logger(`Beaver DB not found for ${attachmentItem.key}. Getting status from backend.`);
            // 4. Get status from backend
            attachmentStatus = await attachmentsService.getAttachmentStatus(attachmentItem.libraryID, attachmentItem.key);

            // 5. Save status to Beaver DB
            try {
                // @ts-ignore Beaver is defined
                await Zotero.Beaver.db?.updateAttachment(
                    attachmentItem.libraryID,
                    attachmentItem.key,
                    {
                        file_hash: attachmentStatus.file_hash,
                        upload_status: attachmentStatus.upload_status,
                        md_status: attachmentStatus.md_status,
                        docling_status: attachmentStatus.docling_status,
                        md_error_code: attachmentStatus.md_error_code,
                        docling_error_code: attachmentStatus.docling_error_code
                    }
                );
            } catch (error) {
                logger(`Error saving attachment status to Beaver DB for ${attachmentItem.key}: ${error}`);
            }
        }
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
                    onClick: () => {
                        syncService.forceAttachmentFileUpdate(attachmentItem.libraryID, attachmentItem.key, currentHash);
                        fileUploader.start();
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
                    onClick: () => {
                        syncService.forceAttachmentFileUpdate(attachmentItem.libraryID, attachmentItem.key, currentHash);
                        fileUploader.start();
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
        logger(`Error fetching Beaver status for ${attachmentItem.id}: ${error}`);
        return { text: 'Error fetching status', showButton: false }; // Return an error status
    }
}