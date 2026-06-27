/**
 * Enqueues OCR work when a PDF is detected without a text layer.
 *
 * The enqueue path is gated by the OCR entitlement mirror and terminal failure
 * table so unsupported scans do not keep requeueing work.
 *
 * Bundle-neutral (no Supabase / React imports): reaches the queue and the
 * entitlement mirror through `Zotero.Beaver`, so it runs on both the hot
 * readability path and the esbuild background extract lane.
 */

import { logger } from '../../utils/logger';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_ON_DEMAND } from './constants';

/**
 * Fixed dedup discriminator for OCR tickets. The background queue's dedup key is
 * `UNIQUE(job_type, library_id, zotero_key, payload_kind)`; OCR has one logical
 * ticket per attachment, so it pins a single payload kind. (The re-extraction
 * itself populates both `structured` and `markdown` document-cache modes.)
 */
const OCR_JOB_PAYLOAD_KIND = 'structured' as const;

export interface MaybeEnqueueOcrArgs {
    item: Zotero.Item;
    libraryId: number;
    zoteroKey: string;
    itemId?: number | null;
    /** Page count from no-text-layer detection. */
    pageCount: number | null;
    /**
     * Queue priority. Defaults to on-demand (a scan the user just opened), which
     * runs promptly and preempts a draining backfill. The whole-library backfill
     * reconciler passes `OCR_PRIORITY_BACKFILL`, which stays just under the idle
     * gate so it makes progress while the user is active but yields to on-demand.
     */
    priority?: number;
}

/**
 * Fire-and-forget OCR enqueue. Never throws and never blocks the caller's
 * return; detection paths call this and continue.
 */
export function maybeEnqueueOcrJob(args: MaybeEnqueueOcrArgs): void {
    void enqueueOcrJob(args).catch((error) => {
        logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} failed: ${error}`, 2);
    });
}

async function enqueueOcrJob(args: MaybeEnqueueOcrArgs): Promise<void> {
    // Fast entitlement gate; the backend re-checks on `/ocr/request`.
    if (Zotero.Beaver?.hasOcrAccess !== true) return;

    const db = Zotero.Beaver?.db;
    if (!db) return;

    let fileHash: string | undefined;
    try {
        fileHash = await args.item.attachmentHash;
    } catch (error) {
        logger(`maybeEnqueueOcrJob: attachmentHash failed for ${args.libraryId}-${args.zoteroKey}: ${error}`, 2);
        return;
    }
    if (!fileHash) return;

    // Loop guard: skip scans this engine has already marked terminal.
    if (await db.isDocumentProcessingPermanentlyFailed(fileHash, 'ocr', OCR_ENGINE_VERSION)) {
        return;
    }

    await db.enqueueBackgroundJob({
        jobType: 'document_ocr',
        libraryId: args.libraryId,
        itemId: args.itemId ?? args.item.id ?? null,
        zoteroKey: args.zoteroKey,
        contentKind: 'pdf',
        payloadKind: OCR_JOB_PAYLOAD_KIND,
        priority: args.priority ?? OCR_PRIORITY_ON_DEMAND,
        payload: null,
        now: Date.now(),
    });
    Zotero.Beaver?.backgroundExtractor?.notify();
}
