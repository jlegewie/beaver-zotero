import { logger } from '@beaver/agent-core/platform/logger';
import type { DocumentCacheExtractionMode } from '../database';
import { MAX_PDF_TIMEOUT_SECONDS } from './timeout';
import { isLibrarySearchable } from './utils';

/**
 * Queue a background extraction of a PDF whose foreground extraction timed
 * out, so the document cache holds it for the next request. The background
 * worker gets the longer `MAX_PDF_TIMEOUT_SECONDS` budget.
 *
 * Exclusions can change while a foreground extraction is in flight, so the
 * live boundary is rechecked here: an excluded library never reaches the
 * queue. Failures are logged, never thrown.
 */
export async function enqueuePdfExtractionRetry(args: {
    libraryId: number;
    zoteroKey: string;
    mode: DocumentCacheExtractionMode;
    maxPages: number | null;
    logContext: string;
}): Promise<void> {
    try {
        if (!isLibrarySearchable(args.libraryId)) return;
        await Zotero.Beaver?.db?.enqueueBackgroundJob({
            jobType: 'document_extract',
            libraryId: args.libraryId,
            zoteroKey: args.zoteroKey,
            contentKind: 'pdf',
            payloadKind: args.mode,
            priority: 50,
            payload: {
                content_kind: 'pdf',
                maxPages: args.maxPages,
                timeoutSeconds: MAX_PDF_TIMEOUT_SECONDS,
            },
            now: Date.now(),
        });
        Zotero.Beaver?.backgroundExtractor?.notify();
    } catch (e) {
        logger(`${args.logContext}: background enqueue failed: ${e}`, 1);
    }
}
