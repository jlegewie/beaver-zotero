import type {
    AttachmentProcessingStateRecord,
    BackgroundJobInput,
    ProcessingIndexStateRecord,
} from '../database';
import type { QueueDB } from '../backgroundQueue/jobExecutor';
import { expectedExtractionSchemaVersion } from '../documentExtraction/shared/extractionSchemaVersions';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { getFileSignature, isRemoteFilePath } from '../documentFileIdentity';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_BACKFILL } from '../ocr/constants';
import type { AttachmentRef } from './issues';
import { enqueueOcrJob, maybeEnqueueOcrJob } from '../ocr/enqueueOcr';
import { getSystemIdleTimeMs } from '../../utils/idleService';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    ATTACHMENT_SCAN_BATCH_SIZE,
    BACKGROUND_EXTRACT_PRIORITY,
    BACKGROUND_UPSERT_PRIORITY,
    EXPECTED_SEARCH_INDEX_VERSION,
    FULL_DIFF_SAFETY_INTERVAL_MS,
    PROCESSING_RECONCILE_INTERVAL_MS,
} from './constants';
import {
    backgroundProcessingEnabled,
    buildBackgroundExtractPayload,
    buildIndexJobPayload,
    buildUntagJobInput,
    isBackgroundProcessingLibraryEnabled,
} from './utils';

type ProcessableKind = AttachmentProcessingStateRecord['contentKind'];

interface LibraryCursor {
    maxClientDateModified: string | null;
    attachmentCount: number;
}

const IDLE_THRESHOLD_MS = 30_000;

/**
 * Terminal reasons that say "the bytes were not reachable", not "these bytes
 * are unusable". Every one of them can stop being true without the attachment
 * itself changing: metadata syncs ahead of the upload backing it, a WebDAV
 * share or its configuration comes back, a user downloads the file later.
 */
const RECOVERABLE_AVAILABILITY_ERRORS = [
    'file_missing',
    'download_failed',
    'read_failed',
];

/**
 * True when a row's terminal state came from the file being unreachable.
 *
 * Matches on prefix because the same cause reaches the ledger in two shapes: a
 * bare code when an executor retires the job itself, and `"<code>: <message>"`
 * when the queue dead-letters it.
 */
function hasRecoverableAvailabilityFailure(
    row: AttachmentProcessingStateRecord,
): boolean {
    const terminal = row.extractStatus === 'skipped'
        || row.extractStatus === 'failed'
        || row.ocrStatus === 'failed';
    if (!terminal || !row.lastError) return false;
    return RECOVERABLE_AVAILABILITY_ERRORS.some((code) =>
        row.lastError === code || row.lastError!.startsWith(`${code}:`)
        // The OCR lane wraps its own load failures before recording them.
        || row.lastError!.includes(`: ${code}`));
}


/** Whole-library producer. Expensive work remains in the dispatcher lanes. */
export class ReconcilerService {
    private stopped = true;
    private running = false;
    private activeForce = false;
    private pendingWake = false;
    private pendingForce = false;
    private scheduledForce = false;
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private prefObservers: symbol[] = [];
    private idleWaiters: Array<() => void> = [];
    private forceWaiters: Array<() => void> = [];

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.generation += 1;
        for (const pref of ['extensions.zotero.beaver.backgroundProcessingEnabled']) {
            try {
                this.prefObservers.push(Zotero.Prefs.registerObserver(
                    pref,
                    () => this.notify(),
                    true,
                ));
            } catch (error) {
                logger(`ReconcilerService: failed to observe ${pref}: ${error}`, 2);
            }
        }
        this.schedule(1_000);
    }

    stop(): void {
        this.stopped = true;
        this.generation += 1;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.pendingForce = false;
        this.scheduledForce = false;
        for (const resolve of this.forceWaiters.splice(0)) resolve();
        for (const observer of this.prefObservers) {
            try { Zotero.Prefs.unregisterObserver(observer); } catch { /* best effort */ }
        }
        this.prefObservers = [];
    }

    /** Stop producing work and await the current pass before storage maintenance. */
    async suspendForMaintenance(): Promise<() => void> {
        const wasStarted = !this.stopped;
        this.stop();
        if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
        return () => {
            if (wasStarted && !Zotero.__beaverShuttingDown) this.start();
        };
    }

    notify(): void {
        if (this.stopped) return;
        if (this.running) {
            this.pendingWake = true;
            return;
        }
        this.schedule(0);
    }

    /** Forced full pass, awaited: used by the dev endpoint and live tests. */
    async reconcileNow(): Promise<void> {
        if (this.running) {
            const completed = new Promise<void>((resolve) => {
                this.forceWaiters.push(resolve);
            });
            await this.run(true);
            await completed;
        } else {
            await this.run(true);
        }
        Zotero.Beaver?.backgroundExtractor?.notify();
    }

    /**
     * User-initiated retry of attachments listed under "could not read".
     *
     * Each attachment's failed stage is put back, its dead-lettered jobs and
     * per-hash failure records are dropped, and the next job is enqueued
     * before the drain bypass is requested, so the work runs without waiting
     * for Zotero to go idle:
     *
     * - A failed or skipped extraction (and an OCR stage that failed because
     *   the file was unreachable) restarts from extraction. The attachment's
     *   document-cache entry is invalidated first: the cache remembers
     *   terminal verdicts such as `invalid_pdf`, and a retry that merely
     *   re-read that verdict would skip the file again without touching it.
     *   A still-missing file fails source resolution right here and reappears
     *   in the issue list.
     * - A failed OCR stage on a readable extraction goes straight back to
     *   `needed` and is ticketed here, awaited, rather than through a fresh
     *   extraction whose cached "no text layer" verdict would leave the OCR
     *   continuation to the next periodic reconcile. That shortcut is only
     *   taken while the cached detection metadata the OCR executor reads its
     *   page count from is still present and current; a cleared cache or a
     *   replaced file restarts from extraction so the metadata is rewritten.
     * - A failed index upload re-enqueues only the upsert.
     *
     * Excluded libraries and attachments that no longer exist are skipped.
     * Returns the number of attachments reset.
     */
    async retryAttachments(refs: AttachmentRef[]): Promise<number> {
        const db = Zotero.Beaver?.db;
        if (!db || !backgroundProcessingEnabled()) return 0;
        const jobs: BackgroundJobInput[] = [];
        let retried = 0;
        for (const ref of refs) {
            if (!isBackgroundProcessingLibraryEnabled(ref.libraryId)) continue;
            const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryId, ref.zoteroKey);
            if (!item || safeIsInTrash(item) === true) continue;
            const kind = getReadableContentKind(item);
            if (kind !== 'pdf' && kind !== 'epub' && kind !== 'snapshot') continue;
            let row = await db.getAttachmentProcessingState(ref.libraryId, ref.zoteroKey);
            if (!row) continue;

            const extractFailed = row.extractStatus === 'failed' || row.extractStatus === 'skipped';
            const ocrFailed = row.ocrStatus === 'failed';
            const restartExtraction = extractFailed
                || (ocrFailed && (
                    hasRecoverableAvailabilityFailure(row)
                    || !(await this.hasOcrDetectionMetadata(item))
                ));
            if (ocrFailed && row.fileHash) {
                await db.clearDocumentProcessingFailure(row.fileHash, 'ocr', OCR_ENGINE_VERSION);
            }
            if (restartExtraction) {
                await Zotero.Beaver?.documentCache?.invalidate(ref.libraryId, ref.zoteroKey);
                await db.resetAttachmentExtraction(ref.libraryId, ref.zoteroKey, 'user_retry');
                if (ocrFailed) await db.resetAttachmentOcr(ref.libraryId, ref.zoteroKey, 'user_retry');
                row = {
                    ...row,
                    extractStatus: null,
                    ocrStatus: ocrFailed ? null : row.ocrStatus,
                    lastError: 'user_retry',
                };
            } else if (ocrFailed) {
                await db.requeueAttachmentOcr(ref.libraryId, ref.zoteroKey, 'user_retry');
                await db.deleteBackgroundDeadLetters(ref.libraryId, ref.zoteroKey);
                await enqueueOcrJob({
                    item,
                    libraryId: ref.libraryId,
                    zoteroKey: ref.zoteroKey,
                    itemId: item.id,
                    pageCount: null,
                    priority: OCR_PRIORITY_BACKFILL,
                });
                retried += 1;
                continue;
            } else if (row.upsertStatus === 'failed') {
                await db.resetAttachmentUpsert(ref.libraryId, ref.zoteroKey, 'user_retry');
                if (row.structuredDocumentHash) {
                    await db.clearDocumentProcessingFailure(row.structuredDocumentHash, 'fulltext_upsert');
                }
                row = { ...row, upsertStatus: null, lastError: 'user_retry' };
            }
            // A dead letter can outlive a non-terminal ledger row (the job died
            // before an executor recorded a verdict); dropping it is what lets
            // the fresh job be counted as progress rather than as the old failure.
            await db.deleteBackgroundDeadLetters(ref.libraryId, ref.zoteroKey);
            await this.reconcileAttachment(db, item, kind, false, jobs, row);
            retried += 1;
        }
        if (jobs.length > 0) await db.enqueueBackgroundJobs(jobs);
        if (retried > 0) {
            Zotero.Beaver?.backgroundExtractor?.requestImmediateDrain();
            Zotero.Beaver?.backgroundExtractor?.notify();
        }
        return retried;
    }

    /**
     * True when the document cache still holds current "no text layer"
     * metadata with a page count for this attachment. The OCR executor resolves
     * its job from that row and retires with `no_page_count` without it, so an
     * OCR retry may only skip re-extraction while it is present.
     */
    private async hasOcrDetectionMetadata(item: Zotero.Item): Promise<boolean> {
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) return false;
        const source = await resolveAttachmentFileSource({ item, localSizeStrategy: 'stat' });
        if (source.kind === 'error') return false;
        const meta = await cache
            .getMetadata({ libraryId: item.libraryID, zoteroKey: item.key }, source.source.filePath)
            .catch(() => null);
        return (meta?.pageCount ?? 0) >= 1;
    }

    private schedule(delayMs: number, force = false): void {
        if (this.stopped) return;
        this.scheduledForce = this.scheduledForce || force;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            const scheduledForce = this.scheduledForce;
            this.scheduledForce = false;
            void this.run(scheduledForce);
        }, delayMs);
        (this.timer as any)?.unref?.();
    }

    private async run(force: boolean): Promise<void> {
        if (this.stopped || this.running) {
            if (this.running) {
                this.pendingWake = true;
                this.pendingForce = this.pendingForce || (force && !this.activeForce);
            }
            return;
        }
        this.running = true;
        this.activeForce = force;
        const generation = this.generation;
        try {
            if (
                !backgroundProcessingEnabled()
                || Zotero.Beaver?.libraryScopeInitialized !== true
            ) {
                return;
            }
            const db = Zotero.Beaver?.db;
            if (!db) return;

            const libraries = Zotero.Libraries.getAll().filter((library) =>
                (library.libraryType === 'user' || library.libraryType === 'group')
                && isBackgroundProcessingLibraryEnabled(library.libraryID));
            for (const library of libraries) {
                if (this.cancelled(generation)) return;
                await this.reconcileLibrary(db, library.libraryID, force, generation);
            }
            Zotero.Beaver?.backgroundExtractor?.notify();
        } catch (error) {
            logger(`ReconcilerService: reconcile failed: ${error}`, 1);
        } finally {
            this.running = false;
            for (const resolve of this.idleWaiters.splice(0)) resolve();
            this.activeForce = false;
            if (force) {
                for (const resolve of this.forceWaiters.splice(0)) resolve();
            }
            if (!this.stopped) {
                const wake = this.pendingWake;
                const forceNext = this.pendingForce;
                this.pendingWake = false;
                this.pendingForce = false;
                this.schedule(wake ? 0 : PROCESSING_RECONCILE_INTERVAL_MS, forceNext);
            }
        }
    }

    private cancelled(generation: number): boolean {
        return this.stopped
            || generation !== this.generation
            || Zotero.__beaverShuttingDown === true;
    }

    private async reconcileLibrary(
        db: QueueDB,
        libraryId: number,
        force: boolean,
        generation: number,
    ): Promise<void> {
        const cursor = await this.readLibraryCursor(libraryId);
        const previous = await db.getProcessingIndexState(libraryId);
        const safetyDiffDue = !!previous
            && Date.now() - previous.lastScanTimestamp >= FULL_DIFF_SAFETY_INTERVAL_MS;
        const fullDiffDue = force || !previous || safetyDiffDue;
        const cursorChanged = !previous
            || previous.maxClientDateModified !== cursor.maxClientDateModified
            || previous.attachmentCount !== cursor.attachmentCount
            || previous.ledgerRowCount !== (await db.getAttachmentProcessingAggregates(libraryId)).total;
        if (!cursorChanged && !fullDiffDue) return;

        // Weekly file stats are deliberately idle-only. An explicit Process Now
        // is user initiated and may run the safety diff immediately. Do not
        // advance the weekly timestamp when an active user prevented the stat
        // sweep, or external byte changes could be postponed indefinitely.
        const idleForStats = force || getSystemIdleTimeMs() >= IDLE_THRESHOLD_MS;
        if (!cursorChanged && safetyDiffDue && !idleForStats) return;
        const statFiles = force || (safetyDiffDue && idleForStats);
        const items = await this.listProcessableAttachments(libraryId);
        const ledgerRows = await db.getAttachmentProcessingStatesByLibrary(libraryId);
        const ledgerByKey = new Map(ledgerRows.map((row) => [row.zoteroKey, row]));
        const liveKeys = new Set<string>();
        for (let start = 0; start < items.length; start += ATTACHMENT_SCAN_BATCH_SIZE) {
            const batch = items.slice(start, start + ATTACHMENT_SCAN_BATCH_SIZE);
            const jobs: BackgroundJobInput[] = [];
            for (const item of batch) {
                if (this.cancelled(generation)) return;
                const kind = getReadableContentKind(item);
                if (kind !== 'pdf' && kind !== 'epub' && kind !== 'snapshot') continue;
                liveKeys.add(item.key);
                await this.reconcileAttachment(
                    db,
                    item,
                    kind,
                    statFiles,
                    jobs,
                    ledgerByKey.get(item.key),
                );
            }
            await db.enqueueBackgroundJobs(jobs);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        // Heal missed delete notifications while a full enumeration is already
        // happening. Untag work is persisted before the local ledger rows drop.
        const staleRows = ledgerRows.filter((row) => !liveKeys.has(row.zoteroKey));
        await db.enqueueBackgroundJobs(staleRows
            .filter((row) => row.upsertStatus === 'done' && row.structuredDocumentHash)
            .map((row) => buildUntagJobInput(row, Date.now())));
        for (const row of staleRows) {
            await db.deleteAttachmentProcessingState(libraryId, row.zoteroKey);
        }

        if (!isBackgroundProcessingLibraryEnabled(libraryId)) return;
        const ledgerRowCount = (await db.getAttachmentProcessingAggregates(libraryId)).total;
        const state: ProcessingIndexStateRecord = {
            libraryId,
            maxClientDateModified: cursor.maxClientDateModified,
            attachmentCount: cursor.attachmentCount,
            ledgerRowCount,
            lastScanTimestamp: safetyDiffDue && !statFiles && previous
                ? previous.lastScanTimestamp
                : Date.now(),
        };
        await db.upsertProcessingIndexState(state);
    }

    private async reconcileAttachment(
        db: QueueDB,
        item: Zotero.Item,
        kind: ProcessableKind,
        statFile: boolean,
        jobs: BackgroundJobInput[],
        existing?: AttachmentProcessingStateRecord,
    ): Promise<void> {
        if (!isBackgroundProcessingLibraryEnabled(item.libraryID)) return;
        let row = existing;
        if (!row || row.itemId !== item.id || row.contentKind !== kind) {
            row = await db.ensureAttachmentProcessingState({
                libraryId: item.libraryID,
                zoteroKey: item.key,
                itemId: item.id,
                contentKind: kind,
            });
        }

        // The reconciler owns these resets, so the row is patched in memory
        // instead of being refetched after each UPDATE.
        const expectedSchema = expectedExtractionSchemaVersion(kind);
        if (expectedSchema && row.extractStatus === 'done'
            && row.extractSchemaVersion !== expectedSchema) {
            await db.resetAttachmentExtraction(item.libraryID, item.key, 'extract_schema_changed');
            row = { ...row, extractStatus: null, lastError: 'extract_schema_changed' };
        }
        if (kind === 'pdf' && row.ocrStatus === 'done'
            && row.ocrEngineVersion !== OCR_ENGINE_VERSION) {
            await db.resetAttachmentOcr(item.libraryID, item.key, 'ocr_engine_changed');
            row = { ...row, ocrStatus: null, lastError: 'ocr_engine_changed' };
        }
        const storedIndexVersion = Number(row.upsertIndexVersion ?? 0);
        if (row.upsertStatus === 'done' && storedIndexVersion < EXPECTED_SEARCH_INDEX_VERSION) {
            await db.resetAttachmentUpsert(item.libraryID, item.key, 'index_version_changed');
            row = { ...row, upsertStatus: null, lastError: 'index_version_changed' };
        }

        if (statFile && row.fileMtimeMs != null && row.fileSizeBytes != null) {
            const rawPath = await item.getFilePathAsync().catch(() => false);
            if (typeof rawPath === 'string' && rawPath && !isRemoteFilePath(rawPath)) {
                const signature = await getFileSignature(rawPath).catch(() => null);
                if (signature && (
                    signature.mtime_ms !== row.fileMtimeMs
                    || signature.size_bytes !== row.fileSizeBytes
                )) {
                    await db.resetAttachmentExtraction(item.libraryID, item.key, 'file_signature_changed');
                    row = { ...row, extractStatus: null, lastError: 'file_signature_changed' };
                }
            }
        }

        // Nothing else clears an availability failure. The signature check above
        // needs a stored mtime/size that an attachment we never read does not
        // have, and the branches below return early for any status that is not
        // `done` — so without this a file that shows up later stays unprocessed
        // forever. Retried on the passes that are already deep (an explicit
        // "Process now", or the weekly safety diff), which bounds the cost: a
        // still-missing file simply fails again and waits for the next one,
        // rather than re-downloading every five minutes.
        if (statFile && hasRecoverableAvailabilityFailure(row)) {
            await db.resetAttachmentExtraction(item.libraryID, item.key, 'availability_recheck');
            if (row.ocrStatus === 'failed') {
                // The OCR verdict is derived from extraction, so let the
                // re-extract restate it instead of guessing here.
                await db.resetAttachmentOcr(item.libraryID, item.key, 'availability_recheck');
            }
            row = {
                ...row,
                extractStatus: null,
                ocrStatus: row.ocrStatus === 'failed' ? null : row.ocrStatus,
                lastError: 'availability_recheck',
            };
        }

        if (row.extractStatus === null) {
            const source = await resolveAttachmentFileSource({
                item,
                localSizeStrategy: 'stat',
            });
            if (source.kind === 'error') {
                await db.markAttachmentExtractFailure({
                    libraryId: item.libraryID,
                    zoteroKey: item.key,
                    status: 'skipped',
                    error: source.code,
                });
                return;
            }
            jobs.push({
                jobType: 'document_extract',
                libraryId: item.libraryID,
                itemId: item.id,
                zoteroKey: item.key,
                contentKind: kind,
                payloadKind: 'structured',
                priority: BACKGROUND_EXTRACT_PRIORITY,
                payload: buildBackgroundExtractPayload(kind),
                now: Date.now(),
            });
            return;
        }
        if (row.extractStatus !== 'done') return;

        if (
            kind === 'pdf'
            && row.ocrStatus === 'needed'
            && Zotero.Beaver?.hasOcrAccess === true
        ) {
            maybeEnqueueOcrJob({
                item,
                libraryId: item.libraryID,
                zoteroKey: item.key,
                itemId: item.id,
                pageCount: null,
                priority: OCR_PRIORITY_BACKFILL,
            });
            return;
        }

        const ocrReady = kind !== 'pdf'
            || row.ocrStatus === 'na'
            || row.ocrStatus === 'done';
        if (
            Zotero.Beaver?.hasSearchIndexAccess === true
            && ocrReady
            && row.structuredDocumentHash
            && row.upsertStatus === null
        ) {
            jobs.push({
                jobType: 'fulltext_upsert',
                libraryId: item.libraryID,
                itemId: item.id,
                zoteroKey: item.key,
                contentKind: kind,
                payloadKind: 'structured',
                priority: BACKGROUND_UPSERT_PRIORITY,
                payload: buildIndexJobPayload(kind, {
                    docHash: row.structuredDocumentHash,
                }),
                now: Date.now(),
            });
        }
    }

    private async readLibraryCursor(libraryId: number): Promise<LibraryCursor> {
        const rows: LibraryCursor[] = [];
        await Zotero.DB.queryAsync(
            `SELECT
                MAX(I.clientDateModified),
                SUM(CASE WHEN IA.itemID IS NOT NULL
                    AND IA.linkMode != ?
                    AND (LOWER(COALESCE(IA.contentType, '')) IN (
                        'application/pdf', 'application/epub+zip',
                        'text/html', 'application/xhtml+xml'
                    )) THEN 1 ELSE 0 END)
             FROM items I
             LEFT JOIN itemAttachments IA USING (itemID)
             WHERE I.libraryID = ?
               AND I.itemID NOT IN (SELECT itemID FROM deletedItems)`,
            [Zotero.Attachments.LINK_MODE_LINKED_URL, libraryId],
            {
                onRow: (row: any) => rows.push({
                    maxClientDateModified: row.getResultByIndex(0) ?? null,
                    attachmentCount: Number(row.getResultByIndex(1)) || 0,
                }),
            },
        );
        return rows[0] ?? { maxClientDateModified: null, attachmentCount: 0 };
    }

    private async listProcessableAttachments(libraryId: number): Promise<Zotero.Item[]> {
        const ids: number[] = [];
        await Zotero.DB.queryAsync(
            `SELECT I.itemID
             FROM items I
             JOIN itemAttachments IA USING (itemID)
             WHERE I.libraryID = ?
               AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
               AND IA.linkMode != ?
               AND LOWER(COALESCE(IA.contentType, '')) IN (
                    'application/pdf', 'application/epub+zip',
                    'text/html', 'application/xhtml+xml'
               )
             ORDER BY I.itemID`,
            [libraryId, Zotero.Attachments.LINK_MODE_LINKED_URL],
            { onRow: (row: any) => ids.push(row.getResultByIndex(0)) },
        );
        if (ids.length === 0) return [];
        const items = (await Zotero.Items.getAsync(ids)).filter(
            (item): item is Zotero.Item => !!item && safeIsInTrash(item) !== true,
        );
        return items;
    }
}
