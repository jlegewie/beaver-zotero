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
    private stopEmbedding?: () => void;
    private embeddingLibraryIds?: number[];
    private pendingReindex = false;
    private settling = new Set<Promise<void>>();
    private tail: Promise<void> = Promise.resolve();
    private pendingEmbeddingEvents: PendingEmbeddingEvents = {
        modifiedItemIds: new Set(),
        deletedItemIds: new Set(),
    };
    private state = { ...initialEmbeddingState };
    private notifications = new Map<string, number>();
    private statusReads = new Map<
        string,
        ReturnType<InstanceBackground["collectStatus"]>
    >();
    claimVersionNotifications(): string[] {
        const versions = getPendingVersionNotifications();
        clearPendingVersionNotifications();
        return versions;
    }
    collectStatus(
        options: ProcessingStatusOptions = {},
    ): Promise<Awaited<ReturnType<typeof collectProcessingStatus>> | null> {
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
            .then(
                (result) =>
                    owner.account?.getGeneration() === generation
                        ? result
                        : null,
                (error) => {
                    if (owner.account?.getGeneration() !== generation)
                        return null;
                    throw error;
                },
            )
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
    getSnapshot(): EmbeddingIndexState {
        return { ...this.state };
    }
    private publish(update: Partial<EmbeddingIndexState>): void {
        this.state = { ...this.state, ...update };
        Zotero.Beaver?.runtime?.publish(
            "embedding-index:status",
            this.getSnapshot(),
        );
    }
    /** Synchronous session eligibility prevents duplicate presentation across renderers. */
    claimNotification(key: string, intervalMs = Infinity): boolean {
        const now = Date.now();
        const lastClaim = this.notifications.get(key);
        if (lastClaim !== undefined && now - lastClaim < intervalMs)
            return false;
        this.notifications.set(key, now);
        return true;
    }
    reindex(): void {
        this.pendingReindex = true;
        if (this.embeddingLibraryIds)
            this.restartEmbedding(this.embeddingLibraryIds, true);
    }
    private restartEmbedding(ids: number[], force = false): void {
        this.stopEmbedding?.();
        this.embeddingLibraryIds = ids;
        this.publish({ ...initialEmbeddingState });
        this.stopEmbedding = startEmbeddingIndex(
            ids,
            force,
            (update) => this.publish(update),
            (work) => {
                const pending = this.tail.then(work);
                this.tail = pending.catch((error) =>
                    logger(`Embedding work: ${error}`, 1),
                );
                return this.tail;
            },
            this.pendingEmbeddingEvents,
        );
        this.pendingReindex = false;
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
        if (!owner.libraryScopeInitialized || !authorized) {
            this.publish({ ...initialEmbeddingState });
            return;
        }
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
        this.restartEmbedding(ids, this.pendingReindex);
    }
    private clearGeneration(): void {
        this.stopEmbedding?.();
        this.stopEmbedding = undefined;
        this.embeddingLibraryIds = undefined;
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
        this.pendingReindex = false;
        await Promise.allSettled([
            this.tail,
            ...this.settling,
            ...this.statusReads.values(),
        ]);
        this.pendingEmbeddingEvents.modifiedItemIds.clear();
        this.pendingEmbeddingEvents.deletedItemIds.clear();
    }
}
