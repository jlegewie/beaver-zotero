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
import {
    extractAndCacheDocument,
    type ResolvedAttachment,
} from '../documentExtractionCore';
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

    const toProtocolAttachment = (resolved: ResolvedAttachment | null | undefined) => {
        if (!resolved) return null;
        return {
            library_id: resolved.libraryId,
            zotero_key: resolved.zoteroKey,
        };
    };

    const errorResponse = (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages: number | null = null,
        resolved_attachment: ResolvedAttachment | null = null,
    ): WSZoteroDocumentResponse => ({
        type: 'zotero_document',
        request_id,
        resolved_attachment: toProtocolAttachment(resolved_attachment),
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
            result: result.result,
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
            result.resolvedAttachment,
        );
    }

    if (result.kind === 'external_abort') {
        // Hot-path never supplies an external abort signal; this branch
        // exists for type safety. Return a timeout-shaped response.
        return errorResponse(
            `PDF extraction interrupted`,
            'timeout',
            result.pageCount,
            result.resolvedAttachment,
        );
    }

    // cached_error / response_error — return the existing message shape.
    return errorResponse(result.message, result.code, result.pageCount, result.resolvedAttachment);
}
