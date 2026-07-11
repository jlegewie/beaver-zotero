import type { AttachmentProcessingStateRecord } from '../database';
import type { QueueDB } from '../backgroundQueue/jobExecutor';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { logger } from '../../utils/logger';
import {
    BACKGROUND_EXTRACT_PRIORITY,
    BACKGROUND_UNTAG_PRIORITY,
} from './constants';
import {
    backgroundProcessingEnabled,
    buildBackgroundExtractPayload,
    buildIndexJobPayload,
    isBackgroundProcessingLibraryEnabled,
} from './utils';

let moduleNotifierId: string | null = null;

interface PendingEvent {
    event: 'add' | 'modify' | 'delete';
    id: number;
    extra?: { libraryID?: number; key?: string };
}

/** Immediate producer for Zotero attachment add/modify/delete notifications. */
export class NewItemWatcher {
    private observerId: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending = new Map<number, PendingEvent>();

    start(): void {
        if (this.observerId) return;
        if (moduleNotifierId) {
            try { Zotero.Notifier.unregisterObserver(moduleNotifierId); } catch { /* stale */ }
            moduleNotifierId = null;
        }
        const observer = {
            notify: (
                event: string,
                type: string,
                ids: number[],
                extraData: Record<number, { libraryID?: number; key?: string }> | undefined,
            ) => {
                if (type !== 'item' || !['add', 'modify', 'delete'].includes(event)) return;
                if (Zotero.__beaverShuttingDown === true) return;
                for (const id of ids) {
                    this.pending.set(id, {
                        event: event as PendingEvent['event'],
                        id,
                        extra: extraData?.[id],
                    });
                }
                this.schedule();
            },
        } as any;
        this.observerId = Zotero.Notifier.registerObserver(
            observer,
            ['item'],
            'beaver-background-processing',
        );
        moduleNotifierId = this.observerId;
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.pending.clear();
        if (this.observerId) {
            try { Zotero.Notifier.unregisterObserver(this.observerId); } catch { /* best effort */ }
            if (moduleNotifierId === this.observerId) moduleNotifierId = null;
            this.observerId = null;
        }
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, 500);
    }

    private async flush(): Promise<void> {
        const events = [...this.pending.values()];
        this.pending.clear();
        if (!backgroundProcessingEnabled() || Zotero.Beaver?.libraryScopeInitialized !== true) {
            return;
        }
        const db = Zotero.Beaver?.db;
        if (!db) return;
        for (const event of events) {
            try {
                if (event.event === 'delete') {
                    await this.handleDelete(db, event.extra);
                } else {
                    await this.handleUpsert(db, event);
                }
            } catch (error) {
                logger(`NewItemWatcher: ${event.event} ${event.id} failed: ${error}`, 2);
            }
        }
        Zotero.Beaver?.processingReconciler?.notify();
        Zotero.Beaver?.backgroundExtractor?.notify();
    }

    private async handleUpsert(db: QueueDB, event: PendingEvent): Promise<void> {
        // Resolve the cheap primary identity first, then enforce the exclusion
        // boundary before loading attachment data.
        const identity: Array<{ libraryId: number; key: string }> = [];
        await Zotero.DB.queryAsync(
            `SELECT libraryID, key FROM items WHERE itemID = ? LIMIT 1`,
            [event.id],
            {
                onRow: (row: any) => identity.push({
                    libraryId: row.getResultByIndex(0),
                    key: row.getResultByIndex(1),
                }),
            },
        );
        const ref = identity[0];
        if (!ref || !isBackgroundProcessingLibraryEnabled(ref.libraryId)) return;
        const item = await Zotero.Items.getAsync(event.id);
        if (!item) return;
        if (safeIsInTrash(item) === true) {
            await this.removeLocalState(db, ref.libraryId, ref.key);
            return;
        }
        const kind = getReadableContentKind(item);
        if (kind !== 'pdf' && kind !== 'epub' && kind !== 'snapshot') {
            await this.removeLocalState(db, ref.libraryId, ref.key);
            return;
        }
        const existing = await db.getAttachmentProcessingState(ref.libraryId, ref.key);
        await db.ensureAttachmentProcessingState({
            libraryId: ref.libraryId,
            zoteroKey: ref.key,
            itemId: item.id,
            contentKind: kind,
        });
        if (event.event === 'modify' && existing) {
            await db.resetAttachmentExtraction(ref.libraryId, ref.key, 'item_modified');
            await Zotero.Beaver?.documentCache?.invalidate(ref.libraryId, ref.key);
        }
        const source = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 0,
            localSizeStrategy: 'stat',
        });
        if (source.kind === 'error') {
            await db.markAttachmentExtractFailure({
                libraryId: ref.libraryId,
                zoteroKey: ref.key,
                status: 'skipped',
                error: source.code,
            });
            return;
        }
        await db.enqueueBackgroundJob({
            jobType: 'document_extract',
            libraryId: ref.libraryId,
            itemId: item.id,
            zoteroKey: ref.key,
            contentKind: kind,
            payloadKind: 'structured',
            priority: BACKGROUND_EXTRACT_PRIORITY,
            payload: buildBackgroundExtractPayload(kind),
            now: Date.now(),
        });
    }

    private async handleDelete(
        db: QueueDB,
        extra: PendingEvent['extra'],
    ): Promise<void> {
        const libraryId = extra?.libraryID;
        const key = extra?.key;
        if (!libraryId || !key || !isBackgroundProcessingLibraryEnabled(libraryId)) return;
        await this.removeLocalState(db, libraryId, key);
    }

    private async removeLocalState(
        db: QueueDB,
        libraryId: number,
        zoteroKey: string,
    ): Promise<void> {
        const row = await db.getAttachmentProcessingState(libraryId, zoteroKey);
        if (row?.upsertStatus === 'done' && row.structuredDocumentHash) {
            await this.enqueueUntag(db, row);
        }
        await db.deleteAttachmentProcessingState(libraryId, zoteroKey);
        await Zotero.Beaver?.documentCache?.invalidate(libraryId, zoteroKey);
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
}
