/**
 * Agent Data Provider — Zotero image attachment requests.
 *
 * Serves image attachments (PNG, JPEG, GIF, WebP, BMP, ...) to the backend
 * agent as vision-ready base64 PNG/JPEG: reads the file, downscales when it
 * exceeds the requested dimensions, and converts the format when the source
 * is not already PNG/JPEG.
 */

import { logger } from '../../utils/logger';
import { isAttachmentAvailableRemotely } from '../../utils/webAPI';
import {
    WSZoteroAttachmentImageRequest,
    WSZoteroAttachmentImageResponse,
    AttachmentImageErrorCode,
} from '../agentProtocol';
import { ZoteroItemReference } from '../../../react/types/zotero';
import { makeRemoteFilePath } from '../documentFileIdentity';
import {
    resolveToImageAttachment,
    validateZoteroItemReference,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
} from './utils';
import {
    DEFAULT_ATTACHMENT_IMAGE_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from './timeout';
import { effectiveMaxFileSizeMB } from '../attachmentLimits';
import {
    DEFAULT_MAX_IMAGE_DIMENSION,
    HARD_MAX_IMAGE_DIMENSION,
    MAX_OUTPUT_IMAGE_BYTES,
    ImageDecodeError,
    UnsupportedImageFormatError,
    processImageBytes,
    uint8ToBase64,
} from './imageProcessing';

/** Parse a requested dimension: positive finite number clamped to the hard cap. */
function effectiveMaxDimension(requested: number | undefined): number {
    const parsed =
        typeof requested === 'number' && Number.isFinite(requested) && requested > 0
            ? Math.floor(requested)
            : DEFAULT_MAX_IMAGE_DIMENSION;
    return Math.min(parsed, HARD_MAX_IMAGE_DIMENSION);
}

/**
 * Handle zotero_attachment_image_request event.
 * Reads an image attachment, downscales/converts it, and returns base64 data.
 */
export async function handleZoteroAttachmentImageRequest(
    request: WSZoteroAttachmentImageRequest
): Promise<WSZoteroAttachmentImageResponse> {
    const { attachment, max_width, max_height, format, jpeg_quality, request_id, timeout_seconds } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;
    let errorKey = requestKey;

    // Captured by errorResponse so every post-resolution error reports which
    // child attachment was actually targeted when a parent item was supplied.
    let resolvedRef: ZoteroItemReference | null = null;

    const errorResponse = (
        error: string,
        error_code: AttachmentImageErrorCode,
    ): WSZoteroAttachmentImageResponse => ({
        type: 'zotero_attachment_image',
        request_id,
        attachment,
        resolved_attachment: resolvedRef,
        image: null,
        error,
        error_code,
    });

    // 0. Validate request shape
    const formatError = validateZoteroItemReference(attachment);
    if (formatError) {
        return errorResponse(
            `Invalid attachment reference '${requestKey}': ${formatError}`,
            'invalid_format'
        );
    }
    if (format !== undefined && !['png', 'jpeg', 'auto'].includes(format)) {
        return errorResponse(
            `Invalid format '${format}': must be png, jpeg, or auto`,
            'invalid_format'
        );
    }

    const maxWidth = effectiveMaxDimension(max_width);
    const maxHeight = effectiveMaxDimension(max_height);

    const timeout = createTimeoutController(timeout_seconds, DEFAULT_ATTACHMENT_IMAGE_TIMEOUT_SECONDS);
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id,
            attachment.zotero_key
        );
        throwIfTimedOut('zotero_item_lookup');

        if (!zoteroItem) {
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found'
            );
        }

        await zoteroItem.loadAllData();
        throwIfTimedOut('zotero_item_load');

        // 2. Resolve to an image attachment (auto-resolves regular items with one image)
        const resolveResult = await resolveToImageAttachment(zoteroItem, requestKey);
        throwIfTimedOut('image_attachment_resolution');
        if (!resolveResult.resolved) {
            return errorResponse(resolveResult.error, resolveResult.error_code);
        }
        const { item: imageItem, key: imageKey } = resolveResult;
        errorKey = imageKey;
        resolvedRef = { library_id: imageItem.libraryID, zotero_key: imageItem.key };

        // 3. Get the file path — returns false if missing or nonexistent
        const rawFilePath = await imageItem.getFilePathAsync();
        throwIfTimedOut('file_path_lookup');
        const filePath = rawFilePath || null;  // normalize false → null
        const isRemoteOnly = !filePath && isRemoteAccessAvailable(imageItem);
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(imageItem) : null);

        if (!effectiveFilePath) {
            const onServer = isAttachmentAvailableRemotely(imageItem);
            throwIfTimedOut('file_missing_response');
            return errorResponse(
                onServer
                    ? `The image file for ${imageKey} is not available locally and remote file access is disabled in settings.`
                    : `The image file for ${imageKey} is not available locally.`,
                'file_missing'
            );
        }

        // 4. Check file size limit (remote files are checked after download)
        const maxFileSizeMB = effectiveMaxFileSizeMB();
        if (!isRemoteOnly) {
            const fileSize = await Zotero.Attachments.getTotalFileSize(imageItem);
            throwIfTimedOut('file_size_check');

            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
                    return errorResponse(
                        `The image file for ${imageKey} has a file size of ${fileSizeInMB.toFixed(1)}MB, which exceeds the ${maxFileSizeMB}MB limit.`,
                        'file_too_large'
                    );
                }
            }
        }

        // 5. Load the image bytes (local file or remote download)
        let imageBytes: Uint8Array;
        try {
            imageBytes = await loadPdfData(imageItem, effectiveFilePath, isRemoteOnly);
            throwIfTimedOut('image_data_load');
        } catch (error) {
            if (!isRemoteOnly) throw error;
            logger(`handleZoteroAttachmentImageRequest: Remote download failed: ${error}`, 1);
            throwIfTimedOut('remote_download_failed_response');
            return errorResponse(
                `Failed to download image for ${imageKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                'download_failed'
            );
        }
        if (isRemoteOnly) {
            const exceeded = checkRemotePdfSize(imageBytes, false, maxFileSizeMB);
            if (exceeded) {
                return errorResponse(
                    `The image file for ${imageKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit.`,
                    'file_too_large'
                );
            }
        }

        // 6. Decode, downscale, and re-encode
        let processed;
        try {
            processed = await processImageBytes(imageBytes, imageItem.attachmentContentType || '', {
                maxWidth,
                maxHeight,
                format: format ?? 'auto',
                jpegQuality: jpeg_quality ?? 85,
                maxOutputBytes: MAX_OUTPUT_IMAGE_BYTES,
                checkpoint: throwIfTimedOut,
            });
        } catch (error) {
            // A timeout that fired mid-processing wins over the processing error.
            throwIfTimedOut('image_processing_error_response');
            if (error instanceof UnsupportedImageFormatError) {
                return errorResponse(
                    `The image file for ${imageKey} has format '${error.mimeType}', which Beaver cannot convert.`,
                    'unsupported_image_format'
                );
            }
            if (error instanceof ImageDecodeError) {
                return errorResponse(
                    `The image file for ${imageKey} could not be decoded (it may be corrupted): ${error.message}`,
                    'decode_failed'
                );
            }
            throw error;
        }
        throwIfTimedOut('image_processing');

        // 7. Build response
        return {
            type: 'zotero_attachment_image',
            request_id,
            attachment,
            resolved_attachment: resolvedRef,
            image: {
                image_data: uint8ToBase64(processed.data),
                format: processed.format,
                width: processed.width,
                height: processed.height,
                original_width: processed.originalWidth,
                original_height: processed.originalHeight,
                original_format: processed.sourceMime || 'unknown',
                resized: processed.resized,
                converted: processed.converted,
            },
        };

    } catch (error) {
        if (signal.aborted || error instanceof TimeoutError) {
            logger(`handleZoteroAttachmentImageRequest: Timed out after ${timeoutSeconds}s`, 1);
            return errorResponse(
                `Image processing timed out after ${timeoutSeconds} seconds`,
                'timeout'
            );
        }

        logger(`handleZoteroAttachmentImageRequest: Processing failed: ${error}`, 1);
        return errorResponse(
            `Failed to process image for ${errorKey}: ${error instanceof Error ? error.message : String(error)}`,
            'image_processing_failed'
        );
    } finally {
        dispose();
    }
}
