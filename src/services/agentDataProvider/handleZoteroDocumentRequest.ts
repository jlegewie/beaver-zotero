/**
 * Whole-document extraction handler for zotero_document_request.
 *
 * Thin wrapper around the shared extraction core
 * (`src/services/documentExtractionCore.ts`). On a v1 hot-path timeout it
 * enqueues a `hot_timeout_retry` background job so the background
 * processor can retry with a longer budget on its own worker.
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
} from '../documentExtraction';
import { getReadableContentKind } from '../documentExtraction/readableAttachments';
import { MAX_PDF_TIMEOUT_SECONDS } from './timeout';
// Hot-path handler keeps the remote-download-failed popup behavior by
// passing the popup notifier through `onRemoteDownloadFailure`. The
// background extractor deliberately omits it.
import { notifyRemoteDownloadFailure } from './utils';

/**
 * Handle zotero_document_request event.
 * Extracts the full PDF as a Beaver Extract result.
 */
export async function handleZoteroDocumentRequest(
    request: WSZoteroDocumentRequest,
): Promise<WSZoteroDocumentResponse> {
    const { attachment, mode, max_pages, max_file_size_mb, request_id, timeout_seconds } = request;

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

    const result = await extractAndCacheDocument({
        libraryId: attachment.library_id,
        zoteroKey: attachment.zotero_key,
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
        // Hot-path budget exhausted. Enqueue a background retry so the
        // queue processor can finish the work on the background worker
        // with the MAX_PDF_TIMEOUT_SECONDS budget. Failures here are
        // logged but do not affect the user-facing response.
        const target = result.resolvedAttachment ?? {
            libraryId: attachment.library_id,
            zoteroKey: attachment.zotero_key,
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
            // Wake the background loop so the retry starts immediately
            // rather than waiting for the next idle poll.
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
        // Hot-path never supplies an external abort signal; this branch
        // exists for type safety. Return a timeout-shaped response.
        return errorResponse(
            `PDF extraction interrupted`,
            'timeout',
            result.pageCount,
        );
    }

    if (
        result.kind === 'response_error'
        && (result.code === 'not_pdf' || result.code === 'not_attachment')
    ) {
        const textRetry = await tryTextDocumentFallback({
            libraryId: attachment.library_id,
            zoteroKey: attachment.zotero_key,
            requestId: request_id,
            requestKey: `${attachment.library_id}-${attachment.zotero_key}`,
            maxFileSizeMB: max_file_size_mb ?? 0,
            originalError: result,
            errorResponse,
        });
        if (textRetry) return textRetry;
    }

    // cached_error / response_error — return the existing message shape.
    return errorResponse(result.message, result.code, result.pageCount);
}

type PdfRejection = {
    code: ZoteroDocumentErrorCode;
    message: string;
    pageCount: number | null;
};

async function hasPdfChildAttachment(item: Zotero.Item): Promise<boolean> {
    await Zotero.Items.loadDataTypes([item], ['childItems']);
    const ids = item.getAttachments();
    if (!ids?.length) return false;
    const attachments = await Zotero.Items.getAsync(ids);
    return attachments.some((attachment) =>
        !!attachment
        && !attachment.deleted
        && attachment.isPDFAttachment(),
    );
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

async function tryTextDocumentFallback(args: {
    libraryId: number;
    zoteroKey: string;
    requestId: string;
    requestKey: string;
    maxFileSizeMB: number;
    originalError: PdfRejection;
    errorResponse: (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages?: number | null,
    ) => WSZoteroDocumentResponse;
}): Promise<WSZoteroDocumentResponse | null> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(args.libraryId, args.zoteroKey);
    if (!item) return null;
    await item.loadAllData();

    if (item.isAttachment()) {
        const contentKind = getReadableContentKind(item);
        if (contentKind === 'text') {
            return runTextExtraction({
                item,
                requestKey: args.requestKey,
                contentType: item.attachmentContentType || 'unknown',
                maxFileSizeMB: args.maxFileSizeMB,
                requestId: args.requestId,
                errorResponse: args.errorResponse,
            });
        }
        if (contentKind === 'epub' || contentKind === 'snapshot' || contentKind === 'image') {
            return args.errorResponse(
                `Reading ${contentKind} attachments is not implemented yet.`,
                'not_implemented',
            );
        }
        const resolved = await resolveToReadableAttachment(item, args.requestKey);
        if (!resolved.resolved) {
            return args.errorResponse(resolved.error, resolved.error_code);
        }
        return null;
    }

    if (!item.isRegularItem()) return null;
    if (await hasPdfChildAttachment(item)) return null;

    const resolved = await resolveToReadableAttachment(item, args.requestKey);
    if (!resolved.resolved) {
        return args.errorResponse(resolved.error, resolved.error_code);
    }
    if (resolved.contentKind === 'text') {
        return runTextExtraction({
            item: resolved.item,
            requestKey: resolved.key,
            contentType: resolved.contentType,
            maxFileSizeMB: args.maxFileSizeMB,
            requestId: args.requestId,
            errorResponse: args.errorResponse,
        });
    }
    if (
        resolved.contentKind === 'epub'
        || resolved.contentKind === 'snapshot'
        || resolved.contentKind === 'image'
    ) {
        return args.errorResponse(
            `Reading ${resolved.contentKind} attachments is not implemented yet.`,
            'not_implemented',
        );
    }

    return args.errorResponse(args.originalError.message, args.originalError.code, args.originalError.pageCount);
}
