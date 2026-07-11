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
     * reconciler passes `OCR_PRIORITY_BACKFILL`, which stays behind the idle
     * and master-toggle gate and yields to on-demand work.
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
    if (Zotero.Beaver?.hasOcrAccess !== true) {
        logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} skipped, OCR access is disabled`, 4);
        return;
    }

    const db = Zotero.Beaver?.db;
    if (!db) {
        logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} skipped, database unavailable`, 4);
        return;
    }

    const priority = args.priority ?? OCR_PRIORITY_ON_DEMAND;

    // Hash-free fast path: if a ticket is already queued for this attachment,
    // the work is already tracked — return before reading + MD5-hashing the
    // file. Detection re-fires on every readability/validation pass for an
    // un-OCR'd scan, so this keeps the common in-flight case off the IO path.
    // A duplicate that wants the scan sooner (on-demand over a queued backfill
    // ticket) still promotes the existing ticket's priority; we wake the
    // dispatcher only when a promotion actually happened.
    const pending = await db.promotePendingBackgroundJob(
        'document_ocr', args.libraryId, args.zoteroKey, OCR_JOB_PAYLOAD_KIND, priority,
    );
    if (pending.exists) {
        if (pending.promoted) {
            logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} promoted existing OCR job (priority=${priority})`, 3);
            Zotero.Beaver?.backgroundExtractor?.notify();
        } else {
            logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} OCR job already queued`, 4);
        }
        return;
    }

    let fileHash: string | undefined;
    try {
        fileHash = await args.item.attachmentHash;
    } catch (error) {
        logger(`maybeEnqueueOcrJob: attachmentHash failed for ${args.libraryId}-${args.zoteroKey}: ${error}`, 2);
        // Fall through to the synced-hash fallback rather than returning.
    }
    // Remote-only attachments have no local file, so attachmentHash (which hashes
    // the local file) is undefined. Fall back to the synced server MD5 — the same
    // content hash a local machine's attachmentHash produces — so a remote scan is
    // enqueued and its loop guard stays consistent with the OCR executor.
    if (!fileHash) fileHash = args.item.attachmentSyncedHash || undefined;
    // Truly hashless (rare not-yet-synced item): the backend OCR dedup needs a
    // content hash, so there is nothing actionable to enqueue.
    if (!fileHash) return;

    // Loop guard: skip scans this engine has already marked terminal.
    if (await db.isDocumentProcessingPermanentlyFailed(fileHash, 'ocr', OCR_ENGINE_VERSION)) {
        logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} skipped, terminal OCR failure already recorded`, 3);
        return;
    }

    logger(`maybeEnqueueOcrJob: ${args.libraryId}-${args.zoteroKey} enqueueing OCR job (pages=${args.pageCount ?? 'unknown'}, priority=${priority})`, 3);
    await db.enqueueBackgroundJob({
        jobType: 'document_ocr',
        libraryId: args.libraryId,
        itemId: args.itemId ?? args.item.id ?? null,
        zoteroKey: args.zoteroKey,
        contentKind: 'pdf',
        payloadKind: OCR_JOB_PAYLOAD_KIND,
        priority,
        payload: null,
        now: Date.now(),
    });
    Zotero.Beaver?.backgroundExtractor?.notify();
}
