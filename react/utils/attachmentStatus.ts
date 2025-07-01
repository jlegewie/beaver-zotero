import { planFeaturesAtom } from "../atoms/profile";
import { attachmentsService, AttachmentStatusResponse } from "../../src/services/attachmentsService";
import { logger } from "../../src/utils/logger";
import { store } from "../index";

/**
 * Fetches the attachment status for a given attachment item and user ID.
 * 
 * 1. Try to get attachment status from Beaver DB
 * 2. If no status in Beaver DB, get status from backend
 * 3. Save status to Beaver DB if fetched from backend
 * 
 * @param attachmentItem The Zotero item representing the attachment.
 * @param user_id The user ID for which to fetch the attachment status.
 * @returns A promise that resolves to the attachment status response.
 */
export async function getAttachmentStatus(
    attachmentItem: Zotero.Item,
    user_id: string
): Promise<AttachmentStatusResponse> {
    // Initialize attachment status
    let attachmentStatus: AttachmentStatusResponse | null = null;

    // 1. Get attachment status from Beaver DB
    const attachmentsDB = await Zotero.Beaver.db.getAttachmentsByZoteroKeys(user_id, attachmentItem.libraryID, [attachmentItem.key]);
    if (attachmentsDB && attachmentsDB.length > 0) {
        logger(`getFileStatusForAttachmentInfo: Beaver DB found attachment status for ${attachmentItem.key}`);
        const attachmentDB = attachmentsDB[0];
        attachmentStatus = {
            attachment_id: attachmentDB.id,
            ...attachmentDB
        } as AttachmentStatusResponse;
    }

    // 2. If no status in Beaver DB, get status from backend
    if (!attachmentStatus) {
        logger(`getFileStatusForAttachmentInfo: Getting status from backend.`);
        attachmentStatus = await attachmentsService.getAttachmentStatus(attachmentItem.libraryID, attachmentItem.key);

        // 3. Save status to Beaver DB
        try {
            await Zotero.Beaver.db.updateAttachment(
                user_id,
                attachmentItem.libraryID,
                attachmentItem.key,
                {
                    file_hash: attachmentStatus.file_hash,
                    upload_status: attachmentStatus.upload_status,
                    text_status: attachmentStatus.text_status,
                    md_status: attachmentStatus.md_status,
                    docling_status: attachmentStatus.docling_status,
                    text_error_code: attachmentStatus.text_error_code,
                    md_error_code: attachmentStatus.md_error_code,
                    docling_error_code: attachmentStatus.docling_error_code
                }
            );
        } catch (error) {
            logger(`getFileStatusForAttachmentInfo: Error saving attachment status to Beaver DB for ${attachmentItem.key}: ${error}`);
        }
    }

    return attachmentStatus;
}