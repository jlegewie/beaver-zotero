import type {
    AttachmentProcessingStateRecord,
    ProcessingIndexStateRecord,
} from '../database';
import type { QueueDB } from '../backgroundQueue/jobExecutor';
import { expectedExtractionSchemaVersion } from '../documentExtraction/shared/extractionSchemaVersions';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { getFileSignature, isRemoteFilePath } from '../documentFileIdentity';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_BACKFILL } from '../ocr/constants';
import { maybeEnqueueOcrJob } from '../ocr/enqueueOcr';
import { getSystemIdleTimeMs } from '../../utils/idleService';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { logger } from '../../utils/logger';
import {
    ATTACHMENT_SCAN_BATCH_SIZE,
    BACKGROUND_EXTRACT_PRIORITY,
    BACKGROUND_UNTAG_PRIORITY,
    BACKGROUND_UPSERT_PRIORITY,
    EXPECTED_SEARCH_INDEX_VERSION,
    FULL_DIFF_SAFETY_INTERVAL_MS,
    PROCESSING_RECONCILE_INTERVAL_MS,
} from './constants';
import {
    backgroundProcessingEnabled,
    buildBackgroundExtractPayload,
    buildIndexJobPayload,
    isBackgroundProcessingLibraryEnabled,
} from './utils';

type ProcessableKind = AttachmentProcessingStateRecord['contentKind'];

interface LibraryCursor {
    maxClientDateModified: string | null;
    attachmentCount: number;
}

const IDLE_THRESHOLD_MS = 30_000;

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
    private forceWaiters: Array<() => void> = [];

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.generation += 1;
        for (const pref of [
            'extensions.zotero.beaver.backgroundProcessingEnabled',
            'extensions.zotero.beaver.backgroundProcessingLibrariesToSkip',
        ]) {
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

    notify(): void {
        if (this.stopped) return;
        if (this.running) {
            this.pendingWake = true;
            return;
        }
        this.schedule(0);
    }

    /** User-facing "Process now" entry point. */
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
                    ledgerByKey.get(item.key),
                );
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        // Heal missed delete notifications while a full enumeration is already
        // happening. Untag work is persisted before the local ledger row drops.
        for (const row of ledgerRows) {
            if (liveKeys.has(row.zoteroKey)) continue;
            if (row.upsertStatus === 'done' && row.structuredDocumentHash) {
                await this.enqueueUntag(db, row);
            }
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

        const expectedSchema = expectedExtractionSchemaVersion(kind);
        if (expectedSchema && row.extractStatus === 'done'
            && row.extractSchemaVersion !== expectedSchema) {
            await db.resetAttachmentExtraction(item.libraryID, item.key, 'extract_schema_changed');
            row = (await db.getAttachmentProcessingState(item.libraryID, item.key))!;
        }
        if (kind === 'pdf' && row.ocrStatus === 'done'
            && row.ocrEngineVersion !== OCR_ENGINE_VERSION) {
            await db.resetAttachmentOcr(item.libraryID, item.key, 'ocr_engine_changed');
            row = (await db.getAttachmentProcessingState(item.libraryID, item.key))!;
        }
        const storedIndexVersion = Number(row.upsertIndexVersion ?? 0);
        if (row.upsertStatus === 'done' && storedIndexVersion < EXPECTED_SEARCH_INDEX_VERSION) {
            await db.resetAttachmentUpsert(item.libraryID, item.key, 'index_version_changed');
            row = (await db.getAttachmentProcessingState(item.libraryID, item.key))!;
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
                    row = (await db.getAttachmentProcessingState(item.libraryID, item.key))!;
                }
            }
        }

        if (row.extractStatus === null) {
            const source = await resolveAttachmentFileSource({
                item,
                maxFileSizeMB: 0,
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
            await db.enqueueBackgroundJob({
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
            await db.enqueueBackgroundJob({
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

    private async enqueueUntag(
        db: QueueDB,
        row: AttachmentProcessingStateRecord,
    ): Promise<void> {
        await db.enqueueBackgroundJob({
            jobType: 'fulltext_untag',
            libraryId: row.libraryId,
            itemId: row.itemId,
            zoteroKey: row.zoteroKey,
            contentKind: row.contentKind,
            payloadKind: 'structured',
            priority: BACKGROUND_UNTAG_PRIORITY,
            payload: buildIndexJobPayload(row.contentKind, {
                indexAction: 'untag',
                docHash: row.structuredDocumentHash!,
            }),
            now: Date.now(),
        });
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
