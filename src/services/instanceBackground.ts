import {
    collectProcessingStatus,
    type ProcessingStatusOptions,
} from "./backgroundProcessing/statusSnapshot";
import {
    getPendingVersionNotifications,
    clearPendingVersionNotifications,
} from "../utils/versionNotificationPrefs";
import type { InstanceAccount, AccountSnapshot } from "./instanceAccount";
import { OcrExecutor } from "./backgroundQueue/ocrExecutor";
import { startFulltextUpsertLane } from "./backgroundProcessing/fulltextUpsertLane";
import { startBackgroundProcessingScopeCleanup } from "./backgroundProcessing/backgroundProcessingScopeCleanup";
import {
    startEmbeddingIndex,
    initialEmbeddingState,
    type EmbeddingIndexState,
    type PendingEmbeddingEvents,
} from "./instanceEmbeddingIndex";
import { logger } from "@beaver/agent-core/platform/logger";

/** Owns background lane registrations, scope reconciliation and UI projections. */
export class InstanceBackground {
    private unsubscribe?: () => void;
    private cleanups: (() => void | Promise<void>)[] = [];
    private key = "";
    private notificationGeneration: number | undefined;
    private force = false;
    private settling = new Set<Promise<void>>();
    private tail: Promise<void> = Promise.resolve();
    private pendingEmbeddingEvents: PendingEmbeddingEvents = {
        modifiedItemIds: new Set(),
        deletedItemIds: new Set(),
    };
    private state = { ...initialEmbeddingState };
    private listeners = new Set<(state: EmbeddingIndexState) => void>();
    private notifications = new Set<string>();
    private statusReads = new Map<
        string,
        ReturnType<typeof collectProcessingStatus>
    >();
    claimVersionNotifications(): string[] {
        const versions = getPendingVersionNotifications();
        clearPendingVersionNotifications();
        return versions;
    }
    collectStatus(
        options: ProcessingStatusOptions = {},
    ): ReturnType<typeof collectProcessingStatus> {
        const owner = Zotero.Beaver;
        const key = JSON.stringify([
            owner.account?.getGeneration(),
            owner.account?.getSnapshot().revision,
            options,
        ]);
        const existing = this.statusReads.get(key);
        if (existing) return existing;
        const generation = owner.account?.getGeneration();
        const pending = collectProcessingStatus(
            {
                hasOcrAccess: !!owner.hasOcrAccess,
                hasSearchIndexAccess: !!owner.hasSearchIndexAccess,
            },
            options,
        )
            .then((result) => {
                if (owner.account?.getGeneration() !== generation)
                    throw new Error(
                        "Account changed during background status read",
                    );
                return result;
            })
            .finally(() => {
                if (this.statusReads.get(key) === pending)
                    this.statusReads.delete(key);
            });
        this.statusReads.set(key, pending);
        return pending;
    }

    start(account: InstanceAccount): void {
        if (this.unsubscribe) return;
        this.unsubscribe = account.subscribe((snapshot) =>
            this.reconcile(snapshot),
        );
    }
    subscribe(listener: (state: EmbeddingIndexState) => void): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => {
            this.listeners.delete(listener);
        };
    }
    getSnapshot(): EmbeddingIndexState {
        return { ...this.state };
    }
    private publish(update: Partial<EmbeddingIndexState>): void {
        this.state = { ...this.state, ...update };
        Zotero.Beaver?.runtime?.publish(
            "embedding-index:status",
            this.getSnapshot(),
        );
        for (const listener of [...this.listeners]) {
            try {
                listener(this.getSnapshot());
            } catch (error) {
                logger(`Background listener: ${error}`, 2);
            }
        }
    }
    /** Synchronous session eligibility prevents duplicate presentation across renderers. */
    claimNotification(key: string): boolean {
        if (this.notifications.has(key)) return false;
        this.notifications.add(key);
        return true;
    }
    reindex(): void {
        this.force = true;
        this.key = "";
        const account = Zotero.Beaver.account;
        if (account) this.reconcile(account.getSnapshot());
    }
    private reconcile(snapshot: AccountSnapshot): void {
        if (snapshot.generation !== this.notificationGeneration) {
            this.notifications.clear();
            this.notificationGeneration = snapshot.generation;
        }
        const owner = Zotero.Beaver;
        const ids = [...(owner.searchableLibraryIds ?? [])].sort(
            (a, b) => a - b,
        );
        const profile = snapshot.data?.profile;
        const authorized =
            !!snapshot.session &&
            !!(
                profile?.has_authorized_access ||
                profile?.has_authorized_free_access
            );
        const key = JSON.stringify([
            snapshot.generation,
            owner.libraryScopeInitialized,
            ids,
            snapshot.libraries.map((l) => l.library_id).sort((a, b) => a - b),
            authorized,
            owner.hasOcrAccess,
            owner.hasSearchIndexAccess,
        ]);
        if (key === this.key) return;
        this.key = key;
        this.clearGeneration();
        this.publish({ ...initialEmbeddingState });
        if (!owner.libraryScopeInitialized || !authorized) return;
        const ocr = new OcrExecutor();
        owner.backgroundExtractor!.registerExecutor(ocr, { maxInFlight: 3 });
        this.cleanups.push(() =>
            owner.backgroundExtractor?.unregisterExecutor(ocr.jobType, ocr),
        );
        this.cleanups.push(
            startFulltextUpsertLane(ids, !!owner.hasSearchIndexAccess),
        );
        this.cleanups.push(
            startBackgroundProcessingScopeCleanup(
                snapshot.libraries,
                ids,
                !!owner.hasSearchIndexAccess,
            ),
        );
        this.cleanups.push(
            startEmbeddingIndex(
                ids,
                this.force,
                (update) => this.publish(update),
                (work) => {
                    const pending = this.tail.then(work);
                    this.tail = pending.catch((error) =>
                        logger(`Embedding work: ${error}`, 1),
                    );
                    return this.tail;
                },
                this.pendingEmbeddingEvents,
            ),
        );
        this.force = false;
    }
    private clearGeneration(): void {
        for (const cleanup of this.cleanups.splice(0)) {
            const result = cleanup();
            if (result) {
                const settled = result
                    .catch((error) => logger(`Background cleanup: ${error}`, 2))
                    .finally(() => this.settling.delete(settled));
                this.settling.add(settled);
            }
        }
    }
    async dispose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.clearGeneration();
        this.listeners.clear();
        await Promise.allSettled([
            this.tail,
            ...this.settling,
            ...this.statusReads.values(),
        ]);
        this.pendingEmbeddingEvents.modifiedItemIds.clear();
        this.pendingEmbeddingEvents.deletedItemIds.clear();
    }
}
