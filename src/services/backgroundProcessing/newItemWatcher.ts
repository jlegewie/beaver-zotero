import { isBackgroundProcessingLibraryEnabled } from './utils';
import type { AttachmentChange } from './reconciler';

let moduleNotifierId: string | null = null;

/** Batch Zotero notifications into bounded-latency reconciliation requests. */
export class NewItemWatcher {
    private observerId: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending = new Map<number, AttachmentChange>();

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
                extraData: Record<number, AttachmentChange['extra']> | undefined,
            ) => {
                const downloaded = type === 'file' && event === 'download';
                if (!downloaded && (type !== 'item' || !['add', 'modify', 'delete', 'trash'].includes(event))) return;
                if (Zotero.__beaverShuttingDown === true) return;
                const accepted: AttachmentChange[] = [];
                for (const id of ids) {
                    let item: Zotero.Item | undefined;
                    try { item = Zotero.Items.get(id) || undefined; } catch { /* not loaded */ }
                    const libraryId = item?.libraryID ?? extraData?.[id]?.libraryID;
                    if (Zotero.Beaver?.libraryScopeInitialized && libraryId != null
                        && !isBackgroundProcessingLibraryEnabled(libraryId)) continue;
                    if (item?.isNote?.() || item?.isAnnotation?.()) continue;
                    // A late download must not erase the identity needed for deletion cleanup.
                    if (downloaded && this.pending.get(id)?.event === 'delete') continue;
                    const pending = this.pending.get(id);
                    const change: AttachmentChange = {
                        event: event === 'delete' ? 'delete'
                            : pending?.event === 'add' ? 'add'
                                : event === 'trash' || pending?.event === 'trash' ? 'trash'
                                    : downloaded ? 'modify' : event as AttachmentChange['event'],
                        id,
                        backfill: this.pending.get(id)?.backfill === true
                            || Zotero.Sync?.Runner?.syncInProgress === true,
                        extra: {
                            ...pending?.extra,
                            ...extraData?.[id],
                            libraryID: libraryId ?? pending?.extra?.libraryID,
                            changed: { ...pending?.extra?.changed, ...extraData?.[id]?.changed },
                        },
                    };
                    this.pending.set(id, change);
                    accepted.push(change);
                }
                if (accepted.length) {
                    Zotero.Beaver?.background?.searchReadiness?.notifyAttachments(accepted);
                    this.schedule();
                }
            },
        } as any;
        this.observerId = Zotero.Notifier.registerObserver(
            observer,
            ['item', 'file'],
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
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, 500);
    }

    private async flush(): Promise<void> {
        const events = [...this.pending.values()];
        this.pending.clear();
        Zotero.Beaver?.processingReconciler?.notifyAttachments(events);
    }
}
