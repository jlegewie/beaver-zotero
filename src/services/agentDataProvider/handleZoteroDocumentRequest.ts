/**
 * Whole-document extraction handler for zotero_document_request.
 *
 * Resolves the request to a readable attachment, then dispatches by content
 * kind. PDFs use the shared extraction core (`documentExtractionCore.ts`).
 * On a hot-path PDF timeout, enqueues a `hot_timeout_retry` background job.
 */

import { logger } from '../../utils/logger';
import {
    WSZoteroDocumentRequest,
    WSZoteroDocumentResponse,
} from '../agentProtocol';
import type { ZoteroDocumentErrorCode } from '../agentProtocol';
import { extractAndCacheDocument } from '../documentExtractionCore';
import {
    extractTextDocument,
    resolveToReadableAttachment,
    validateZoteroItemReference,
} from '../documentExtraction';
import type { ReadableContentKind } from '../documentExtraction/readableAttachments';
import { MAX_PDF_TIMEOUT_SECONDS } from './timeout';
// Hot-path handler keeps the remote-download-failed popup behavior by
// passing the popup notifier through `onRemoteDownloadFailure`. The
// background extractor deliberately omits it.
import { notifyRemoteDownloadFailure } from './utils';

const UNIMPLEMENTED_READABLE_KINDS: ReadonlySet<ReadableContentKind> = new Set([
    'epub',
    'snapshot',
    'image',
]);

/**
 * Handle zotero_document_request event.
 * Extracts a readable attachment as a Beaver Extract (or text) result.
 */
export async function handleZoteroDocumentRequest(
    request: WSZoteroDocumentRequest,
): Promise<WSZoteroDocumentResponse> {
    const { attachment, mode, max_pages, max_file_size_mb, request_id, timeout_seconds } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;

    const errorResponse = (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages: number | null = null,
    ): WSZoteroDocumentResponse => ({
        type: 'zotero_document',
        request_id,
        total_pages,
        error,
        error_code,
    });

    const formatError = validateZoteroItemReference(attachment);
    if (formatError) {
        return errorResponse(
            `Invalid attachment reference '${requestKey}': ${formatError}`,
            'invalid_format',
        );
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        attachment.library_id,
        attachment.zotero_key,
    );
    if (!item) {
        return errorResponse(
            `Attachment does not exist in user's library: ${requestKey}`,
            'not_found',
        );
    }

    await item.loadAllData();

    const resolved = await resolveToReadableAttachment(item, requestKey);
    if (!resolved.resolved) {
        return errorResponse(resolved.error, resolved.error_code);
    }

    const { item: resolvedItem, key: resolvedKey, contentKind, contentType } = resolved;

    if (contentKind === 'text') {
        return runTextExtraction({
            item: resolvedItem,
            requestKey: resolvedKey,
            contentType,
            maxFileSizeMB: max_file_size_mb ?? 0,
            requestId: request_id,
            errorResponse,
        });
    }

    if (UNIMPLEMENTED_READABLE_KINDS.has(contentKind)) {
        return errorResponse(
            `Reading ${contentKind} attachments is not implemented yet.`,
            'not_implemented',
        );
    }

    if (contentKind !== 'pdf') {
        return errorResponse(
            `Attachment ${resolvedKey} is not a supported document type.`,
            'not_readable',
        );
    }

    const result = await extractAndCacheDocument({
        libraryId: resolvedItem.libraryID,
        zoteroKey: resolvedItem.key,
        mode,
        maxPages: max_pages ?? null,
        maxFileSizeMB: max_file_size_mb ?? 0,
        timeoutSeconds: timeout_seconds ?? 0,
        workerName: 'hot',
        onRemoteDownloadFailure: notifyRemoteDownloadFailure,
    });

    if (result.kind === 'ok') {
        return {
            type: 'zotero_document',
            request_id,
            resolved_attachment: {
                library_id: result.resolvedAttachment.libraryId,
                zotero_key: result.resolvedAttachment.zoteroKey,
            },
            content_type: result.contentType,
            result: { ...result.result, content_kind: 'pdf' as const },
        };
    }

    if (result.kind === 'timeout') {
        const target = result.resolvedAttachment ?? {
            libraryId: resolvedItem.libraryID,
            zoteroKey: resolvedItem.key,
        };
        try {
            await Zotero.Beaver?.db?.enqueueBackgroundJob({
                jobType: 'hot_timeout_retry',
                libraryId: target.libraryId,
                zoteroKey: target.zoteroKey,
                mode,
                priority: 50,
                payload: {
                    maxPages: max_pages ?? null,
                    maxFileSizeMB: max_file_size_mb ?? 0,
                    timeoutSeconds: MAX_PDF_TIMEOUT_SECONDS,
                },
                now: Date.now(),
            });
            Zotero.Beaver?.backgroundExtractor?.notify();
        } catch (e) {
            logger(`handleZoteroDocumentRequest: background enqueue failed: ${e}`, 1);
        }
        return errorResponse(
            `PDF extraction timed out after ${result.timeoutSeconds} seconds`,
            'timeout',
            result.pageCount,
        );
    }

    if (result.kind === 'external_abort') {
        return errorResponse(
            `PDF extraction interrupted`,
            'timeout',
            result.pageCount,
        );
    }

    return errorResponse(result.message, result.code, result.pageCount);
}

async function runTextExtraction(args: {
    item: Zotero.Item;
    requestKey: string;
    contentType: string;
    maxFileSizeMB: number;
    requestId: string;
    errorResponse: (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages?: number | null,
    ) => WSZoteroDocumentResponse;
}): Promise<WSZoteroDocumentResponse> {
    const extracted = await extractTextDocument({
        item: args.item,
        requestKey: args.requestKey,
        contentType: args.contentType,
        maxFileSizeMB: args.maxFileSizeMB,
        onRemoteDownloadFailure: notifyRemoteDownloadFailure,
    });

    if (extracted.kind === 'ok') {
        return {
            type: 'zotero_document',
            request_id: args.requestId,
            resolved_attachment: {
                library_id: extracted.resolvedAttachment.libraryId,
                zotero_key: extracted.resolvedAttachment.zoteroKey,
            },
            content_type: extracted.contentType,
            result: extracted.result,
        };
    }

    return args.errorResponse(extracted.message, extracted.code);
}
