import type { AttachmentChange } from './reconciler';

let moduleNotifierId: string | null = null;

/** Debounce Zotero notifications into targeted reconciliation requests. */
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
                extraData: Record<number, { libraryID?: number; key?: string }> | undefined,
            ) => {
                if (type !== 'item' || !['add', 'modify', 'delete'].includes(event)) return;
                if (Zotero.__beaverShuttingDown === true) return;
                for (const id of ids) {
                    this.pending.set(id, {
                        event: event as AttachmentChange['event'],
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
        Zotero.Beaver?.processingReconciler?.notifyAttachments(events);
    }
}
